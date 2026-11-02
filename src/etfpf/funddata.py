"""Data for the fund tab (site/data/funds.json).

Nordnet's fund list gives, per fund, cumulative returns for 1 month to 10 years. They are in NOK,
also for funds quoted in USD/EUR/SEK (verified 2026-11 against Yahoo prices converted with Norges
Bank rates), so they are comparable with the ETFs' NOK returns without currency conversion.
Yahoo's fund histories mostly start in 2022, so the fund tab uses Nordnet's numbers rather than
price series.

For the "cheaper ETF alternative" comparison the ETFs' annualized total returns in NOK are
computed from our own daily prices up to the same date as the fund numbers (`as_of`).
"""
import json
import re
from datetime import datetime, timezone

import pandas as pd

from . import classify as cl
from .sitedata import write_json

PERIODS = (1, 3, 5, 10)
INDEX_RE = re.compile(r"\bind(?:e)?ks\b|\bindex\b|\bindeks", re.I)


def _f(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v else None


def annualize(cum_pct, years):
    """Cumulative return in percent over `years` -> annualized fraction (None if missing)."""
    v = _f(cum_pct)
    if v is None or v <= -100:
        return None
    return (1 + v / 100) ** (1 / years) - 1


def latest_funds(conn):
    """Latest snapshot per active fund: master columns + parsed raw JSON."""
    q = """SELECT m.instrument_id, m.isin, m.symbol, m.name, m.currency, m.category, m.fund_type, m.fee,
                  m.total_fee, m.number_of_owners, m.dividend_policy, m.risk, m.rating, m.fund_size,
                  m.start_date, m.domicile, m.is_tradable, s.raw_json, r.run_at
           FROM etf_master m
           JOIN etf_snapshot s ON s.instrument_id = m.instrument_id
             AND s.run_id = (SELECT MAX(run_id) FROM etf_snapshot WHERE instrument_id = m.instrument_id)
           JOIN runs r ON r.run_id = s.run_id
           WHERE m.active = 1 AND m.isin IS NOT NULL"""
    df = pd.read_sql_query(q, conn)
    df["raw"] = df["raw_json"].map(lambda s: json.loads(s) if s else {})
    return df.drop(columns=["raw_json"])


def fund_row(r, ask_countries, hedged_re):
    raw = r["raw"]
    fi = raw.get("fund_info") or {}
    hr = raw.get("historical_returns_info") or {}
    ii = raw.get("instrument_info") or {}
    name = r["name"] or ii.get("long_name")
    c = cl.classify(name, r["category"], r["fund_type"])
    yearly, total = _f(fi.get("fund_yearly_fee", r["fee"])), _f(fi.get("fund_total_fee", r["total_fee"]))
    slug = (raw.get("nnx_info") or {}).get("display_slug")
    start = r["start_date"]
    ret = {f"r{P}": (None if (a := annualize(hr.get(f"yield_{P}y"), P)) is None else round(a, 5)) for P in PERIODS}
    return {
        "isin": r["isin"], "ticker": r["symbol"], "name": name, "category": r["category"],
        "fund_type": r["fund_type"], **c,
        "index": r["fund_type"] == "Indeks" or bool(INDEX_RE.search(name or "")),
        "company": fi.get("fund_branding_company") or fi.get("fund_admin_company"),
        "currency": r["currency"], "domicile": r["domicile"],
        "ask": bool(r["domicile"] and r["domicile"] in ask_countries),
        # Cost on Nordnet: annual fee - kickback to the customer + Nordnet's platform fee (= fund_total_fee
        # for 905 of 916 funds in 2026-11; Nordnet's own total is used as the cost).
        "fee": yearly, "kickback": _f(fi.get("fund_refunding")), "platform_fee": _f(fi.get("fund_platform_fee")),
        "cost": total if total is not None else yearly,
        "acc": None if not r["dividend_policy"] else str(r["dividend_policy"]).lower().startswith("akk"),
        "hedged": bool(hedged_re.search(name or "")),
        "risk": _f(r["risk"]), "rating": _f(r["rating"]), "fund_size": _f(r["fund_size"]),
        "owners": _f(r["number_of_owners"]), "min_investment": _f(fi.get("fund_min_investment")),
        "nordnet_selection": bool(fi.get("fund_nordnet_selection")),
        "sfdr": _f(fi.get("fund_raw_sfdr")), "esg_score": _f(fi.get("fund_esg_score")),
        "start": start, "start_year": int(str(start)[:4]) if start else None,
        **ret,
        "ytd": _f(hr.get("yield_ytd")), "m1": _f(hr.get("yield_1m")), "m3": _f(hr.get("yield_3m")),
        "tradable": str(r["is_tradable"]).lower() in ("1", "true"),
        "url": f"https://www.nordnet.no/fond/liste/{slug}" if slug else None,
    }


def etf_returns(prices, as_of):
    """{isin: [r1, r3, r5, r10]} annualized NOK total returns ending at `as_of` (last price on or
    before it, at most 10 days old). None where the history does not reach back far enough."""
    as_of = pd.Timestamp(as_of)
    p = prices[prices.index <= as_of]
    out = {}
    for isin in p.columns:
        s = p[isin].dropna()
        if s.empty or (as_of - s.index[-1]).days > 10:
            continue
        end = s.iloc[-1]
        vals = []
        for P in PERIODS:
            t = as_of - pd.DateOffset(years=P)
            base = s[s.index <= t]
            if base.empty or (t - base.index[-1]).days > 10:
                vals.append(None)
            else:
                vals.append(round((end / base.iloc[-1]) ** (1 / P) - 1, 5))
        if any(v is not None for v in vals):
            out[isin] = vals
    return out


def export(fund_conn, etf_prices, cfg, out_dir):
    """Write funds.json. Returns a small summary dict."""
    df = latest_funds(fund_conn)
    ask_countries = set(cfg["account"]["ask_countries"])
    hedged_re = re.compile(cfg["universe"]["hedged_name_regex"], re.I)
    # One row per ISIN (a fund can appear twice): keep the listing with most owners.
    df = df.sort_values("number_of_owners", ascending=False).drop_duplicates("isin")
    funds = [fund_row(r, ask_countries, hedged_re) for _, r in df.sort_values("name").iterrows()]
    run_at = df["run_at"].max()
    as_of = str(run_at)[:10]
    etf_ret = etf_returns(etf_prices, as_of) if etf_prices is not None else {}
    write_json(out_dir / "funds.json", {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "nordnet_run_at": run_at, "as_of": as_of, "n": len(funds),
        "periods": list(PERIODS), "funds": funds, "etf_returns": etf_ret,
    })
    return {"n": len(funds), "as_of": as_of, "n_etf_returns": len(etf_ret)}
