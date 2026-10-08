"""Portfolio optimisation: risk model, expected returns, constrained portfolios, frontier, bootstrap.

Library choice: PyPortfolioOpt for the Ledoit-Wolf covariance, an own HRP, and a small cvxpy QP
for everything with constraints (weight caps, category caps, fee cap). PyPortfolioOpt's own
max_sharpe rescales the weights internally, which breaks custom constraints such as a fee cap,
so max Sharpe is found as the best point along the constrained frontier instead.

Expected returns are NOT naive historical means (they amplify estimation error): a CAPM-like
prior rf + beta * premium (beta against the reference) with the historical mean shrunk into it
(Black-Litterman in spirit, with market-equilibrium as the prior).
"""
import logging
from dataclasses import dataclass, field

import cvxpy as cp
import numpy as np
import pandas as pd
from pypfopt import risk_models

log = logging.getLogger(__name__)
PERIODS = 52


# ---------------------------------------------------------------- estimation

def weekly_returns(prices, smooth_days=1, rule="W-FRI"):
    """Weekly returns from daily NOK prices; incomplete last week dropped."""
    if smooth_days and smooth_days > 1:
        prices = prices.rolling(smooth_days, min_periods=max(2, smooth_days // 2)).mean()
    w = prices.resample(rule).last()
    if len(w) and w.index[-1] > prices.index.max():
        w = w.iloc[:-1]
    return w.pct_change(fill_method=None).iloc[1:]


def window(returns, end=None, weeks=260, min_coverage=0.9):
    """Last `weeks` rows up to `end`; keep columns with at least min_coverage data, fill the
    few gaps with 0 (missing quote weeks)."""
    r = returns if end is None else returns[returns.index <= end]
    r = r.iloc[-weeks:]
    if len(r) < weeks:
        return r.iloc[:, :0]
    keep = r.columns[r.notna().mean() >= min_coverage]
    return r[keep].fillna(0.0)


def ledoit_wolf(r):
    """Annualised Ledoit-Wolf shrunk covariance (PyPortfolioOpt)."""
    s = risk_models.CovarianceShrinkage(r, returns_data=True, frequency=PERIODS).ledoit_wolf()
    return s.loc[r.columns, r.columns]


def expected_returns(r, ref, rf, premium, history_weight, S=None):
    """mu = (1 - h) * (rf + beta * premium) + h * historical mean (annualised).

    `ref` is the reference column name in `r` (or a Series). With S (the shrunk covariance
    including the reference) beta_i = S[i, ref] / S[ref, ref]; the prior is then exactly the
    equilibrium return of holding the reference, so with h = 0 the max-Sharpe portfolio is the
    reference itself and any deviation comes from the (shrunk) historical evidence."""
    if isinstance(ref, str) and S is not None:
        beta = S[ref] / S.loc[ref, ref]
    else:
        ref = (r[ref] if isinstance(ref, str) else ref).reindex(r.index).fillna(0.0)
        var_ref = ref.var()
        beta = r.apply(lambda c: c.cov(ref)) / var_ref if var_ref > 0 else pd.Series(1.0, index=r.columns)
    beta = beta.reindex(r.columns)
    prior = rf + beta * premium
    hist = r.mean() * PERIODS
    return (1 - history_weight) * prior + history_weight * hist, beta


# ---------------------------------------------------------------- constrained QP

@dataclass
class Constraints:
    max_weight: float = 0.2
    groups: dict = field(default_factory=dict)     # name -> (list of asset positions, cap)
    fees: np.ndarray = None                         # % per asset
    max_fee: float = None

    @classmethod
    def build(cls, assets, meta, cfg):
        groups = {}
        cap = cfg.get("max_category_weight")
        if cap:
            cats = meta.reindex(assets)["category"].fillna("Ukjent")
            for c in cats.unique():
                groups[c] = ([i for i, a in enumerate(assets) if cats[a] == c], cap)
        fees = meta.reindex(assets)["fee"].fillna(meta["fee"].median()).to_numpy(float)
        return cls(cfg.get("max_weight", 0.2), groups, fees, cfg.get("max_portfolio_fee"))

    def subset(self, pos):
        """Constraints restricted to asset positions `pos` (in that order)."""
        m = {p: k for k, p in enumerate(pos)}
        groups = {g: ([m[i] for i in idx if i in m], cap) for g, (idx, cap) in self.groups.items()}
        return Constraints(self.max_weight, {g: v for g, v in groups.items() if v[0]},
                           None if self.fees is None else self.fees[pos], self.max_fee)

    def feasible(self, n):
        if n * self.max_weight < 1 - 1e-9:
            return False
        if self.groups:
            grouped = {i for idx, _ in self.groups.values() for i in idx}
            caps = sum(min(cap, len(idx) * self.max_weight) for idx, cap in self.groups.values())
            caps += (n - len(grouped)) * self.max_weight
            if caps < 1 - 1e-9:
                return False
        return True


class Infeasible(RuntimeError):
    pass


def solve(mu, S, con, objective="min_variance", target=None):
    """min w'Sw (or max mu'w) s.t. sum w = 1, 0 <= w <= max_weight, group caps, fee cap,
    and mu'w >= target. Returns weights (np.array)."""
    n = len(mu)
    if not con.feasible(n):
        raise Infeasible(f"{n} aktiva kan ikke oppfylle begrensningene")
    w = cp.Variable(n)
    c = [cp.sum(w) == 1, w >= 0, w <= con.max_weight]
    for idx, cap in con.groups.values():
        if len(idx) * con.max_weight > cap:
            c.append(cp.sum(w[idx]) <= cap)
    if con.max_fee is not None and con.fees is not None:
        c.append(con.fees @ w <= con.max_fee)
    if target is not None:
        c.append(mu @ w >= target)
    if objective == "max_return":
        prob = cp.Problem(cp.Maximize(mu @ w), c)
    else:
        prob = cp.Problem(cp.Minimize(cp.quad_form(w, cp.psd_wrap(S))), c)
    try:
        prob.solve(solver="CLARABEL")
    except cp.SolverError:
        prob.solve(solver="SCS")
    if w.value is None or prob.status not in ("optimal", "optimal_inaccurate"):
        raise Infeasible(prob.status)
    x = np.clip(np.asarray(w.value).ravel(), 0, None)
    x[x < 1e-7] = 0
    return x / x.sum()


def perf(w, mu, S, rf):
    ret = float(mu @ w)
    vol = float(np.sqrt(max(w @ S @ w, 0)))
    return ret, vol, (ret - rf) / vol if vol > 0 else np.nan


def max_sharpe(mu, S, con, rf):
    """Max Sharpe ratio under all constraints as one convex QP (Cornuejols-Tütüncü transform):
    with y = k·w, k >= 0: minimise y'Sy s.t. (mu - rf)'y = 1, sum y = k, 0 <= y <= max_weight·k,
    group sums <= cap·k, fees'y <= max_fee·k. Then w = y / k. Every linear constraint on w is
    scaled by k, so caps and the fee cap hold exactly (PyPortfolioOpt does not scale custom ones).
    Falls back to min variance when no asset beats the risk-free rate."""
    n = len(mu)
    if not con.feasible(n):
        raise Infeasible(f"{n} aktiva kan ikke oppfylle begrensningene")
    if (mu <= rf).all():
        return solve(mu, S, con)
    y, k = cp.Variable(n), cp.Variable()
    c = [(mu - rf) @ y == 1, cp.sum(y) == k, y >= 0, y <= con.max_weight * k, k >= 0]
    for idx, cap in con.groups.values():
        if len(idx) * con.max_weight > cap:
            c.append(cp.sum(y[idx]) <= cap * k)
    if con.max_fee is not None and con.fees is not None:
        c.append(con.fees @ y <= con.max_fee * k)
    prob = cp.Problem(cp.Minimize(cp.quad_form(y, cp.psd_wrap(S))), c)
    try:
        prob.solve(solver="CLARABEL")
    except cp.SolverError:
        prob.solve(solver="SCS")
    if y.value is None or prob.status not in ("optimal", "optimal_inaccurate") or not k.value or k.value <= 0:
        raise Infeasible(prob.status)
    x = np.clip(np.asarray(y.value).ravel() / float(k.value), 0, None)
    x[x < 1e-7] = 0
    return x / x.sum()


def frontier(mu, S, con, rf, points=50):
    """Continuous efficient frontier (no min-weight / max-count): list of dicts."""
    w_min = solve(mu, S, con)
    lo, hi = float(mu @ w_min), float(mu @ solve(mu, S, con, "max_return"))
    out = []
    for t in np.linspace(lo, hi - 1e-7, points):
        try:
            w = solve(mu, S, con, target=t) if t > lo else w_min
        except Infeasible:
            continue
        r, v, s = perf(w, mu, S, rf)
        out.append({"ret": r, "vol": v, "sharpe": s, "w": w})
    return out


# ---------------------------------------------------------------- risk parity / HRP

def erc(S, max_weight=1.0, iters=50):
    """Equal risk contribution weights (convex log-barrier formulation), then capped."""
    n = len(S)
    y = cp.Variable(n)
    prob = cp.Problem(cp.Minimize(0.5 * cp.quad_form(y, cp.psd_wrap(S)) - cp.sum(cp.log(y)) / n), [y >= 1e-8])
    prob.solve(solver="CLARABEL")
    w = np.asarray(y.value).ravel()
    w = w / w.sum()
    return cap_weights(w, max_weight)


def cap_weights(w, max_weight, iters=100):
    """Clip to max_weight and spread the excess proportionally over the others."""
    w = np.asarray(w, float).copy()
    if len(w) * max_weight < 1:
        return w / w.sum()
    for _ in range(iters):
        over = w > max_weight + 1e-12
        if not over.any():
            break
        excess = (w[over] - max_weight).sum()
        w[over] = max_weight
        free = ~over & (w < max_weight)
        w[free] += excess * w[free] / w[free].sum()
    return w / w.sum()


def cap_groups(w, groups, max_weight):
    """Apply group caps by scaling down groups above their cap and redistributing."""
    w = w.copy()
    for _ in range(50):
        changed = False
        for idx, cap in groups.values():
            s = w[idx].sum()
            if s > cap + 1e-9:
                w[idx] *= cap / s
                others = np.setdiff1d(np.arange(len(w)), idx)
                w[others] += (s - cap) * w[others] / w[others].sum()
                changed = True
        w = cap_weights(w, max_weight)
        if not changed:
            break
    return w


def hrp(r, cov=None):
    """Hierarchical Risk Parity (López de Prado 2016): single-linkage tree on correlation
    distance sqrt((1 - rho) / 2), quasi-diagonal ordering, recursive bisection with
    inverse-variance cluster weights. Implemented here because PyPortfolioOpt's HRPOpt relies on
    a private scipy attribute that newer scipy versions removed."""
    from scipy.cluster.hierarchy import leaves_list, linkage
    from scipy.spatial.distance import squareform
    cov = np.asarray(r.cov() if cov is None else cov, float)
    sd = np.sqrt(np.diag(cov))
    corr = np.clip(cov / np.outer(sd, sd), -1, 1)
    n = len(cov)
    if n == 1:
        return np.ones(1)
    dist = np.sqrt(np.clip((1 - corr) / 2, 0, None))
    np.fill_diagonal(dist, 0)
    order = list(leaves_list(linkage(squareform(dist, checks=False), method="single")))
    w = np.ones(n)

    def cluster_var(idx):
        c = cov[np.ix_(idx, idx)]
        ivp = 1 / np.diag(c)
        ivp /= ivp.sum()
        return float(ivp @ c @ ivp)

    stack = [order]
    while stack:
        items = stack.pop()
        if len(items) < 2:
            continue
        half = len(items) // 2
        left, right = items[:half], items[half:]
        vl, vr = cluster_var(left), cluster_var(right)
        alpha = 1 - vl / (vl + vr)
        w[left] *= alpha
        w[right] *= 1 - alpha
        stack += [left, right]
    return w / w.sum()


# ---------------------------------------------------------------- sparsity (min weight / max count)

def sparse_weights(kind, mu, S, con, rf, cfg, order_hint=None, returns=None):
    """Solve `kind` and iteratively drop small positions: weights below min_weight are removed
    and at most max_assets kept, then re-solved on the remaining set until stable.
    Returns full-length weights."""
    min_w, max_n = cfg.get("min_weight", 0.02), cfg.get("max_assets", 10)
    n = len(mu)
    active = np.arange(n)

    def run(pos):
        sub = con.subset(list(pos))
        m, s = mu[pos], S[np.ix_(pos, pos)]
        if kind == "max_sharpe":
            w = max_sharpe(m, s, sub, rf)
        elif kind == "min_variance":
            w = solve(m, s, sub)
        elif kind == "risk_parity":
            w = cap_groups(erc(s, sub.max_weight), sub.groups, sub.max_weight)
        elif kind == "hrp":
            w = cap_groups(cap_weights(hrp(returns.iloc[:, pos], s), sub.max_weight), sub.groups, sub.max_weight)
        else:
            raise ValueError(kind)
        full = np.zeros(n)
        full[pos] = w
        return full

    w = run(active)
    for _ in range(n + 5):
        nz = np.flatnonzero(w > 1e-6)
        ok = (w[nz] >= min_w - 1e-6).all() and len(nz) <= max_n
        if ok:
            break
        ranked = nz[np.argsort(-w[nz])]
        if kind in ("risk_parity", "hrp"):
            keep = ranked[:-1] if len(ranked) > max_n or w[ranked[-1]] < min_w else ranked
        else:
            keep = [i for i in ranked if w[i] >= min_w][:max_n]
        keep = _make_feasible(list(keep), list(ranked) + list(order_hint if order_hint is not None else []),
                              con)
        try:
            w_new = run(np.array(sorted(keep)))
        except Infeasible:
            break
        if np.allclose(w_new, w):
            break
        w = w_new
    return w


def _make_feasible(keep, candidates, con):
    keep = list(dict.fromkeys(keep))
    for c in candidates:
        if con.subset(sorted(keep)).feasible(len(keep)):
            break
        if c not in keep:
            keep.append(c)
    return keep


# ---------------------------------------------------------------- bootstrap

def block_bootstrap_index(n, block, rng):
    idx = []
    while len(idx) < n:
        start = rng.integers(0, n - block + 1)
        idx.extend(range(start, start + block))
    return np.array(idx[:n])


def bootstrap(r, ref, cfg, con, rf, samples=200, block=8, points=20, seed=42):
    """Resample weekly returns in blocks; for each sample re-estimate mu and LW covariance and
    compute the continuous frontier, max-Sharpe and min-variance weights."""
    rng = np.random.default_rng(seed)
    out = {"frontiers": [], "max_sharpe": [], "min_variance": []}
    for k in range(samples):
        idx = block_bootstrap_index(len(r), block, rng)
        rb = r.iloc[idx].reset_index(drop=True)
        Sdf = ledoit_wolf(rb)
        if isinstance(ref, str):
            mu, _ = expected_returns(rb, ref, rf, cfg["market_risk_premium"], cfg["history_weight"], Sdf)
        else:
            refb = ref.reindex(r.index).fillna(0).iloc[idx].reset_index(drop=True)
            mu, _ = expected_returns(rb, refb, rf, cfg["market_risk_premium"], cfg["history_weight"])
        S = Sdf.to_numpy()
        m = mu.to_numpy()
        try:
            fr = frontier(m, S, con, rf, points)
            out["frontiers"].append([(p["vol"], p["ret"]) for p in fr])
            out["max_sharpe"].append(max_sharpe(m, S, con, rf))
            out["min_variance"].append(solve(m, S, con))
        except Infeasible:
            continue
        if (k + 1) % 50 == 0:
            log.info("Bootstrap %d/%d", k + 1, samples)
    return out


def frontier_band(frontiers, vol_grid, q=(10, 50, 90)):
    """Percentiles of the resampled frontiers' returns at each volatility level."""
    rows = []
    for v in vol_grid:
        vals = []
        for f in frontiers:
            f = sorted(f)
            vs, rs = zip(*f)
            if vs[0] <= v <= vs[-1]:
                vals.append(np.interp(v, vs, rs))
        rows.append([float(np.percentile(vals, p)) if len(vals) >= 10 else None for p in q])
    return rows


# ---------------------------------------------------------------- portfolio statistics

def drawdown(values):
    peak = values.cummax()
    return values / peak - 1


def portfolio_series(prices, weights):
    """Daily NOK value of a buy-and-rebalance-weekly portfolio (weights constant), from the
    first date all holdings have prices."""
    cols = [c for c, w in weights.items() if w > 0]
    p = prices[cols].dropna(how="all")
    start = p.apply(lambda s: s.first_valid_index()).max()
    p = p[p.index >= start].ffill()
    r = p.pct_change().fillna(0.0)
    w = pd.Series(weights)[cols]
    return (1 + r @ w).cumprod()
