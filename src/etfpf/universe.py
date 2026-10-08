"""Automatic reduction of the ETF universe (no manual selection).

Layer 1: one Nordnet listing per ISIN.
Layer 2: tracking error (TE) between all pairs on weekly NOK returns, hierarchical clustering with
         complete linkage on TE distance. Names are only used for a control report.
Layer 3: one representative per cluster by rules: hard filters, then lowest effective fee,
         largest fund, longest history. Hysteresis keeps last run's choice unless clearly beaten.
"""
import re
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform

SCHEMA = """
CREATE TABLE IF NOT EXISTS universe(
    isin TEXT PRIMARY KEY, instrument_id INTEGER, symbol TEXT, name TEXT, cluster_id INTEGER,
    cluster_size INTEGER, is_representative INTEGER, eligible INTEGER, reason TEXT, hedged INTEGER,
    leveraged INTEGER, accumulating INTEGER, history_years REAL, first_price_date TEXT, fee REAL,
    eff_fee REAL, fund_size REAL, number_of_owners REAL, category TEXT, max_te_in_cluster REAL,
    built_at TEXT);
CREATE TABLE IF NOT EXISTS universe_history(
    built_at TEXT, isin TEXT, cluster_id INTEGER, is_representative INTEGER);
"""
BIG = 10.0  # distance used when TE cannot be estimated (too little overlap): never merged

ISSUERS = ["ishares", "xtrackers", "amundi", "lyxor", "vanguard", "spdr", "invesco", "wisdomtree",
           "hsbc", "ubs", "franklin", "jpmorgan", "j.p. morgan", "l&g", "legal & general", "vaneck",
           "global x", "hanetf", "deka", "bnp paribas easy", "bnp", "xact", "fidelity", "pimco",
           "ossiam", "first trust", "dws", "db x-trackers", "comstage", "expat", "kraneshares",
           "rize", "tabula", "goldman sachs", "abrdn", "nomura", "ark", "blackrock"]
NAME_NOISE = r"\b(ucits|etf|acc|accumulating|accumulation|dist|distributing|distribution|inc|" \
             r"usd|eur|gbp|chf|sek|nok|jpy|dr|swap|ii|iii|iv|v|1c|1d|2c|2d|3c|4c|c|d|a|b|" \
             r"shares?|class|fund|plc|sicav|the|of|and|&|-|\(|\))\b"


def ensure_schema(conn):
    conn.executescript(SCHEMA)


# ---------------------------------------------------------------- layer 1

def listings(conn):
    """Active Nordnet listings with the latest snapshot's spread."""
    return pd.read_sql_query(
        """SELECT m.instrument_id, m.isin, m.symbol, m.name, m.currency, m.issuer_name, m.category,
                  m.fee, m.fund_size, m.number_of_owners, m.dividend_policy, m.is_tradable,
                  m.ask_eligible, s.spread_pct
           FROM etf_master m LEFT JOIN etf_snapshot s ON s.instrument_id = m.instrument_id
             AND s.run_id = (SELECT MAX(run_id) FROM etf_snapshot WHERE instrument_id = m.instrument_id)
           WHERE m.active = 1 AND m.isin IS NOT NULL""", conn)


def _truthy(v):
    return str(v).strip().lower() in ("1", "true", "yes")


def pick_listing(df, currency_pref):
    """One row per ISIN: tradable first, preferred currency, lowest spread, most owners."""
    rank = {c: i for i, c in enumerate(currency_pref)}
    d = df.assign(_trad=~df["is_tradable"].map(_truthy),
                  _cur=df["currency"].map(lambda c: rank.get(c, len(rank))),
                  _spr=df["spread_pct"].fillna(np.inf),
                  _own=-df["number_of_owners"].fillna(0))
    d = d.sort_values(["isin", "_trad", "_cur", "_spr", "_own", "instrument_id"])
    out = d.drop_duplicates("isin").drop(columns=["_trad", "_cur", "_spr", "_own"])
    # Owners across all listings of the ISIN is the better liquidity proxy.
    out["number_of_owners"] = out["isin"].map(df.groupby("isin")["number_of_owners"].sum(min_count=1))
    return out.set_index("isin")


