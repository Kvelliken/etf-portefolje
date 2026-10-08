#!/usr/bin/env python3
"""Fase 2: ISIN -> Yahoo-ticker (ticker_map) og prishistorikk i NOK (Parquet-cache).

Bruk:
    python scripts/build_prices.py                 # mapping (bare manglende/gamle) + prisoppdatering
    python scripts/build_prices.py --limit 50      # liten test på de 50 første ISIN-ene
    python scripts/build_prices.py --skip-mapping  # bare oppdater priser for eksisterende mapping
    python scripts/build_prices.py --remap         # slå opp alle ISIN-er på nytt
    python scripts/build_prices.py --full          # hent hele prishistorikken på nytt

Skriver dekningsrapport til data/prices/coverage.json. Avslutter med kode 3 hvis for mange
tickere feiler mot Yahoo (cachen overskrives da ikke).
"""
import argparse
import json
import logging
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from etfpf import prices as pr  # noqa: E402
from etfpf import tickers as tk  # noqa: E402
from etfpf.config import load_config, resolve  # noqa: E402
from etfpf.yahoo import Yahoo  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None)
    ap.add_argument("--db", default=None)
    ap.add_argument("--limit", type=int, default=0, help="bare de N første ISIN-ene (test)")
    ap.add_argument("--isin", action="append", help="bare disse ISIN-ene (kan gjentas)")
    ap.add_argument("--skip-mapping", action="store_true")
    ap.add_argument("--skip-prices", action="store_true")
    ap.add_argument("--remap", action="store_true", help="slå opp alle ISIN-er på nytt")
    ap.add_argument("--full", action="store_true", help="hent hele prishistorikken på nytt")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(message)s")
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    cfg = load_config(args.config)
    tcfg, pcfg = cfg["tickers"], cfg["prices"]
    pcfg = {**pcfg, "max_stale_days": tcfg.get("max_stale_days", 30)}
    conn = sqlite3.connect(resolve(args.db or cfg["paths"]["db"]))
    tk.ensure_schema(conn)
    yahoo = Yahoo(pcfg)
    threads = pcfg.get("threads", 4)

    if not args.skip_mapping:
        todo = tk.isins_to_map(conn, tcfg["recheck_days"], force=args.remap)
        if args.isin:
            todo = [i for i in todo if i in set(args.isin)]
        if args.limit:
            todo = todo[:args.limit]
        print(f"Ticker-mapping: {len(todo)} ISIN-er å slå opp")
        res = tk.map_tickers(conn, tcfg, yahoo, todo, threads=threads)
        print(f"  {sum(1 for v in res.values() if v)} av {len(res)} fikk ticker ({yahoo.n_calls} Yahoo-kall)")

    root = resolve(cfg["paths"]["price_cache"])
    chosen = tk.chosen_tickers(conn)
    if args.isin:
        chosen = {k: v for k, v in chosen.items() if k in set(args.isin)}
    if args.limit:
        chosen = dict(sorted(chosen.items())[:args.limit])
    store = pr.PriceStore(root)
    if not args.skip_prices:
        wanted = {t: cur for t, cur in chosen.values()}
        print(f"Priser: oppdaterer {len(wanted)} tickere ...")
        try:
            failed = pr.update_prices(conn, store, yahoo, wanted, pcfg, threads=threads, full=args.full)
        except pr.PriceUpdateError as e:
            print(f"FEIL: {e}", file=sys.stderr)
            sys.exit(3)
        for t, err in failed:
            tk.invalidate(conn, t, err)
        n = store.save()
        print(f"  {len(wanted) - len(failed)} oppdatert, {len(failed)} feilet, {n} Parquet-filer skrevet")

    currencies = {pr.currency_unit(c)[0] for _, c in chosen.values() if c}
    fx = pr.update_fx(root, currencies, pcfg, yahoo=yahoo)
    print(f"Valuta ({pcfg.get('fx_source')}): {sorted(set(fx['currency']))}, siste {fx['date'].max()}")

    quality = {}
    nok = pr.nok_prices(conn, store, fx, pcfg.get("spike_ratio", 1.3), pcfg.get("jump_ratio", 1.3),
                        quality=quality)
    cov = pr.coverage(conn, nok, pcfg.get("min_years_report", [1, 3, 5, 10]), quality=quality)
    (root / "coverage.json").write_text(json.dumps(cov, indent=1, ensure_ascii=False), encoding="utf-8")
    print("\nDekning:")
    print(json.dumps(cov, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
