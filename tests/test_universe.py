import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from etfpf import universe as un

CFG = {"exclude_categories": ["Trading Tools"],
       "exclude_name_regex": r"leverag|\b[2-5]x\b|\(-?[1-5]x\)|short|invers|\bbear\b|\bbull\b",
       "hedged_name_regex": r"(?<!tail )hedg|\bhdg\b|\bhgd\b|pfhdg",
       "min_history_years": 5, "dist_fee_penalty": 0.10, "hysteresis_fee_pp": 0.05}


def test_te_matrix_matches_pairwise_on_overlap():
    rng = np.random.default_rng(0)
    R = pd.DataFrame(rng.normal(0, 0.02, (120, 3)), columns=list("abc"))
    R.iloc[:40, 2] = np.nan                                  # c starts later
    te, n = un.te_matrix(R, periods=12)
    for i, a in enumerate(R):
        for j, b in enumerate(R):
            d = (R[a] - R[b]).dropna()
            assert n[i, j] == len(d)
            assert te[i, j] == pytest.approx(d.std() * np.sqrt(12) if i != j else 0.0, abs=1e-12)


def test_robust_te_ignores_isolated_errors_but_not_real_difference():
    rng = np.random.default_rng(1)
    base = rng.normal(0, 0.04, 60)
    same = base + rng.normal(0, 0.001, 60)
    same[[10, 30]] += 0.15                                   # two data-error months
    other = base + rng.normal(0, 0.01, 60)                   # genuinely different index
    R = pd.DataFrame({"a": base, "b": same, "c": other})
    pairs = np.array([[0, 1], [0, 2]])
    rte, n = un.robust_te(R, pairs, periods=12)
    plain, _ = un.te_matrix(R, periods=12)
    assert plain[0, 1] > 0.05 and rte[0] < 0.006             # errors removed
    assert rte[1] == pytest.approx(plain[0, 2], rel=0.15)    # real difference kept
    assert list(n) == [60, 60]


def test_period_returns_drops_incomplete_and_smooths():
    idx = pd.bdate_range("2026-01-01", "2026-03-18")
    p = pd.DataFrame({"a": np.linspace(100, 110, len(idx))}, index=idx)
    r = un.period_returns(p, "ME")
    assert list(r.index.month) == [2]                        # Jan->Feb; March incomplete
    noisy = p.copy()
    noisy.iloc[-15] *= 1.05                                  # bad close near end of Feb... smoothing dampens
    feb_end = noisy.index[noisy.index.month == 2][-1]
    noisy.loc[feb_end] *= 1.05
    raw = un.period_returns(noisy, "ME")
    smooth = un.period_returns(noisy, "ME", smooth_days=5)
    assert abs(smooth.iloc[0, 0] - r.iloc[0, 0]) < abs(raw.iloc[0, 0] - r.iloc[0, 0]) / 2
    assert len(un.period_returns(p, "W-FRI", window_periods=3)) == 3


def test_complete_linkage_no_chaining():
    # A~B 0.5 %, B~C 0.5 %, A~C 1.2 %: complete linkage at 0.75 % must not put A and C together.
    d = np.array([[0, .005, .012], [.005, 0, .005], [.012, .005, 0]])
    lab = un.cluster(d, 0.0075)
    assert lab[0] != lab[2]
    assert len(set(un.cluster(d, 0.013))) == 1


def test_distance_matrix_blocks_short_overlap():
    te = np.array([[0, .001], [.001, 0]])
    n = np.array([[50, 5], [5, 50]])
    assert un.distance_matrix(te, n, 12)[0, 1] == un.BIG
    assert un.distance_matrix(te, n, 5)[0, 1] == pytest.approx(.001)


def test_renumber_largest_first():
    assert list(un.renumber(np.array([7, 3, 3, 9]), ["d", "b", "a", "c"])) == [3, 1, 1, 2]


def listing_rows():
    return pd.DataFrame([
        dict(instrument_id=1, isin="IE0001", symbol="A", name="X MSCI World UCITS ETF", currency="SEK",
             issuer_name="X", category="Global Equity Large Cap", fee=0.2, fund_size=1e9, number_of_owners=10,
             dividend_policy="Akkumuleres i fondet", is_tradable="1", ask_eligible="1", spread_pct=0.1),
        dict(instrument_id=2, isin="IE0001", symbol="A", name="X MSCI World UCITS ETF", currency="EUR",
             issuer_name="X", category="Global Equity Large Cap", fee=0.2, fund_size=1e9, number_of_owners=5,
             dividend_policy="Akkumuleres i fondet", is_tradable="1", ask_eligible="1", spread_pct=0.2),
        dict(instrument_id=3, isin="LU0002", symbol="L", name="Y S&P 500 2x Leveraged Daily", currency="EUR",
             issuer_name="Y", category="Trading Tools", fee=0.6, fund_size=None, number_of_owners=3,
             dividend_policy="Akkumuleres i fondet", is_tradable="1", ask_eligible="1", spread_pct=0.3),
        dict(instrument_id=4, isin="IE0003", symbol="H", name="Z S&P 500 EUR Hgd Acc", currency="EUR",
             issuer_name="Z", category="US Equity", fee=0.1, fund_size=None, number_of_owners=None,
             dividend_policy="Utdelende", is_tradable="1", ask_eligible="1", spread_pct=None),
    ])


