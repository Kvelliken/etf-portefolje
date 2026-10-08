import numpy as np
import pandas as pd
import pytest

from etfpf import backtest as bt
from etfpf import optimize as op

RF = 0.03


def problem(n=8, seed=0):
    rng = np.random.default_rng(seed)
    A = rng.normal(0, 0.1, (n, n))
    S = A @ A.T + np.diag(rng.uniform(0.01, 0.05, n))
    mu = RF + rng.uniform(0.0, 0.08, n)
    return mu, S


def test_max_sharpe_qp_matches_frontier_and_respects_constraints():
    mu, S = problem()
    con = op.Constraints(max_weight=0.3, groups={"g": ([0, 1, 2], 0.4)}, fees=np.linspace(0.1, 0.5, 8), max_fee=0.3)
    w = op.max_sharpe(mu, S, con, RF)
    assert w.sum() == pytest.approx(1) and (w >= 0).all() and w.max() <= 0.3 + 1e-6
    assert w[[0, 1, 2]].sum() <= 0.4 + 1e-6 and con.fees @ w <= 0.3 + 1e-6
    best = max(p["sharpe"] for p in op.frontier(mu, S, con, RF, 200))
    assert op.perf(w, mu, S, RF)[2] >= best - 1e-4


def test_min_variance_and_infeasible():
    mu, S = problem()
    w = op.solve(mu, S, op.Constraints(max_weight=1.0))
    grid = [op.perf(p["w"], mu, S, RF)[1] for p in op.frontier(mu, S, op.Constraints(max_weight=1.0), RF, 20)]
    assert op.perf(w, mu, S, RF)[1] <= min(grid) + 1e-6
    with pytest.raises(op.Infeasible):
        op.solve(mu[:3], S[:3, :3], op.Constraints(max_weight=0.2))


def test_capm_prior_makes_reference_the_tangency_portfolio():
    rng = np.random.default_rng(3)
    f = rng.normal(0.002, 0.02, 400)
    r = pd.DataFrame({f"a{i}": b * f + rng.normal(0, 0.01 * (i + 1), 400) for i, b in enumerate([0.6, 0.9, 1.2, 1.5])})
    r["ref"] = r.mean(axis=1)
    S = op.ledoit_wolf(r)
    mu, beta = op.expected_returns(r, "ref", RF, 0.05, 0.0, S)
    assert beta["ref"] == pytest.approx(1.0) and mu["ref"] == pytest.approx(RF + 0.05)
    w = op.max_sharpe(mu.to_numpy(), S.to_numpy(), op.Constraints(max_weight=1.0), RF)
    assert w[list(r.columns).index("ref")] == pytest.approx(1.0, abs=1e-3)


def test_history_weight_blends_prior_and_mean():
    rng = np.random.default_rng(4)
    r = pd.DataFrame(rng.normal(0.003, 0.02, (300, 3)), columns=list("abc"))
    S = op.ledoit_wolf(r)
    mu0, beta = op.expected_returns(r, "a", RF, 0.05, 0.0, S)
    mu1, _ = op.expected_returns(r, "a", RF, 0.05, 1.0, S)
    mu5, _ = op.expected_returns(r, "a", RF, 0.05, 0.5, S)
    assert mu1.to_numpy() == pytest.approx((r.mean() * 52).to_numpy())
    assert mu5.to_numpy() == pytest.approx(((mu0 + mu1) / 2).to_numpy())


def test_erc_equal_risk_contributions():
    _, S = problem(6, seed=1)
    w = op.erc(S)
    rc = w * (S @ w)
    assert np.allclose(rc / rc.sum(), 1 / 6, atol=1e-4)


def test_hrp_uncorrelated_is_inverse_variance():
    var = np.array([0.01, 0.04, 0.09, 0.16])
    w = op.hrp(None, np.diag(var))
    ivp = (1 / var) / (1 / var).sum()
    assert w == pytest.approx(ivp, rel=1e-6)


def test_cap_weights_and_groups():
    w = op.cap_weights(np.array([0.7, 0.1, 0.1, 0.1, 0.0, 0.0]) + 0.01, 0.3)
    assert w.max() <= 0.3 + 1e-9 and w.sum() == pytest.approx(1)
    g = op.cap_groups(np.array([0.3, 0.3, 0.2, 0.2]), {"x": ([0, 1], 0.4)}, 1.0)
    assert g[[0, 1]].sum() == pytest.approx(0.4) and g.sum() == pytest.approx(1)


