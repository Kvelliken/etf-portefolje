#!/usr/bin/env python3
"""Fase 4: optimering, frontier, bootstrap, walk-forward backtest og JSON-eksport til site/data/.

Bruk:
    python scripts/build_site.py                  # alt
    python scripts/build_site.py --no-backtest    # hopp over walk-forward (rask test)
    python scripts/build_site.py --bootstrap 20   # færre bootstrap-trekk (rask test)
"""
import argparse
import json
import logging
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from etfpf import export as ex  # noqa: E402
from etfpf import prices as pr  # noqa: E402
from etfpf.config import load_config, resolve  # noqa: E402


def pct(x):
    return "–" if x is None else f"{x * 100:.1f} %"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None)
    ap.add_argument("--db", default=None)
    ap.add_argument("--out", default=None, help="mappe for JSON (standard: paths.site_data)")
    ap.add_argument("--no-backtest", action="store_true")
    ap.add_argument("--bootstrap", type=int, default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("cvxpy").setLevel(logging.WARNING)

    cfg = load_config(args.config)
    oc = dict(cfg["optimize"])
    oc["prefer_accumulating"] = cfg["account"].get("prefer_accumulating", True)
    if args.bootstrap is not None:
        oc["bootstrap_samples"] = args.bootstrap
    pcfg = cfg["prices"]
    conn = sqlite3.connect(resolve(args.db or cfg["paths"]["db"]))
    root = resolve(cfg["paths"]["price_cache"])
    t0 = time.time()
    store = pr.PriceStore(root)
    fx = pr.PriceStore._read(root / "fx.parquet", ["date", "currency", "nok"])
    prices = pr.nok_prices(conn, store, fx, pcfg.get("spike_ratio", 1.3), pcfg.get("jump_ratio", 1.3))
    print(f"Priser: {prices.shape[1]} ETF-er til {prices.index.max().date()} ({time.time() - t0:.0f} s)")

    account = {"type": cfg["account"].get("type", "ASK"),
               "tax_warning": cfg["account"].get("type", "ASK") != "ASK"}
    model = ex.build_model(conn, prices, oc, account)
    print(f"Modell: {len(model['invest'])} representanter, kandidatsett {len(model['candidates'])}, "
          f"bootstrap {len(model['boot']['max_sharpe'])} trekk ({time.time() - t0:.0f} s)")
    bt_res = None
    if not args.no_backtest:
        bt_res = ex.run_backtest(model, oc)
        print(f"Backtest ferdig ({time.time() - t0:.0f} s)")
    else:
        bt_res = {"series": {}, "table": [], "frequency": [], "recommended": oc.get("recommended")}
    cov = json.loads((root / "coverage.json").read_text()) if (root / "coverage.json").exists() else {}
    urep_path = resolve(cfg["universe"].get("report_dir", "data/universe")) / "report.json"
    urep = json.loads(urep_path.read_text()) if urep_path.exists() else {}
    urep = {k: urep.get(k) for k in ("n_isins", "n_with_prices", "n_clusters", "n_multi_member_clusters",
                                     "n_eligible", "n_representatives", "te_threshold", "te_frequency")}
    out = resolve(args.out or cfg["paths"]["site_data"])
    if bt_res["series"]:
        ex.export_all(conn, model, bt_res, oc, account, cov, urep, out)
    else:
        print("(backtest hoppet over: backtest.json skrives ikke)")
        bt_res["series"] = {"reference": prices[oc["reference_isin"]].dropna().iloc[-10:]}
        ex.export_all(conn, model, bt_res, oc, account, cov, urep, out)

    print("\nPorteføljer (forventet avkastning / volatilitet / Sharpe / maks fall / avgift / antall):")
    for k, s in model["stats"].items():
        print(f"  {ex.LABELS[k]:16s} {pct(s['exp_return']):>8s} {pct(s['vol']):>8s}  {s['sharpe']:.2f}  "
              f"{pct(s['max_drawdown']):>8s}  {s['fee'] or 0:.2f} %  {s['n']}")
    rec = oc.get("recommended", "max_sharpe")
    w = model["weights"][rec]
    print(f"\nAnbefalt ({ex.LABELS[rec]}):")
    for i, x in w[w > 0].sort_values(ascending=False).items():
        print(f"  {x * 100:5.1f} %  {model['meta'].at[i, 'symbol']:8s} {model['meta'].at[i, 'name'][:60]}")
    if bt_res.get("table"):
        print(f"\nWalk-forward (ombalansering: {oc.get('backtest_rule', 'band')}, etter kostnader):")
        for t in bt_res["table"]:
            print(f"  {ex.LABELS.get(t['strategy'], t['strategy']):16s} CAGR {pct(t['cagr'])}  vol {pct(t['vol'])}  "
                  f"maks fall {pct(t['max_drawdown'])}  ({t['start']} – {t['end']})")
        print("\nOmbalanseringsfrekvens for anbefalt portefølje:")
        for t in bt_res["frequency"]:
            print(f"  {t['rule']:10s} CAGR {pct(t['cagr'])}  kostnad {t['costs_pct_per_year']:.2f} %/år  "
                  f"handler {t['trades_per_year']:.1f}/år  omsetning {t['turnover_per_year'] * 100:.0f} %/år")
    print(f"\nJSON skrevet til {out} ({time.time() - t0:.0f} s)")


if __name__ == "__main__":
    main()
