#!/usr/bin/env python3
"""Data til nettsiden: ETF-liste med klassifisering (sektor, region, tema, stil), månedlig
totalavkastning i NOK for alle ETF-er og risikofri rente. Nøkkeltall, optimering av eget utvalg og
backtest beregnes i nettleseren.

Bruk:
    python scripts/build_site.py              # skriver site/data/*.json
    python scripts/build_site.py --out /tmp/x # annen mappe
"""
import argparse
import json
import logging
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from etfpf import prices as pr  # noqa: E402
from etfpf import sitedata as sd  # noqa: E402
from etfpf.config import load_config, resolve  # noqa: E402

OLD_FILES = ["portfolios", "frontier", "stability", "risk", "backtest", "universe", "model"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None)
    ap.add_argument("--db", default=None)
    ap.add_argument("--out", default=None, help="mappe for JSON (standard: paths.site_data)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    cfg = load_config(args.config)
    pcfg = cfg["prices"]
    conn = sqlite3.connect(resolve(args.db or cfg["paths"]["db"]))
    root = resolve(cfg["paths"]["price_cache"])
    t0 = time.time()
    store = pr.PriceStore(root)
    fx = pr.PriceStore._read(root / "fx.parquet", ["date", "currency", "nok"])
    prices = pr.nok_prices(conn, store, fx, pcfg.get("spike_ratio", 1.3), pcfg.get("jump_ratio", 1.3))
    print(f"Priser: {prices.shape[1]} ETF-er til {prices.index.max().date()} ({time.time() - t0:.0f} s)")

    cov = json.loads((root / "coverage.json").read_text()) if (root / "coverage.json").exists() else {}
    urep_path = resolve(cfg["universe"].get("report_dir", "data/universe")) / "report.json"
    urep = json.loads(urep_path.read_text()) if urep_path.exists() else {}
    urep = {k: urep.get(k) for k in ("n_isins", "n_with_prices", "n_clusters", "n_multi_member_clusters",
                                     "n_eligible", "n_representatives", "te_threshold", "te_frequency")}
    out = resolve(args.out or cfg["paths"]["site_data"])
    info = sd.export(conn, prices, cfg, out, price_root=root, coverage=cov, universe_report=urep)
    for f in OLD_FILES:                       # filer fra den gamle modellen
        (out / f"{f}.json").unlink(missing_ok=True)
    print(f"{info['n_etfs']} ETF-er, {info['n_returns']} med månedsavkastning "
          f"({info['start']} – {info['end']}, {info['months']} måneder). Risikofri rente: {info['rf_source']}.")
    print(f"JSON skrevet til {out} ({time.time() - t0:.0f} s)")


if __name__ == "__main__":
    main()