@pytest.mark.parametrize("kind", ["max_sharpe", "min_variance", "risk_parity", "hrp"])
def test_sparse_weights_min_weight_and_count(kind):
    rng = np.random.default_rng(5)
    n = 30
    r = pd.DataFrame(rng.normal(0.002, 0.02, (260, n)) + rng.normal(0, 0.01, (260, 1)))
    S = op.ledoit_wolf(r).to_numpy()
    mu = RF + rng.uniform(0, 0.06, n)
    cfg = {"min_weight": 0.05, "max_assets": 8}
    w = op.sparse_weights(kind, mu, S, op.Constraints(max_weight=0.25), RF, cfg, returns=r)
    nz = w[w > 1e-6]
    assert len(nz) <= 8 and nz.min() >= 0.05 - 1e-4 and w.sum() == pytest.approx(1)
    assert w.max() <= 0.25 + 1e-6


def test_block_bootstrap_and_band():
    idx = op.block_bootstrap_index(100, 8, np.random.default_rng(0))
    assert len(idx) == 100 and all(idx[k + 1] == idx[k] + 1 for k in range(7))
    fronts = [[(0.1, 0.05), (0.2, 0.08 + 0.001 * i)] for i in range(20)]
    band = op.frontier_band(fronts, [0.15, 0.3])
    assert band[0][0] < band[0][2] and band[1] == [None, None, None]


def test_trade_cost_minimum_courtage():
    cfg = {"courtage_pct": 0.0015, "courtage_min_nok": 99, "fx_fee_pct": 0.0025, "default_spread_pct": 0.2}
    c, n = bt.trade_cost(pd.Series({"a": 10000.0, "b": -100000.0, "c": 0.5}), pd.Series({"a": 0.1}), cfg)
    expected = 99 + 150 + 0.0025 * 110000 + 10000 * 0.001 / 2 + 100000 * 0.002 / 2
    assert n == 2 and c == pytest.approx(expected)


def sim_data():
    idx = pd.date_range("2020-01-03", periods=156, freq="W-FRI")
    rng = np.random.default_rng(6)
    R = pd.DataFrame({"a": rng.normal(0.003, 0.03, 156), "b": rng.normal(0.001, 0.01, 156)}, index=idx)
    tg = pd.DataFrame({"a": [0.5, 0.6], "b": [0.5, 0.4]}, index=[idx[0], idx[78]])
    return R, tg


def test_simulate_rules_and_costs():
    R, tg = sim_data()
    cfg = {"courtage_pct": 0.0015, "courtage_min_nok": 99, "fx_fee_pct": 0.0025, "default_spread_pct": 0.2,
           "rebalance_band_pp": 5, "portfolio_value_nok": 500000}
    free = dict(cfg, courtage_pct=0, courtage_min_nok=0, fx_fee_pct=0, default_spread_pct=0)
    res = {rule: bt.simulate(R, tg, rule, cfg, pd.Series(dtype=float)) for rule in
           ("monthly", "quarterly", "annual", "band")}
    trades = {k: v[1]["trades"] for k, v in res.items()}
    assert trades["monthly"] > trades["quarterly"] > trades["annual"]
    assert trades["band"] < trades["monthly"]
    assert all(v[1]["costs_nok"] > 0 for v in res.values())
    v_free, st = bt.simulate(R, tg, "monthly", free, pd.Series(dtype=float))
    assert st["costs_nok"] == 0
    assert v_free.iloc[-1] > res["monthly"][0].iloc[-1]
    # Constant weights with zero returns keep the value (no costs).
    zero = R * 0
    v0, _ = bt.simulate(zero, tg, "monthly", free, pd.Series(dtype=float))
    assert v0.iloc[-1] == pytest.approx(500000)


def test_summarize():
    v = pd.Series([100, 110, 99, 121.0], index=pd.date_range("2020-01-03", periods=4, freq="365D"))
    s = bt.summarize(v)
    assert s["max_drawdown"] == pytest.approx(-0.1) and s["cagr"] == pytest.approx(1.21 ** (365.25 / 1095) - 1, rel=1e-3)
