import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from etfpf import classify as cl
from etfpf import rates
from etfpf import sitedata as sd

ROOT = Path(__file__).resolve().parents[1]


# ---------------------------------------------------------------- classification

@pytest.mark.parametrize("name,category,fund_type,expect", [
    ("iShares Nasdaq US Biotechnology UCITS ETF USD (Acc)", "Healthcare Sector Equity", "Aksje",
     {"asset_class": "Aksjer", "sector": "Helse", "theme": "Biotek", "region": "USA"}),
    ("Xtrackers MSCI World Information Technology UCITS ETF 1C", "Technology Sector Equity", "Aksje",
     {"sector": "Teknologi", "region": "Global", "theme": None, "style": "Markedsvektet"}),
    ("iShares Core MSCI EM IMI UCITS ETF USD (Acc)", "Global Emerging Markets Equity", "Aksje",
     {"region": "Fremvoksende", "sector": "Bred"}),
    ("Global X Clean Water UCITS ETF USD Accumulating", "Equity Miscellaneous", "Aksje",
     {"region": "Global", "theme": "Vann"}),
    ("SPDR FTSE EPRA Europe ex UK Real Estate UCITS ETF (Acc)", "Real Estate Sector Equity", "Aksje",
     {"region": "Europa", "sector": "Eiendom"}),
    ("Sprott Rare Earths Ex-China UCITS ETF", "Natural Resources Sector Equity", "Aksje", {"region": "Global"}),
    ("iShares Dow Jones Industrial Average UCITS ETF USD (Acc)", "US Equity Large Cap Value", "Aksje",
     {"sector": "Bred", "style": "Verdi"}),
    ("Pictet AI Enhanced World Equity UCITS ETF", "Global Equity Large Cap", "Aksje", {"theme": None, "style": "Aktiv"}),
    ("iShares $ Treasury Bond 7-10yr UCITS ETF", "US Fixed Income", "Rente",
     {"asset_class": "Renter", "sector": "Statsobligasjoner", "theme": None}),
    ("Amundi MSCI World Climate Paris Aligned UCITS ETF", "Global Equity Large Cap", "Aksje", {"esg": True}),
    ("Leverage Shares 3x Long", "Trading Tools", "Øvrig", {"asset_class": "Giret/invers"}),
])
def test_classify(name, category, fund_type, expect):
    c = cl.classify(name, category, fund_type)
    for k, v in expect.items():
        assert c[k] == v, (k, c)


# ---------------------------------------------------------------- monthly returns

def test_last_complete_month():
    assert sd.last_complete_month("2026-10-08") == pd.Timestamp("2026-09-30")
    assert sd.last_complete_month("2026-09-29") == pd.Timestamp("2026-09-30")
    assert sd.last_complete_month("2026-09-30") == pd.Timestamp("2026-09-30")
    assert sd.last_complete_month("2026-09-20") == pd.Timestamp("2026-08-31")


def test_monthly_returns_compound_to_daily():
    idx = pd.bdate_range("2020-01-01", "2021-06-15")
    rng = np.random.default_rng(0)
    a = pd.Series(100 * np.cumprod(1 + rng.normal(0, 0.01, len(idx))), index=idx)
    b = a.copy()
    b[b.index < "2020-06-10"] = np.nan                 # starts later
    c = a.copy()
    c[c.index > "2021-02-10"] = np.nan                 # stale at the end
    r = sd.monthly_returns(pd.DataFrame({"A": a, "B": b, "C": c}))
    assert r.index[-1] == pd.Timestamp("2021-05-31")
    full = a.asof(pd.Timestamp("2021-05-31")) / a.asof(pd.Timestamp("2020-01-31")) - 1
    assert np.isclose((1 + r["A"]).prod() - 1, full)
    assert r["B"].first_valid_index() == pd.Timestamp("2020-07-31")
    assert r["C"].last_valid_index() == pd.Timestamp("2021-01-31")


def test_encode_returns():
    r = pd.DataFrame({"A": [np.nan, 0.01, -0.02345, 0.0], "B": [np.nan] * 3 + [0.1]},
                     index=pd.date_range("2020-01-31", periods=4, freq="ME"))
    enc = sd.encode_returns(r)
    assert enc == {"A": [1, 100, -234, 0]}     # B has < 2 points


# ---------------------------------------------------------------- risk-free rate

def test_rates_parse_and_monthly(tmp_path):
    csv = "FREQ;INSTRUMENT_TYPE;TENOR;UNIT_MEASURE;TIME_PERIOD;OBS_VALUE\n" + \
        "\n".join(f"B;KPRA;SD;R;2024-{m:02d}-15;{4.5 if m < 6 else 4.0}" for m in range(1, 13))
    df = rates.parse_norges_bank_rate_csv(csv)
    assert len(df) == 12 and df["rate"].iloc[0] == 4.5
    months = pd.date_range("2024-01-31", periods=12, freq="ME")
    rf, src = rates.monthly_rf(months)                 # fallback table
    assert "tabell" in src
    assert np.isclose((1 + rf.iloc[0]) ** 12 - 1, 0.045, atol=1e-9)
    df.to_parquet(tmp_path / "rates.parquet")
    rf2, src2 = rates.monthly_rf(months, tmp_path)
    assert "Norges Bank" in src2
    assert np.isclose((1 + rf2.iloc[-1]) ** 12 - 1, 0.04, atol=1e-9)


