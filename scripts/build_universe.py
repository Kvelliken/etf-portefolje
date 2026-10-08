#!/usr/bin/env python3
"""Fase 3: automatisk reduksjon av universet (dedup per ISIN, TE-klynging, representantvalg).

Bruk:
    python scripts/build_universe.py
    python scripts/build_universe.py --threshold 0.005   # overstyr TE-terskelen

Skriver tabellen `universe` (og `universe_history`) i data/etf.db, og klyngerapport i
data/universe/: clusters.csv (alle klynger > 1 medlem) og report.json (oppsummering,
tersklsensitivitet, navnekontroll og akseptansetester).
"""
import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from etfpf import prices as pr  # noqa: E402
from etfpf import universe as un  # noqa: E402
from etfpf.config import load_config, resolve  # noqa: E402

# Acceptance tests (section 4). Names are used here only to pick test cases, never for clustering.
SAME_CLUSTER = {"MSCI Korea": r"\bmsci korea\b", "MSCI Taiwan": r"\bmsci taiwan\b"}
NOT_TOGETHER = [("S&P 500", r"\bs&p 500\b(?!.*(equal|esg|screened|scored|paris|climate|swap|value|growth|"
                 r"dividend|momentum|quality|sector|ex\b|top|covered|buffer|information|financial|"
                 r"health|energy|industrial|consumer|utilit|material|communication|real estate))"),
                ("MSCI World", r"\bmsci world\b(?!.*(esg|sri|screened|paris|climate|ex\b|small|value|"
                 r"growth|momentum|quality|min|dividend|sector|equal|islamic|information|financial|"
                 r"health|energy|industrial|consumer|utilit|material|communication|real estate|"
                 r"select|enhanced|universal|socially))")]
CORE_PAIR = ("IE00B5BMR087", "IE00B4L5Y983")   # iShares Core S&P 500 vs iShares Core MSCI World


def acceptance(u, te_info):
    base = u[(u["hedged"] == 0) & (u["leveraged"] == 0) & u["has_prices"]]
    res = []
    for label, pat in SAME_CLUSTER.items():
        g = base[base["name"].str.contains(pat, case=False, regex=True)]
        cl = sorted(g["cluster_id"].unique().tolist())
        pairs = [(a, b, *un.te_between(te_info, a, b)) for k, a in enumerate(g.index) for b in g.index[k + 1:]]
        res.append({"test": f"Alle {label}-ETF-er i samme klynge", "ok": len(cl) == 1,
                    "members": [f"{i} {g.at[i, 'name']} (klynge {g.at[i, 'cluster_id']})" for i in g.index],
                    "pairwise_te_pct": [f"{a}/{b}: {t * 100:.2f} % ({n} mnd)" for a, b, t, n in pairs
                                        if t is not None]})
    (la, pa), (lb, pb) = NOT_TOGETHER
    ca = set(base[base["name"].str.contains(pa, case=False, regex=True)]["cluster_id"])
    cb = set(base[base["name"].str.contains(pb, case=False, regex=True)]["cluster_id"])
    both = sorted(ca & cb)
    res.append({"test": f"{la} og {lb} aldri i samme klynge", "ok": not both,
                "shared_clusters": [{"cluster_id": int(c), "names": u[u["cluster_id"] == c]["name"].tolist()}
                                    for c in both]})
    a, b = CORE_PAIR
    if a in u.index and b in u.index:
        t, n = un.te_between(te_info, a, b)
        res.append({"test": "iShares Core S&P 500 vs Core MSCI World i ulike klynger",
                    "ok": bool(u.at[a, "cluster_id"] != u.at[b, "cluster_id"]),
                    "te_pct": round(t * 100, 2) if t is not None else None, "weeks": n})
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None)
    ap.add_argument("--db", default=None)
    ap.add_argument("--threshold", type=float, default=None)
    args = ap.parse_args()

    cfg = load_config(args.config)
    ucfg = {**cfg["universe"], "prefer_accumulating": cfg["account"].get("prefer_accumulating", True)}
    if args.threshold:
        ucfg["te_threshold"] = args.threshold
    pcfg = cfg["prices"]
    conn = sqlite3.connect(resolve(args.db or cfg["paths"]["db"]))
    root = resolve(cfg["paths"]["price_cache"])
    store = pr.PriceStore(root)
    fx = pr.PriceStore._read(root / "fx.parquet", ["date", "currency", "nok"])
    print("Leser priser i NOK ...")
    nok = pr.nok_prices(conn, store, fx, pcfg.get("spike_ratio", 1.3), pcfg.get("jump_ratio", 1.3))
    print(f"  {nok.shape[1]} ETF-er, {nok.index.min().date()} – {nok.index.max().date()}")

    u, info, te_info = un.build(conn, nok, ucfg, cfg["account"].get("type", "ASK"))
    out = resolve(ucfg.get("report_dir", "data/universe"))
    out.mkdir(parents=True, exist_ok=True)
    rep = un.cluster_report(u)
    rep.to_csv(out / "clusters.csv", index=False, float_format="%.4f")
    acc = acceptance(u, te_info)
    report = {**info, "acceptance": acc, "name_control": un.name_control(u)}
    (out / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False, default=str),
                                     encoding="utf-8")

    print(f"\nISIN-er: {info['n_isins']} ({info['n_with_prices']} med priser, {info['n_periods']} perioder ({info['te_frequency']}))")
    print(f"Klynger ved TE {info['te_threshold'] * 100:.2f} %: {info['n_clusters']} "
          f"({info['n_multi_member_clusters']} med > 1 medlem)")
    print(f"Kvalifiserte: {info['n_eligible']}, representanter: {info['n_representatives']}")
    print("Tersklsensitivitet:", json.dumps(info["threshold_sensitivity"]))
    print(f"Navnekontroll: {len(report['name_control']['divergent_names_in_cluster'])} klynger med sprikende navn, "
          f"{len(report['name_control']['same_name_different_clusters'])} like navn i ulike klynger")
    print("\nAkseptansetester:")
    for r in acc:
        print(f"  [{'OK' if r['ok'] else 'FEIL'}] {r['test']}")
        for k in ("members", "pairwise_te_pct", "shared_clusters"):
            for x in r.get(k, [])[:12]:
                print("       ", x)
        if "te_pct" in r:
            print(f"        TE {r['te_pct']} % over {r['weeks']} perioder")
    if not all(r["ok"] for r in acc):
        print("\nADVARSEL: minst én akseptansetest feilet (se data/universe/report.json)")


if __name__ == "__main__":
    main()
