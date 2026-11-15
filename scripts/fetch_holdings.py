#!/usr/bin/env python3
"""Henter hva hvert fond og hver ETF eier (region, sektor, aktivaklasse, største beholdninger) fra Nordnet
til data/holdings.db. Se src/etfpf/holdings.py. Fond/ETF-er hentet de siste `funds.holdings.refresh_days`
dagene hoppes over, så en avbrutt kjøring kan bare startes på nytt.

Bruk:
    python scripts/fetch_holdings.py               # alle fond og ETF-er som trenger det (~3200, ca. 15 min)
    python scripts/fetch_holdings.py --limit 20    # test
"""
import argparse
import logging
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from etfpf import holdings as hd  # noqa: E402
from etfpf.config import load_config, resolve  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None)
    ap.add_argument("--limit", type=int, default=0, help="maks antall fond/ETF-er (test)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    cfg = load_config(args.config)
    hcfg = dict(cfg["nordnet"], **cfg["funds"]["holdings"])
    items = []
    for kind, db in (("fond", cfg["funds"]["db"]), ("etf", cfg["paths"]["db"])):
        if resolve(db).exists():
            items += hd.instruments(sqlite3.connect(resolve(db)), kind)
    hconn = hd.connect(resolve(hcfg["db"]))
    n = hd.fetch_all(hconn, items, hcfg, limit=args.limit)
    names = hd.fetch_names(hconn, hcfg)
    print(f"Ferdig: {n['todo']} fond/ETF-er, ok {n['ok']}. Navn: {names['found']} av {names['asked']} nye beholdninger.")
    if n["todo"] and n["ok"] < 0.5 * n["todo"]:
        sys.exit("FEIL: under halvparten av kallene lyktes (har Nordnet endret API-et?)")


if __name__ == "__main__":
    main()