def add_flags(u, cfg):
    exclude = re.compile(cfg["exclude_name_regex"], re.I)
    hedged = re.compile(cfg["hedged_name_regex"], re.I)
    u = u.copy()
    u["leveraged"] = (u["category"].isin(cfg.get("exclude_categories", [])) |
                      u["name"].fillna("").str.contains(exclude)).astype(int)
    u["hedged"] = u["name"].fillna("").str.contains(hedged).astype(int)
    u["accumulating"] = u["dividend_policy"].fillna("").str.lower().str.startswith("akk").astype(int)
    return u


# ---------------------------------------------------------------- layer 2

def period_returns(prices, rule="ME", smooth_days=1, window_periods=0):
    """Simple returns per period (W-FRI, ME, ...) from daily NOK prices. The last, incomplete
    period is dropped.

    smooth_days > 1: each period-end price is the average of the last `smooth_days` daily prices.
    Closing prices carry day-to-day noise (premium/discount to NAV for markets closed during
    European trading, spread, FX fixed at 14:15 vs closes at 17:30). That noise is independent
    from day to day and averages out, while the real tracking difference is kept.
    window_periods > 0: keep only the last N periods.
    """
    if prices.empty:
        return prices
    if smooth_days and smooth_days > 1:
        prices = prices.rolling(smooth_days, min_periods=max(2, smooth_days // 2)).mean()
    w = prices.resample(rule).last()
    if w.index[-1] > prices.index.max():
        w = w.iloc[:-1]
    r = w.pct_change(fill_method=None).iloc[1:]
    return r.iloc[-window_periods:] if window_periods else r


weekly_returns = period_returns  # backwards-compatible name


def robust_te(returns, pairs, periods=12, clip_sigma=4.0, batch=20000):
    """Robust TE for selected pairs: the return difference is winsorised at
    median ± clip_sigma·(1.4826·MAD) before taking the standard deviation, so a few bad months
    (data errors) do not dominate, while a genuine difference spread over many periods stays.
    pairs: int array (k, 2) of column positions. Returns (te, n) arrays of length k."""
    X = returns.to_numpy(float)
    te = np.full(len(pairs), np.nan)
    n = np.zeros(len(pairs), dtype=int)
    for s in range(0, len(pairs), batch):
        p = pairs[s:s + batch]
        D = X[:, p[:, 0]] - X[:, p[:, 1]]                    # T × B
        cnt = (~np.isnan(D)).sum(axis=0)
        with np.errstate(all="ignore"):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                med = np.nanmedian(D, axis=0)
                mad = 1.4826 * np.nanmedian(np.abs(D - med), axis=0)
            lo, hi = med - clip_sigma * mad, med + clip_sigma * mad
            Dc = np.clip(D, lo, hi)
            sd = np.nanstd(Dc, axis=0, ddof=1)
        te[s:s + batch] = sd * np.sqrt(periods)
        n[s:s + batch] = cnt
    te[n < 2] = np.nan
    return te, n


def te_matrix(returns, periods=52):
    """Annualised pairwise tracking error on overlapping observations only.

    TE²_ij = var(r_i − r_j) over weeks where both exist, computed for all pairs at once with
    masked matrix products (equivalent to var_i + var_j − 2·cov_ij on the common sample).
    Returns (TE, n_overlap) as N×N arrays; TE is NaN where fewer than 2 common weeks.
    """
    X = returns.to_numpy(float)
    M = (~np.isnan(X)).astype(float)
    X0 = np.nan_to_num(X)
    n = M.T @ M
    s1 = X0.T @ M                 # s1[i, j] = Σ x_i over weeks where both exist
    s2 = (X0 ** 2).T @ M
    p = X0.T @ X0
    with np.errstate(invalid="ignore", divide="ignore"):
        mean_d = (s1 - s1.T) / n
        ed2 = (s2 + s2.T - 2 * p) / n
        var = (ed2 - mean_d ** 2) * n / (n - 1)
        te = np.sqrt(np.clip(var, 0, None) * periods)
    te[n < 2] = np.nan
    np.fill_diagonal(te, 0.0)
    return te, n.astype(int)


def distance_matrix(te, n_overlap, min_overlap):
    d = np.where((n_overlap >= min_overlap) & np.isfinite(te), te, BIG)
    d = np.minimum(d, d.T)
    np.fill_diagonal(d, 0.0)
    return d


def cluster(dist, threshold):
    """Complete-linkage clusters: every pair inside a cluster has distance <= threshold."""
    if len(dist) == 1:
        return np.array([1])
    z = linkage(squareform(dist, checks=False), method="complete")
    return fcluster(z, t=threshold, criterion="distance")


def renumber(labels, keys):
    """Stable, readable cluster ids: largest clusters first, then by smallest member key."""
    groups = defaultdict(list)
    for lab, k in zip(labels, keys):
        groups[lab].append(k)
    order = sorted(groups, key=lambda g: (-len(groups[g]), min(groups[g])))
    new = {g: i + 1 for i, g in enumerate(order)}
    return np.array([new[l] for l in labels])


# ---------------------------------------------------------------- layer 3

def rank_key(r):
    size = r["fund_size"] if pd.notna(r["fund_size"]) else -1
    owners = r["number_of_owners"] if pd.notna(r["number_of_owners"]) else -1
    return (round(r["eff_fee"], 4), -size, -owners, -(r["history_years"] or 0), r.name)


def choose_representatives(u, cfg, previous=()):
    """Set is_representative and reason. `previous`: ISINs that were representatives last run."""
    u = u.copy()
    u["is_representative"] = 0
    u["reason"] = ""
    prev = set(previous)
    hyst = cfg.get("hysteresis_fee_pp", 0.05)
    for cid, g in u.groupby("cluster_id"):
        el = g[g["eligible"] == 1]
        if el.empty:
            continue
        ranked = sorted(el.index, key=lambda i: rank_key(el.loc[i]))
        best = ranked[0]
        held = [i for i in ranked if i in prev]
        choice, why = best, "lavest avgift" if len(el) > 1 else "eneste kvalifiserte"
        if len(el) > 1 and el.loc[best, "eff_fee"] == el.loc[ranked[1], "eff_fee"]:
            why = "lik avgift, størst fond/flest eiere"
        if held and held[0] != best:
            gain = el.loc[held[0], "eff_fee"] - el.loc[best, "eff_fee"]
            if gain >= hyst - 1e-9:
                why = f"byttet: {gain:.2f} pp lavere avgift enn forrige representant"
            else:
                choice, why = held[0], "beholdt forrige representant (hysterese)"
        elif held:
            why = "beholdt forrige representant"
        u.loc[choice, "is_representative"] = 1
        u.loc[choice, "reason"] = why
    for i in u.index[u["is_representative"] == 0]:
        r = u.loc[i]
        if r["eligible"] == 1:
            u.loc[i, "reason"] = "alternativ i klyngen"
        else:
            u.loc[i, "reason"] = r["ineligible_reason"]
    return u


def eligibility(u, cfg, account_type="ASK"):
    reasons = []
    for _, r in u.iterrows():
        why = []
        if not r.get("has_prices", True):
            why.append("mangler prisdata")
        elif (r["history_years"] or 0) < cfg["min_history_years"]:
            why.append(f"historikk {r['history_years'] or 0:.1f} år < {cfg['min_history_years']}")
        if not _truthy(r["is_tradable"]):
            why.append("ikke handlebar")
        if r["leveraged"]:
            why.append("giret/invers/handelsverktøy")
        if account_type == "ASK" and not _truthy(r["ask_eligible"]):
            why.append("ikke ASK-tillatt")
        reasons.append("; ".join(why))
    u = u.copy()
    u["ineligible_reason"] = reasons
    u["eligible"] = (u["ineligible_reason"] == "").astype(int)
    return u


# ---------------------------------------------------------------- name control

def normalize_name(name):
    s = (name or "").lower()
    for iss in ISSUERS:
        s = s.replace(iss, " ")
    s = re.sub(NAME_NOISE, " ", s)
    return " ".join(re.findall(r"[a-z0-9]+", s))


def name_control(u):
    """Clusters whose names diverge, and identical normalized names in different clusters."""
    u = u.assign(norm=u["name"].map(normalize_name))
    tok = {i: set(n.split()) for i, n in u["norm"].items()}
    spread = []
    for cid, g in u[u["cluster_size"] > 1].groupby("cluster_id"):
        ids = list(g.index)
        sims = [len(tok[a] & tok[b]) / max(1, len(tok[a] | tok[b]))
                for k, a in enumerate(ids) for b in ids[k + 1:]]
        if sims and min(sims) < 0.2:
            spread.append({"cluster_id": int(cid), "min_name_similarity": round(min(sims), 2),
                           "names": g["name"].tolist()})
    split = []
    for norm, g in u[u["norm"] != ""].groupby("norm"):
        # Same index in hedged and unhedged form should split: compare like with like.
        for h, gg in g.groupby("hedged"):
            if gg["cluster_id"].nunique() > 1:
                split.append({"normalized_name": norm, "hedged": int(h),
                              "members": [{"isin": i, "name": r["name"], "cluster_id": int(r["cluster_id"])}
                                          for i, r in gg.iterrows()]})
    return {"divergent_names_in_cluster": spread, "same_name_different_clusters": split}


# ---------------------------------------------------------------- orchestration

def build(conn, prices, cfg, account_type="ASK", now=None):
    """Run all three layers. Returns (universe DataFrame indexed by ISIN, info dict)."""
    ensure_schema(conn)
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    u = pick_listing(listings(conn), cfg.get("listing_currency_preference", ["NOK", "EUR"]))
    u = add_flags(u, cfg)

    prices = prices.reindex(columns=[c for c in prices.columns if c in u.index])
    first = prices.apply(lambda s: s.first_valid_index())
    last = prices.index.max() if len(prices) else None
    u["has_prices"] = u.index.isin(prices.columns)
    u["first_price_date"] = [first[i].date().isoformat() if i in first.index and pd.notna(first[i]) else None
                             for i in u.index]
    u["history_years"] = [round((last - first[i]).days / 365.25, 2) if i in first.index and pd.notna(first[i])
                          else 0.0 for i in u.index]
    u["eff_fee"] = u["fee"].fillna(9.99) + np.where(
        cfg.get("prefer_accumulating", True) & (u["accumulating"] == 0), cfg.get("dist_fee_penalty", 0.1), 0.0)

    rule = cfg.get("te_frequency", "ME")
    periods = {"W-FRI": 52, "W": 52, "ME": 12, "M": 12, "QE": 4}.get(rule, 12)
    R = period_returns(prices, rule, cfg.get("te_smooth_days", 1), cfg.get("te_window_periods", 0))
    te, n = te_matrix(R, periods)
    if cfg.get("robust_te", True):
        # Refine pairs that could plausibly be close (plain TE is inflated by outliers, never deflated
        # by more than the clipping removes): robust TE for all pairs under a generous cap.
        cap = cfg.get("robust_prefilter_te", 0.25)
        iu = np.argwhere(np.triu((te < cap) & (n >= cfg.get("min_overlap", 24)), k=1))
        if len(iu):
            rte, rn = robust_te(R, iu, periods, cfg.get("robust_clip_sigma", 4.0))
            te[iu[:, 0], iu[:, 1]] = rte
            te[iu[:, 1], iu[:, 0]] = rte
    dist = distance_matrix(te, n, cfg.get("min_overlap", 24))
    isins = list(R.columns)
    pos = {i: k for k, i in enumerate(isins)}

    def labels_for(th):
        lab = dict(zip(isins, cluster(dist, th))) if isins else {}
        nxt = max(lab.values(), default=0) + 1
        out = []
        for i in u.index:           # ISINs without prices are singletons
            if i not in lab:
                lab[i] = nxt
                nxt += 1
            out.append(lab[i])
        return renumber(np.array(out), list(u.index))

    th = cfg["te_threshold"]
    u["cluster_id"] = labels_for(th)
    u["cluster_size"] = u.groupby("cluster_id")["cluster_id"].transform("size")
    max_te = {}
    for cid, g in u.groupby("cluster_id"):
        idx = [pos[i] for i in g.index if i in pos]
        sub = dist[np.ix_(idx, idx)] if len(idx) > 1 else np.zeros((1, 1))
        max_te[cid] = float(sub.max())
    u["max_te_in_cluster"] = u["cluster_id"].map(max_te)

    u = eligibility(u, cfg, account_type)
    prev = [r[0] for r in conn.execute("SELECT isin FROM universe WHERE is_representative=1")]
    u = choose_representatives(u, cfg, prev)

    sensitivity = {}
    for t in cfg.get("te_thresholds_report", [th]):
        lab = labels_for(t) if t != th else u["cluster_id"].to_numpy()
        s = pd.Series(lab, index=u.index)
        el = u["eligible"] == 1
        sensitivity[f"{t:.4f}"] = {"clusters": int(s.nunique()),
                                   "clusters_with_eligible": int(s[el].nunique()),
                                   "multi_member_clusters": int((s.value_counts() > 1).sum())}

    cols = ["instrument_id", "symbol", "name", "cluster_id", "cluster_size", "is_representative", "eligible",
            "reason", "hedged", "leveraged", "accumulating", "history_years", "first_price_date", "fee",
            "eff_fee", "fund_size", "number_of_owners", "category", "max_te_in_cluster"]
    with conn:
        conn.execute("DELETE FROM universe")
        conn.executemany(f"INSERT INTO universe VALUES({','.join('?' * (len(cols) + 2))})",
                         [[i] + [_py(u.at[i, c]) for c in cols] + [now] for i in u.index])
        conn.executemany("INSERT INTO universe_history VALUES(?,?,?,?)",
                         [(now, i, int(u.at[i, "cluster_id"]), int(u.at[i, "is_representative"])) for i in u.index])
    info = {"built_at": now, "n_isins": int(len(u)), "n_with_prices": int(u["has_prices"].sum()),
            "n_periods": int(len(R)), "te_frequency": rule, "te_threshold": th,
            "n_clusters": int(u["cluster_id"].nunique()),
            "n_multi_member_clusters": int((u.groupby("cluster_id").size() > 1).sum()),
            "n_eligible": int(u["eligible"].sum()), "n_representatives": int(u["is_representative"].sum()),
            "threshold_sensitivity": sensitivity}
    return u, info, (te, n, isins)


def _py(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return None if np.isnan(v) else float(v)
    if v is pd.NA or (isinstance(v, float) and np.isnan(v)):
        return None
    return v


def cluster_report(u, te_info=None):
    """Rows for all clusters with more than one member (CSV-friendly)."""
    m = u[u["cluster_size"] > 1].copy()
    m["isin"] = m.index
    cols = ["cluster_id", "cluster_size", "max_te_in_cluster", "isin", "symbol", "name", "is_representative",
            "eligible", "reason", "fee", "eff_fee", "accumulating", "hedged", "history_years", "fund_size",
            "number_of_owners", "category"]
    return m.sort_values(["cluster_size", "cluster_id", "is_representative", "eff_fee"],
                         ascending=[False, True, False, True])[cols]


def te_between(te_info, a, b):
    te, n, isins = te_info
    pos = {i: k for k, i in enumerate(isins)}
    if a not in pos or b not in pos:
        return None, 0
    return float(te[pos[a], pos[b]]), int(n[pos[a], pos[b]])