def test_update_rates_never_raises(tmp_path):
    def bad_get(*a, **k):
        raise OSError("no network")
    ok, msg = rates.update_rates(tmp_path, get=bad_get)
    assert not ok and "network" in msg


# ---------------------------------------------------------------- browser engine (node)

@pytest.mark.skipif(shutil.which("node") is None, reason="node mangler")
def test_engine_js(tmp_path):
    """Engine statistics vs numpy, and optimiser vs a brute-force grid with bounds."""
    rng = np.random.default_rng(1)
    T, n = 120, 3
    X = rng.multivariate_normal([0.008, 0.006, 0.004], [[0.0025, 0.0012, 0.0004], [0.0012, 0.0016, 0.0003],
                                                         [0.0004, 0.0003, 0.0009]], size=T)
    b = X @ np.array([0.5, 0.3, 0.2]) + rng.normal(0, 0.002, T)
    rf = np.full(T, 0.002)
    case = {"X": X.tolist(), "b": b.tolist(), "rf": rf.tolist()}
    (tmp_path / "case.json").write_text(json.dumps(case))
    js = f"""
const E = require({json.dumps(str(ROOT / 'site' / 'engine.js'))});
const c = require({json.dumps(str(tmp_path / 'case.json'))});
const r = Float64Array.from(c.X.map(x => x[0])), b = Float64Array.from(c.b), rf = Float64Array.from(c.rf);
const s = E.stats(r, b, rf, r.length - 1, 60);
const lw = E.ledoitWolfCC(c.X);
const S = lw.S.map(row => Float64Array.from(row, v => v * 12));
const mu = Float64Array.from([0.10, 0.08, 0.05]), lo = Float64Array.from([0.1, 0, 0]), hi = Float64Array.from([0.5, 0.6, 0.6]);
const ms = E.optimize("max_sharpe", mu, S, lo, hi, 0.03), mv = E.optimize("min_variance", mu, S, lo, hi, 0.03);
console.log(JSON.stringify({{ s, S: S.map(r => Array.from(r)), ms: Array.from(ms.w), mv: Array.from(mv.w) }}));
"""
    out = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
    x, bb, f = X[-60:, 0], b[-60:], rf[-60:]
    ret = np.prod(1 + x) ** (12 / 60) - 1
    vol = x.std(ddof=1) * np.sqrt(12)
    beta, a = np.polyfit(bb - f, x - f, 1)
    assert np.isclose(out["s"]["ret"], ret) and np.isclose(out["s"]["vol"], vol)
    assert np.isclose(out["s"]["beta"], beta) and np.isclose(out["s"]["alpha"], (1 + a) ** 12 - 1)
    S = np.array(out["S"])
    mu, lo, hi, rf_ = np.array([0.10, 0.08, 0.05]), np.array([0.1, 0, 0]), np.array([0.5, 0.6, 0.6]), 0.03
    best_s, best_v = (-9, None), (9, None)
    for w0 in np.arange(0.1, 0.5001, 0.0025):
        for w1 in np.arange(0, 0.6001, 0.0025):
            w2 = 1 - w0 - w1
            if w2 < -1e-12 or w2 > 0.6 + 1e-12:
                continue
            w = np.array([w0, w1, w2])
            v = np.sqrt(w @ S @ w)
            best_s = max(best_s, ((w @ mu - rf_) / v, tuple(w)), key=lambda t: t[0])
            best_v = min(best_v, (v, tuple(w)), key=lambda t: t[0])
    for got, ref in ((out["ms"], best_s[1]), (out["mv"], best_v[1])):
        assert np.allclose(got, ref, atol=0.01), (got, ref)
        assert abs(sum(got) - 1) < 1e-9 and all(l - 1e-9 <= g <= h + 1e-9 for g, l, h in zip(got, lo, hi))


@pytest.mark.skipif(shutil.which("node") is None, reason="node mangler")
def test_engine_rebalance_rules():
    js = f"""
const E = require({json.dumps(str(ROOT / 'site' / 'engine.js'))});
const r = Float64Array.from({{length: 24}}, (_, i) => 0.03 * ((i % 5) - 2)), q = new Float64Array(24).fill(0.005);
const cal = (i) => ({{ y: 2020 + Math.floor(i / 12), m: (i % 12) + 1 }});
const w = Float64Array.from([0.5, 0.5]), out = {{}};
for (const rule of ["monthly", "quarterly", "annual", "none"]) out[rule] = E.simulate([r, q], 0, 23, () => w, () => false, rule, 0.05, 0.001, cal).tradesPerYear;
console.log(JSON.stringify(out));
"""
    out = json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)
    assert out == {"monthly": 11.5, "quarterly": 3.5, "annual": 0.5, "none": 0}
