"""Build the model (portfolios, frontier, bootstrap, backtest) and write site/data/*.json."""
import json
import logging
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import backtest as bt
from . import optimize as op

log = logging.getLogger(__name__)
PORTFOLIOS = ["max_sharpe", "min_variance", "risk_parity", "hrp"]
LABELS = {"max_sharpe": "Maks Sharpe", "min_variance": "Minimum varians", "risk_parity": "Risikoparitet",
          "hrp": "HRP", "reference": "Referanse", "current": "Nåværende"}

WEIGHTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS weights_history(built_at TEXT, portfolio TEXT, isin TEXT, weight REAL);
"""


def _r(x, nd=6):
    if x is None:
        return None
    if isinstance(x, (np.floating, float)):
        return None if not math.isfinite(float(x)) else round(float(x), nd)
    if isinstance(x, (np.integer,)):
        return int(x)
    return x


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_r), encoding="utf-8")


def load_meta(conn):
    """Universe rows + Nordnet slug for links."""
    u = pd.read_sql_query("SELECT * FROM universe", conn).set_index("isin")
    slugs = {}
    for iid, raw in conn.execute(
            """SELECT s.instrument_id, s.raw_json FROM etf_snapshot s
               WHERE s.run_id = (SELECT MAX(run_id) FROM etf_snapshot)"""):
        try:
            slugs[iid] = json.loads(raw).get("nnx_info", {}).get("display_slug")
        except (TypeError, ValueError):
            pass
    u["nordnet_url"] = u["instrument_id"].map(
        lambda i: f"https://www.nordnet.no/etf/liste/{slugs[i]}" if slugs.get(i) else None)
    extra = pd.read_sql_query(
        """SELECT m.isin, m.currency, m.issuer_name, m.dividend_policy, m.ask_eligible, m.risk, m.rating,
                  s.spread_pct FROM etf_master m LEFT JOIN etf_snapshot s ON s.instrument_id = m.instrument_id
                  AND s.run_id = (SELECT MAX(run_id) FROM etf_snapshot)""", conn)
    extra = extra.drop_duplicates("isin").set_index("isin")
    tick = pd.read_sql_query("SELECT isin, yahoo_ticker FROM ticker_map WHERE chosen=1 AND ok=1", conn)
    u = u.join(extra[["currency", "issuer_name", "dividend_policy", "spread_pct", "risk", "rating"]], how="left")
    u = u.join(tick.set_index("isin"), how="left")
    return u


def asset_metrics(prices, rf, periods=52):
    """CAGR, volatility, Sharpe, max drawdown per ISIN over its full (cleaned) history."""
    rows = {}
    w = prices.resample("W-FRI").last()
    for c in prices.columns:
        s = prices[c].dropna()
        if len(s) < 20:
            continue
        years = (s.index[-1] - s.index[0]).days / 365.25
        cagr = (s.iloc[-1] / s.iloc[0]) ** (1 / years) - 1 if years > 0.5 else None
        r = w[c].dropna().pct_change().dropna()
        vol = r.std() * math.sqrt(periods) if len(r) > 10 else None
        dd = float((s / s.cummax() - 1).min())
        rows[c] = {"cagr": cagr, "vol": vol, "sharpe": (cagr - rf) / vol if cagr is not None and vol else None,
                   "max_drawdown": dd, "years": years}
    return pd.DataFrame(rows).T


def build_model(conn, prices, cfg, account):
    """Everything the site needs, as plain dicts."""
    oc = cfg
    rf, ref = oc["risk_free_rate"], oc["reference_isin"]
    meta = load_meta(conn)
    reps = list(meta.index[meta["is_representative"] == 1])
    R = op.weekly_returns(prices, oc.get("smooth_days", 5))
    cols = sorted(set(reps) | {ref})
    r_all = op.window(R.reindex(columns=cols), weeks=oc["lookback_weeks"])
    if ref not in r_all.columns:
        raise RuntimeError(f"Referansen {ref} mangler data i vinduet")
    S_all = op.ledoit_wolf(r_all)
    mu_all, beta_all = op.expected_returns(r_all, ref, rf, oc["market_risk_premium"], oc["history_weight"], S_all)
    invest = [c for c in r_all.columns if c in set(reps)]          # reference only if it is a representative
    r = r_all[invest]
    S, mu = S_all.loc[invest, invest], mu_all[invest]
    m, Sv = mu.to_numpy(), S.to_numpy()
    con = op.Constraints.build(invest, meta, oc)
    log.info("Optimerer over %d representanter (%d uker)", len(invest), len(r))

    res = bt.compute_portfolios(m, Sv, con, rf, oc, r, PORTFOLIOS,
                                cand_points=oc.get("candidate_frontier_points", 15),
                                frontier_pts=oc.get("frontier_points", 50))
    weights = {k: pd.Series(w, index=invest) for k, w in res["portfolios"].items()}
    cand = [invest[i] for i in res["candidates"]]
    log.info("Kandidatsett for risikoparitet/HRP/bootstrap: %d aktiva", len(cand))

    # Bootstrap on the candidate set (+ reference for the prior).
    bcols = sorted(set(cand) | {ref})
    rb = r_all[bcols]
    bcon = op.Constraints.build([c for c in bcols if c in set(invest)], meta, oc)
    boot = bootstrap_on(rb, ref, invest, oc, bcon, rf)

    # Portfolio statistics (expected from the model, realised history for drawdown).
    pstats = {}
    for k, w in weights.items():
        pstats[k] = portfolio_stats(w, mu, S, rf, prices, meta)
    wref = pd.Series({ref: 1.0})
    ref_ret = float(mu_all[ref])
    ref_vol = float(np.sqrt(S_all.loc[ref, ref]))
    pstats["reference"] = {"exp_return": ref_ret, "vol": ref_vol, "sharpe": (ref_ret - rf) / ref_vol,
                           "max_drawdown": float(op.drawdown(op.portfolio_series(prices, wref)).min()),
                           "fee": float(meta.at[ref, "fee"]) if ref in meta.index else None, "n": 1}

    return {"meta": meta, "mu": mu, "S": S, "beta": beta_all[invest], "r": r, "weights": weights,
            "stats": pstats, "frontier": res["frontier"], "candidates": cand, "boot": boot,
            "invest": invest, "con": con, "prices": prices, "R": R}


def bootstrap_on(rb, ref, invest, oc, bcon, rf):
    """Bootstrap where the reference is used for beta but only investable assets get weight."""
    inv = [c for c in rb.columns if c in set(invest)]
    rng = np.random.default_rng(oc.get("seed", 42))
    out = {"frontiers": [], "max_sharpe": [], "min_variance": [], "assets": inv}
    n = oc.get("bootstrap_samples", 200)
    for k in range(n):
        idx = op.block_bootstrap_index(len(rb), oc.get("bootstrap_block_weeks", 8), rng)
        x = rb.iloc[idx].reset_index(drop=True)
        Sdf = op.ledoit_wolf(x)
        mu, _ = op.expected_returns(x, ref, rf, oc["market_risk_premium"], oc["history_weight"], Sdf)
        m, S = mu[inv].to_numpy(), Sdf.loc[inv, inv].to_numpy()
        try:
            fr = op.frontier(m, S, bcon, rf, oc.get("bootstrap_frontier_points", 20))
            out["frontiers"].append([(p["vol"], p["ret"]) for p in fr])
            out["max_sharpe"].append(op.max_sharpe(m, S, bcon, rf))
            out["min_variance"].append(op.solve(m, S, bcon))
        except op.Infeasible:
            continue
        if (k + 1) % 50 == 0:
            log.info("Bootstrap %d/%d", k + 1, n)
    return out


def portfolio_stats(w, mu, S, rf, prices, meta):
    w = w[w > 0]
    ret = float(mu[w.index] @ w)
    vol = float(np.sqrt(w @ S.loc[w.index, w.index] @ w))
    series = op.portfolio_series(prices, w.to_dict())
    return {"exp_return": ret, "vol": vol, "sharpe": (ret - rf) / vol, "n": int(len(w)),
            "fee": float(meta.reindex(w.index)["fee"].fillna(0) @ w),
            "max_drawdown": float(op.drawdown(series).min()), "history_from": str(series.index[0].date())}


def risk_contributions(w, S):
    w = w[w > 0]
    s = S.loc[w.index, w.index]
    port_var = float(w @ s @ w)
    rc = w * (s @ w) / port_var
    return rc


def run_backtest(model, cfg):
    """Walk-forward targets for each strategy and rebalancing-rule comparison."""
    prices, meta = model["prices"], model["meta"]
    reps = model["invest"]
    ref = cfg["reference_isin"]
    R_smooth = model["R"]                                           # for estimation (as live)
    weekly = prices.resample("W-FRI").last()
    if weekly.index[-1] > prices.index.max():
        weekly = weekly.iloc[:-1]
    ret_raw = weekly.pct_change(fill_method=None).iloc[1:]           # actual closes for P&L
    dates = pd.date_range(cfg["backtest_start"], ret_raw.index[-1], freq=cfg.get("backtest_reoptimize", "QE"))
    dates = [ret_raw.index[ret_raw.index.searchsorted(d, side="right") - 1] for d in dates]
    cols = sorted(set(reps) | {ref})
    est = R_smooth.reindex(columns=cols)
    strategies = cfg.get("backtest_strategies", PORTFOLIOS)
    targets = bt.target_weights(est, meta, cfg, dates, strategies, ref, investable=set(reps))
    spreads = meta["spread_pct"]
    series, table = {}, []
    for s, t in targets.items():
        v, st = bt.simulate(ret_raw, t, "quarterly", cfg, spreads)
        series[s] = v
        table.append({"strategy": s, **st})
    start = min(t.index[0] for t in targets.values())
    refv = (1 + ret_raw[ref][ret_raw.index >= start].fillna(0)).cumprod() * cfg.get("portfolio_value_nok", 500000)
    series["reference"] = refv
    table.append({"strategy": "reference", **bt.summarize(refv), "rule": "kjøp og hold", "costs_pct_per_year": 0.0})
    rec = cfg.get("recommended", "max_sharpe")
    freq = []
    for rule in cfg.get("rebalance_rules", ["monthly", "quarterly", "annual", "band"]):
        _, st = bt.simulate(ret_raw, targets[rec], rule, cfg, spreads)
        freq.append(st)
    return {"targets": targets, "series": series, "table": table, "frequency": freq, "recommended": rec}


def export_all(conn, model, bt_res, cfg, account, coverage, universe_report, out_dir, now=None):
    """Write all JSON files for the site."""
    out = Path(out_dir)
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    meta, mu, S, rf = model["meta"], model["mu"], model["S"], cfg["risk_free_rate"]
    prices = model["prices"]
    ref = cfg["reference_isin"]
    rec = cfg.get("recommended", "max_sharpe")

    def etf_info(i):
        r = meta.loc[i] if i in meta.index else {}
        g = lambda k: r.get(k) if hasattr(r, "get") else None
        return {"isin": i, "ticker": g("symbol"), "yahoo": g("yahoo_ticker"), "name": g("name"), "fee": g("fee"),
                "currency": g("currency"), "category": g("category"), "accumulating": g("accumulating"),
                "cluster_id": g("cluster_id"), "nordnet_url": g("nordnet_url")}

    # portfolios.json
    ports = {}
    for k, w in model["weights"].items():
        w = w[w > 0].sort_values(ascending=False)
        rc = risk_contributions(w, S)
        ports[k] = {"label": LABELS[k], "stats": model["stats"][k],
                    "holdings": [{**etf_info(i), "weight": float(x), "risk_contribution": float(rc[i])}
                                 for i, x in w.items()]}
    ports["reference"] = {"label": LABELS["reference"], "stats": model["stats"]["reference"],
                          "holdings": [{**etf_info(ref), "weight": 1.0, "risk_contribution": 1.0}]}
    write_json(out / "portfolios.json", {"recommended": rec, "portfolios": ports})

    # frontier.json
    vols = [p["vol"] for p in model["frontier"]]
    grid = np.linspace(min(vols), max(vols), 40)
    band = op.frontier_band(model["boot"]["frontiers"], grid)
    assets = [{**etf_info(i), "ret": float(mu[i]), "vol": float(np.sqrt(S.loc[i, i])), "beta": float(model["beta"][i])}
              for i in model["invest"]]
    write_json(out / "frontier.json", {
        "risk_free_rate": rf,
        "points": [{"vol": p["vol"], "ret": p["ret"], "sharpe": p["sharpe"],
                    "weights": {model["invest"][j]: float(x) for j, x in enumerate(p["w"]) if x >= 0.001}}
                   for p in model["frontier"]],
        "band": [{"vol": float(v), "p10": b[0], "p50": b[1], "p90": b[2]} for v, b in zip(grid, band)],
        "assets": assets,
        "markers": {k: {"label": ports[k]["label"], "vol": ports[k]["stats"]["vol"], "ret": ports[k]["stats"]["exp_return"]}
                    for k in ports}})

    # stability.json (bootstrap)
    stab = {}
    inv = model["boot"]["assets"]
    for k in ("max_sharpe", "min_variance"):
        W = np.array(model["boot"][k])
        if not len(W):
            continue
        rows = []
        for j, i in enumerate(inv):
            col = W[:, j]
            if col.max() < 0.01 and model["weights"][k].get(i, 0) == 0:
                continue
            rows.append({**etf_info(i), "mean": float(col.mean()), "p10": float(np.percentile(col, 10)),
                         "p90": float(np.percentile(col, 90)), "freq": float((col >= cfg.get("min_weight", 0.02)).mean()),
                         "model_weight": float(model["weights"][k].get(i, 0))})
        stab[k] = sorted(rows, key=lambda x: -x["mean"])
    write_json(out / "stability.json", {"samples": len(model["boot"]["max_sharpe"]),
                                        "block_weeks": cfg.get("bootstrap_block_weeks"), "portfolios": stab})

    # risk.json (recommended portfolio)
    w = model["weights"][rec]
    w = w[w > 0].sort_values(ascending=False)
    corr = model["r"][w.index].corr()
    ser = op.portfolio_series(prices, w.to_dict())
    refser = (prices[ref].dropna() / prices[ref].dropna().iloc[0])
    refser = refser[refser.index >= ser.index[0]]
    wk = lambda s: s.resample("W-FRI").last().dropna()
    write_json(out / "risk.json", {
        "portfolio": rec, "labels": [meta.at[i, "symbol"] if i in meta.index else i for i in w.index],
        "isins": list(w.index), "corr": corr.round(3).values.tolist(),
        "risk_contribution": [float(x) for x in risk_contributions(w, S)],
        "weights": [float(x) for x in w],
        "drawdown": {"dates": [str(d.date()) for d in wk(ser).index],
                     "portfolio": [float(x) for x in op.drawdown(wk(ser))],
                     "reference": [float(x) for x in op.drawdown(wk(refser)).reindex(wk(ser).index).ffill()]}})

    # backtest.json
    ser = bt_res["series"]
    idx = sorted(set().union(*[s.index for s in ser.values()]))
    write_json(out / "backtest.json", {
        "rule_main": "quarterly", "recommended": bt_res["recommended"],
        "dates": [str(d.date()) for d in idx],
        "series": {k: [float(x) if pd.notna(x) else None for x in (v / v.iloc[0]).reindex(idx)] for k, v in ser.items()},
        "labels": {k: LABELS.get(k, k) for k in ser},
        "table": bt_res["table"], "frequency": bt_res["frequency"],
        "costs": {k: cfg.get(k) for k in ("portfolio_value_nok", "courtage_pct", "courtage_min_nok", "fx_fee_pct",
                                         "default_spread_pct", "rebalance_band_pp")},
        "note": "Walk-forward: målvekter beregnes bare med data tilgjengelig på hvert tidspunkt. "
                "Universet er dagens klyngerepresentanter (survivorship bias)."})

    # universe.json (explorer)
    met = asset_metrics(prices, rf)
    rows = []
    for i, r in meta.iterrows():
        mrow = met.loc[i] if i in met.index else {}
        gm = lambda k: (mrow.get(k) if hasattr(mrow, "get") else None)
        rows.append({"isin": i, "ticker": r["symbol"], "yahoo": r.get("yahoo_ticker"), "name": r["name"],
                     "category": r["category"], "currency": r.get("currency"), "issuer": r.get("issuer_name"),
                     "fee": r["fee"], "owners": r["number_of_owners"], "fund_size": r["fund_size"],
                     "accumulating": r["accumulating"], "hedged": r["hedged"], "leveraged": r["leveraged"],
                     "history_years": r["history_years"], "cagr": gm("cagr"), "vol": gm("vol"),
                     "sharpe": gm("sharpe"), "max_drawdown": gm("max_drawdown"),
                     "cluster_id": r["cluster_id"], "cluster_size": r["cluster_size"],
                     "is_representative": r["is_representative"], "eligible": r["eligible"], "reason": r["reason"],
                     "nordnet_url": r.get("nordnet_url")})
    write_json(out / "universe.json", {"etfs": rows})

    # model.json: mu and covariance of all representatives (for "current portfolio" in the browser)
    inv = model["invest"]
    Sv = S.to_numpy()
    write_json(out / "model.json", {
        "isins": inv, "mu": [round(float(mu[i]), 5) for i in inv],
        "cov_lower": [[round(float(Sv[a, b]), 6) for b in range(a + 1)] for a in range(len(inv))],
        "risk_free_rate": rf, "reference": ref,
        "reference_mu": model["stats"]["reference"]["exp_return"],
        "reference_vol": model["stats"]["reference"]["vol"]})

    # changes.json: Nordnet changes per run + weight changes since last build
    changes = pd.read_sql_query(
        """SELECT c.run_id, r.run_at, c.instrument_id, c.change, c.field, c.old, c.new, m.isin, m.name, m.symbol
           FROM changes c JOIN runs r USING(run_id) LEFT JOIN etf_master m USING(instrument_id)
           ORDER BY c.run_id DESC""", conn)
    runs = []
    for (rid, at), g in changes.groupby(["run_id", "run_at"], sort=False):
        first = rid == changes["run_id"].min()
        runs.append({"run_id": int(rid), "run_at": at,
                     "counts": g["change"].value_counts().to_dict(),
                     "items": [] if first else g.drop(columns=["run_id", "run_at"]).to_dict("records")})
    conn.executescript(WEIGHTS_SCHEMA)
    prev_at = conn.execute("SELECT MAX(built_at) FROM weights_history WHERE built_at < ?", (now,)).fetchone()[0]
    prev = pd.read_sql_query("SELECT portfolio, isin, weight FROM weights_history WHERE built_at = ?",
                             conn, params=(prev_at,)) if prev_at else pd.DataFrame(columns=["portfolio", "isin", "weight"])
    wchg = {}
    for k, w in model["weights"].items():
        old = prev[prev["portfolio"] == k].set_index("isin")["weight"]
        new = w[w > 0]
        allk = sorted(set(old.index) | set(new.index))
        wchg[k] = [{**etf_info(i), "old": float(old.get(i, 0)), "new": float(new.get(i, 0))} for i in allk
                   if abs(float(old.get(i, 0)) - float(new.get(i, 0))) > 1e-4]
    with conn:
        conn.executemany("INSERT INTO weights_history VALUES(?,?,?,?)",
                         [(now, k, i, float(x)) for k, w in model["weights"].items() for i, x in w[w > 0].items()])
    write_json(out / "changes.json", {"runs": runs, "weights_previous_build": prev_at, "weight_changes": wchg})

    # quality.json + summary.json
    write_json(out / "quality.json", {"coverage": coverage, "universe": universe_report,
                                      "n_optimized": len(model["invest"])})
    last_run = conn.execute("SELECT run_at, n_found FROM runs ORDER BY run_id DESC LIMIT 1").fetchone()
    write_json(out / "summary.json", {
        "generated_at": now, "data_until": str(prices.index.max().date()),
        "nordnet_run_at": last_run[0] if last_run else None, "nordnet_n": last_run[1] if last_run else None,
        "recommended": rec, "recommended_label": LABELS[rec], "stats": model["stats"][rec],
        "reference": {**etf_info(ref), "stats": model["stats"]["reference"]},
        "account": account,
        "params": {k: cfg.get(k) for k in ("risk_free_rate", "market_risk_premium", "history_weight",
                                           "lookback_weeks", "max_weight", "min_weight", "max_assets",
                                           "max_category_weight", "max_portfolio_fee", "rebalance_band_pp")},
        "labels": LABELS})
