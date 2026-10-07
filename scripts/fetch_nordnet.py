#!/usr/bin/env python3
"""Henter ETF-listen fra Nordnet og lagrer den i SQLite (data/etf.db).

Bruk:
    python scripts/fetch_nordnet.py                     # full kjøring
    python scripts/fetch_nordnet.py --max-pages 1       # liten test (100 ETF-er, markerer ingenting som utgått)
    python scripts/fetch_nordnet.py --from-file side.html[.gz]   # test parsing av lagret side, skriver ikke til db
    python scripts/fetch_nordnet.py --from-raw data/raw/2026-10-01  # bygg kjøring fra lagret rå-HTML

Avslutter med kode 2 hvis sikkerhetssjekken slår ut (ingenting lagres).
"""
import argparse
import gzip
import json
import logging
import shutil
import sys
from collections import Counter
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from etfpf import db, nordnet  # noqa: E402
from etfpf.config import load_config, resolve  # noqa: E402


def read_html(path):
    path = Path(path)
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return f.read()
    return path.read_text(encoding="utf-8")


def field_report(rows):
    """Which raw fields exist and how often they are filled (for discovering new fields)."""
    counts = Counter()
    for r in rows:
        raw = json.loads(r["raw_json"])
        for k, v in nordnet.flatten(raw).items():
            if v not in (None, ""):
                counts[k] += 1
    return counts


def cmd_from_file(path, cfg):
    rows, total = nordnet.parse_page(read_html(path), cfg["account"]["ask_countries"])
    isins = {r["isin"] for r in rows if r["isin"]}
    print(f"total_hits={total}, rader={len(rows)}, unike ISIN={len(isins)}, "
          f"uten ISIN={sum(1 for r in rows if not r['isin'])}")
    print("\nNormaliserte felt (antall utfylt):")
    for col in list(nordnet.FIELD_CANDIDATES) + ["ask_eligible"]:
        n = sum(1 for r in rows if r.get(col) not in (None, ""))
        ex = next((r[col] for r in rows if r.get(col) not in (None, "")), None)
        print(f"  {col:18s} {n:4d}/{len(rows)}  eks: {ex!r}")
    print("\nAlle rå-felt i radene (antall utfylt):")
    for k, n in sorted(field_report(rows).items()):
        print(f"  {k:60s} {n}")
    print("\nFørste rader:")
    for r in rows[:5]:
        print(" ", r["instrument_id"], r["symbol"], r["isin"], r["currency"], r["clearing_place"],
              r["fee"], r["category"], r["name"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None)
    ap.add_argument("--db", default=None, help="overstyr databasefil")
    ap.add_argument("--max-pages", type=int, default=0, help="begrens antall sider (test, delvis kjøring)")
    ap.add_argument("--no-raw", action="store_true", help="ikke lagre rå-HTML")
    ap.add_argument("--from-file", help="parse én lagret HTML-fil og skriv ut resultatet")
    ap.add_argument("--from-raw", help="bygg en kjøring fra en mappe med lagret rå-HTML (page_*.html.gz)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    cfg = load_config(args.config)
    ncfg, ask = cfg["nordnet"], cfg["account"]["ask_countries"]
    if args.from_file:
        cmd_from_file(args.from_file, cfg)
        return

    raw_root = resolve(cfg["paths"]["raw_dir"])
    today = date.today().isoformat()
    staging = None
    if args.from_raw:
        found, total = {}, None
        for p in sorted(Path(args.from_raw).glob("page_*.html*")):
            rows, t = nordnet.parse_page(read_html(p), ask)
            total = total or t
            for r in rows:
                found.setdefault(r["instrument_id"], r)
        partial = bool(args.max_pages)
    else:
        staging = None if args.no_raw else raw_root / f".staging-{today}"
        if staging and staging.exists():
            shutil.rmtree(staging)
        try:
            found, total, _ = nordnet.scrape(ncfg, args.max_pages, staging, ask)
        except nordnet.FetchError as e:
            if staging:
                shutil.rmtree(staging, ignore_errors=True)
            sys.exit(f"FEIL: {e}")
        partial = bool(args.max_pages)

    if total and len(found) < total and not partial:
        print(f"MERKNAD: fikk {len(found)} av {total} ETF-er.")

    conn = db.connect(resolve(args.db or cfg["paths"]["db"]))
    try:
        res = db.store(conn, found, total, partial, ncfg["min_fraction_of_previous"])
    except db.SafetyCheckError as e:
        if staging:
            shutil.rmtree(staging, ignore_errors=True)
        print(f"FEIL (sikkerhetssjekk): {e}", file=sys.stderr)
        sys.exit(2)

    if staging and staging.exists():
        final = raw_root / today
        if final.exists():
            shutil.rmtree(final)
        staging.rename(final)
        for d in nordnet.prune_raw(raw_root, ncfg["raw_keep_months"]):
            print(f"Slettet gammel rå-HTML: {d}")

    n_isin = len({r["isin"] for r in found.values() if r["isin"]})
    print(f"\nKjøring {res['run_id']} ferdig{' (delvis)' if partial else ''}: "
          f"{len(found)} ETF-er hentet ({n_isin} unike ISIN), total_hits={total}.")
    print(f"Nye: {len(res['new'])} | Utgått: {len(res['gone'])} | Tilbake: {len(res['reappeared'])} "
          f"| Felt endret: {res['changed']}")
    if res["run_id"] > 1:
        for iid in res["new"][:20]:
            print("  NY:", found[iid]["isin"], found[iid]["symbol"], found[iid]["name"])
        for iid in res["gone"][:20]:
            print("  UTGÅTT:", *conn.execute(
                "SELECT isin, symbol, name FROM etf_master WHERE instrument_id=?", (iid,)).fetchone())
    # Machine-readable summary for the workflow commit message.
    summary = {"run_id": res["run_id"], "n_found": len(found), "new": len(res["new"]),
               "gone": len(res["gone"]), "reappeared": len(res["reappeared"]), "changed": res["changed"]}
    out = resolve("data/last_fetch.json")
    out.write_text(json.dumps(summary), encoding="utf-8")


if __name__ == "__main__":
    main()
