#!/usr/bin/env python3
"""Henter risikotall per fond fra Nordnet til data/fond.db (tabell fund_details).

Volatilitet, Sharpe, alfa og beta i NOK fra Nordnets fond-API; R² og tracking error (Morningstar, målt i
SEK) fra fondssiden. Se src/etfpf/funddetails.py. Fond hentet de siste `funds.details.refresh_days`
dagene hoppes over, så en avbrutt kjøring kan bare startes på nytt.

Bruk:
    python scripts/fetch_fund_details.py               # alle fond som trenger det (~915, ca. 40 min)
    python scripts/fetch_fund_details.py --limit 10    # test
    python scripts/fetch_fund_details.py --no-page     # bare API (raskt, uten R²)
"""
import argparse
import logging
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from etfpf import funddetails as fdet  # noqa: E402
from etfpf.config import load_config, resolve  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None)
    ap.add_argument("--db", default=None)
    ap.add_argument("--limit", type=int, default=0, help="maks antall fond (test)")
    ap.add_argument("--no-page", action="store_true", help="hopp over fondssiden (ingen R²/tracking error)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    cfg = load_config(args.config)
    dcfg = dict(cfg["nordnet"], **(cfg["funds"].get("details") or {}))
    conn = sqlite3.connect(resolve(args.db or cfg["funds"]["db"]))
    n = fdet.fetch_all(conn, dcfg, limit=args.limit, pages=not args.no_page and dcfg.get("pages", True))
    print(f"Ferdig: {n['todo']} fond, API ok {n['api_ok']}, fondsside ok {n['page_ok']}.")
    if n["todo"] and n["api_ok"] < 0.5 * n["todo"]:
        sys.exit("FEIL: under halvparten av API-kallene lyktes (har Nordnet endret API-et?)")


if __name__ == "__main__":
    main()
