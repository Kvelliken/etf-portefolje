"""Walk-forward backtest and comparison of rebalancing rules after costs.

At every re-optimisation date the target weights are computed from data available at that date
only (lookback window ending on the date). Between dates the portfolio drifts with weekly NOK
returns; it is traded back to target according to a rebalancing rule, paying courtage
(Nordnet, with a minimum per trade), currency exchange and half the bid/ask spread.

Known bias: the candidate ETFs are today's cluster representatives (survivorship bias), so the
backtest is optimistic about the universe, though not about the weights.
"""
import logging

import numpy as np
import pandas as pd

from . import optimize as op

log = logging.getLogger(__name__)


def target_weights(returns, meta, cfg, dates, strategies, ref_isin, investable=None):
    """{strategy: DataFrame(date x ISIN)} of target weights computed walk-forward. The reference
    is used for the return prior; only `investable` assets (default: all) get weight."""
    rf = cfg["risk_free_rate"]
    out = {s: {} for s in strategies}
    for n, d in enumerate(dates, 1):
        r = op.window(returns, end=d, weeks=cfg["backtest_lookback_weeks"])
        if ref_isin not in r.columns or r.shape[1] < 10:
            continue
        S = op.ledoit_wolf(r)
        mu, _ = op.expected_returns(r, ref_isin, rf, cfg["market_risk_premium"], cfg["history_weight"], S)
        assets = [c for c in r.columns if investable is None or c in investable]
        con = op.Constraints.build(assets, meta, cfg)
        m, Sv, r = mu[assets].to_numpy(), S.loc[assets, assets].to_numpy(), r[assets]
        res = compute_portfolios(m, Sv, con, rf, cfg, r, strategies,
                                 cand_points=max(4, cfg.get("candidate_frontier_points", 15) // 3))
        for s, w in res["portfolios"].items():
            out[s][d] = pd.Series(w, index=assets)
        if n % 8 == 0:
            log.info("Walk-forward: %d/%d datoer (%s, %d aktiva)", n, len(dates), d.date(), len(assets))
    return {s: pd.DataFrame(v).T.fillna(0.0).sort_index() for s, v in out.items() if v}


def compute_portfolios(m, Sv, con, rf, cfg, r, strategies, cand_points=15, frontier_pts=None):
    """Sparse portfolios for the given strategies. Risk parity and HRP run on a candidate set:
    assets that get at least 1 % somewhere along the continuous frontier (plus the max-Sharpe
    and min-variance holdings), at most candidate_max by peak weight."""
    out = {}
    if "max_sharpe" in strategies:
        out["max_sharpe"] = op.sparse_weights("max_sharpe", m, Sv, con, rf, cfg)
    if "min_variance" in strategies:
        out["min_variance"] = op.sparse_weights("min_variance", m, Sv, con, rf, cfg)
    fr = op.frontier(m, Sv, con, rf, frontier_pts or cand_points)
    peak = np.max([p["w"] for p in fr], axis=0) if fr else np.zeros(len(m))
    for w in out.values():
        peak = np.maximum(peak, w)
    cand = np.flatnonzero(peak >= 0.01)
    cand = cand[np.argsort(-peak[cand])][:cfg.get("candidate_max", 40)]
    cand = np.array(sorted(cand))
    if len(cand) and any(s in strategies for s in ("risk_parity", "hrp")):
        sub = con.subset(list(cand))
        m_c, S_c, r_c = m[cand], Sv[np.ix_(cand, cand)], r.iloc[:, cand]
        for s in ("risk_parity", "hrp"):
            if s in strategies:
                w = np.zeros(len(m))
                w[cand] = op.sparse_weights(s, m_c, S_c, sub, rf, cfg, returns=r_c)
                out[s] = w
    return {"portfolios": out, "frontier": fr, "candidates": cand}


# ---------------------------------------------------------------- simulation

def trade_cost(trades_nok, spreads_pct, cfg):
    """Cost in NOK of a set of trades (absolute NOK per asset)."""
    t = np.abs(trades_nok)
    t = t[t > 1.0]
    if not len(t):
        return 0.0, 0
    sp = spreads_pct.reindex(t.index).fillna(cfg.get("default_spread_pct", 0.2)) / 100
    courtage = np.maximum(t * cfg["courtage_pct"], cfg["courtage_min_nok"]).sum()
    fx = (t * cfg.get("fx_fee_pct", 0.0)).sum()
    spread = (t * sp / 2).sum()
    return float(courtage + fx + spread), int(len(t))


def simulate(returns, targets, rule, cfg, spreads, start_value=None):
    """Simulate weekly with a rebalancing rule. returns: weekly simple returns (date x ISIN,
    NaN treated as 0); targets: DataFrame(reopt date x ISIN). Returns (value Series, stats).

    rule: monthly | quarterly | annual | band (check monthly, trade when any weight deviates
    more than rebalance_band_pp from target, or the target set changed)."""
    V0 = float(start_value or cfg.get("portfolio_value_nok", 500000))
    dates = returns.index[returns.index >= targets.index[0]]
    cols = targets.columns
    R = returns.reindex(index=dates, columns=cols).fillna(0.0)
    tgt_dates = targets.index
    holdings = pd.Series(0.0, index=cols)        # NOK per asset
    cash = V0
    values, costs, n_trades, turnover = [], 0.0, 0, 0.0
    band = cfg.get("rebalance_band_pp", 5) / 100
    last_target, last_trade_period = None, None

    def period_key(d):
        return {"monthly": (d.year, d.month), "quarterly": (d.year, (d.month - 1) // 3),
                "annual": (d.year,), "band": (d.year, d.month)}[rule]

    for i, d in enumerate(dates):
        if i > 0:
            holdings *= 1 + R.iloc[i]
        total = holdings.sum() + cash
        k = tgt_dates.searchsorted(d, side="right") - 1
        tgt = targets.iloc[k]
        new_target = last_target is None or not tgt.equals(last_target)
        do = False
        if last_trade_period is None:
            do = True
        elif period_key(d) != last_trade_period:
            if rule == "band":
                w_now = holdings / total
                held, want = set(w_now[w_now > 1e-4].index), set(tgt[tgt > 0].index)
                do = bool((w_now - tgt).abs().max() > band) or (new_target and held != want)
            else:
                do = True
        if rule == "band" and period_key(d) != last_trade_period:
            last_trade_period = period_key(d)
        if do:
            want_nok = tgt * total
            trades = want_nok - holdings
            c, nt = trade_cost(trades, spreads, cfg)
            turnover += np.abs(trades).sum() / total / 2
            holdings = want_nok * (1 - c / total)
            cash = 0.0
            costs += c
            n_trades += nt
            last_target = tgt
            if rule != "band":
                last_trade_period = period_key(d)
        values.append(holdings.sum() + cash)
    v = pd.Series(values, index=dates)
    years = max((dates[-1] - dates[0]).days / 365.25, 1e-9)
    stats = summarize(v)
    stats.update({"rule": rule, "costs_nok": round(costs), "costs_pct_per_year": costs / V0 / years * 100,
                  "trades": n_trades, "trades_per_year": n_trades / years, "turnover_per_year": turnover / years})
    return v, stats


def summarize(v, rf=0.0, periods=52):
    r = v.pct_change().dropna()
    years = max((v.index[-1] - v.index[0]).days / 365.25, 1e-9)
    cagr = (v.iloc[-1] / v.iloc[0]) ** (1 / years) - 1
    vol = r.std() * np.sqrt(periods)
    dd = (v / v.cummax() - 1).min()
    return {"start": str(v.index[0].date()), "end": str(v.index[-1].date()), "cagr": float(cagr),
            "vol": float(vol), "sharpe": float((cagr - rf) / vol) if vol > 0 else None, "max_drawdown": float(dd)}