def test_pick_listing_and_flags():
    u = un.add_flags(un.pick_listing(listing_rows(), ["NOK", "EUR", "SEK"]), CFG)
    assert u.loc["IE0001", "instrument_id"] == 2               # EUR preferred over SEK
    assert u.loc["IE0001", "number_of_owners"] == 15           # owners summed across listings
    assert u.loc["LU0002", "leveraged"] == 1 and u.loc["IE0001", "leveraged"] == 0
    assert u.loc["IE0003", "hedged"] == 1 and u.loc["IE0003", "accumulating"] == 0


def make_universe(rows):
    u = pd.DataFrame(rows).set_index("isin")
    for c, v in [("is_tradable", "1"), ("ask_eligible", "1"), ("leveraged", 0), ("has_prices", True),
                 ("fund_size", np.nan), ("number_of_owners", np.nan), ("accumulating", 1)]:
        u[c] = u[c].fillna(v) if c in u else v
    u["eff_fee"] = u["fee"] + np.where(u["accumulating"] == 0, CFG["dist_fee_penalty"], 0)
    return un.eligibility(u, CFG)


def test_representative_rules_and_hysteresis():
    u = make_universe([
        dict(isin="A", cluster_id=1, fee=0.20, history_years=10),
        dict(isin="B", cluster_id=1, fee=0.18, history_years=8),
        dict(isin="C", cluster_id=1, fee=0.07, history_years=3),            # too short history
        dict(isin="D", cluster_id=1, fee=0.05, history_years=9, accumulating=0),  # dist penalty -> 0.15
        dict(isin="E", cluster_id=2, fee=0.30, history_years=12, leveraged=1),
    ])
    r = un.choose_representatives(u, CFG)
    assert r.loc["D", "is_representative"] == 1                # 0.15 effective beats 0.18
    assert r.loc["C", "eligible"] == 0 and "historikk" in r.loc["C", "reason"]
    assert r.loc["E", "is_representative"] == 0 and "giret" in r.loc["E", "reason"]
    # Hysteresis: previous rep B is only 0.03 pp worse than D -> kept.
    r = un.choose_representatives(u, CFG, previous=["B"])
    assert r.loc["B", "is_representative"] == 1 and "hysterese" in r.loc["B", "reason"]
    # Previous rep A is 0.05 pp worse -> replaced.
    r = un.choose_representatives(u, CFG, previous=["A"])
    assert r.loc["D", "is_representative"] == 1 and "byttet" in r.loc["D", "reason"]
    assert r["is_representative"].groupby(r["cluster_id"]).sum().to_dict() == {1: 1, 2: 0}


def test_rank_ties_broken_by_size_then_history():
    u = make_universe([
        dict(isin="A", cluster_id=1, fee=0.07, history_years=10, fund_size=1e9),
        dict(isin="B", cluster_id=1, fee=0.07, history_years=12, fund_size=5e9),
    ])
    assert un.choose_representatives(u, CFG).loc["B", "is_representative"] == 1


def test_normalize_name():
    assert un.normalize_name("iShares Core MSCI World UCITS ETF USD (Acc)") == "core msci world"
    assert un.normalize_name("Xtrackers MSCI Korea UCITS ETF 1C") == "msci korea"


DB = Path(__file__).resolve().parents[1] / "data" / "etf.db"


@pytest.mark.skipif(not DB.exists(), reason="ingen database")
def test_acceptance_on_committed_universe():
    """Section 4 acceptance tests against the committed result of build_universe.py."""
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    if not conn.execute("SELECT name FROM sqlite_master WHERE name='universe'").fetchone():
        pytest.skip("universe er ikke bygget")
    u = pd.read_sql_query("SELECT isin, name, cluster_id, hedged, leveraged FROM universe", conn)
    plain = u[(u.hedged == 0) & (u.leveraged == 0)]
    for pat in (r"\bmsci korea\b", r"\bmsci taiwan\b"):
        g = plain[plain.name.str.contains(pat, case=False)]
        assert len(g) >= 2 and g.cluster_id.nunique() == 1, g
    cl = u.set_index("isin").cluster_id
    assert cl["IE00B5BMR087"] != cl["IE00B4L5Y983"]           # Core S&P 500 vs Core MSCI World
