#!/usr/bin/env python3
"""Måler hvor mange av Nordnets fond som har brukbar kurshistorikk hos Yahoo.

Forutsetter at fondslisten er hentet:  python scripts/fetch_nordnet.py --fond

Bruk:
    python scripts/probe_fund_history.py                # stratifisert utvalg (funds.probe.sample i config)
    python scripts/probe_fund_history.py --sample 0     # alle fond (tregt: ca. 1–2 s per ISIN)
    python scripts/probe_fund_history.py --no-figi      # hopp over OpenFIGI (finner sjelden unoterte fond)
    python scripts/probe_fund_history.py --remap        # slå opp tickere på nytt selv om de er ferske

For hvert fond i utvalget:
  1. ticker-oppslag som for ETF-ene (Nordnet-symbol, Yahoo-søk på ISIN, OpenFIGI), lagret i
     ticker_map i fonddatabasen så det kan gjenbrukes senere,
  2. historikklengde (måneder med kurs) og om den dekker fondets startdato,
  3. kontroll av andelsklasse: Yahoos kursavkastning 1 og 3 år og siste kurs mot Nordnets tall.

Skriver funds.probe.report_dir/probe_report.json (sammendrag) og probe_details.csv (per ISIN).
"""
import argparse
import json
import logging
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from etfpf import db, fundprobe as fp, tickers as tk  # noqa: E402
from etfpf.config import load_config, resolve  # noqa: E402
from etfpf.prices import fetch_ticker  # noqa: E402
from etfpf.yahoo import Yahoo, YahooError  # noqa: E402

log = logging.getLogger("probe_fund_history")


def mapping_rows(conn, isins):
    """{isin: chosen ticker_map row or the first failed row (for the error)}."""
    want, out = set(isins), {}
    cols = ["isin", "yahoo_ticker", "source", "ok", "chosen", "currency", "exchange", "yahoo_name",
            "first_date", "last_date", "n_months", "error"]
    q = f"SELECT {', '.join(cols)} FROM ticker_map ORDER BY isin, chosen DESC, ok DESC"
    for r in conn.execute(q):
        d = dict(zip(cols, r))
        if d["isin"] in want:
            out.setdefault(d["isin"], d)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=None)
    ap.add_argument("--db", default=None, help="fonddatabase (standard funds.db)")
    ap.add_argument("--sample", type=int, default=None, help="antall ISIN-er (0 = alle)")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--threads", type=int, default=None)
    ap.add_argument("--no-figi", action="store_true", help="ikke bruk OpenFIGI")
    ap.add_argument("--remap", action="store_true", help="slå opp alle tickere i utvalget på nytt")
    ap.add_argument("--out", default=None, help="mappe for rapporten (standard funds.probe.report_dir)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    cfg = load_config(args.config)
    pcfg, tcfg = cfg["funds"]["probe"], cfg["tickers"]
    db_path = resolve(args.db or cfg["funds"]["db"])
    if not db_path.exists():
        sys.exit(f"Fant ikke {db_path}. Hent fondslisten først: python scripts/fetch_nordnet.py --fond")
    conn = db.connect(db_path)
    tk.ensure_schema(conn)
    rows = fp.latest_rows(conn)
    if not rows:
        sys.exit(f"Ingen aktive fond i {db_path}.")
    n = pcfg["sample"] if args.sample is None else args.sample
    sample = fp.stratified_sample(rows, n, args.seed if args.seed is not None else pcfg["seed"])
    isins = [r["isin"] for r in sample]
    log.info("%d aktive fond (unike ISIN), utvalg %d", len(rows), len(isins))

    yahoo = Yahoo(cfg["prices"])
    threads = args.threads or cfg["prices"].get("threads", 4)
    todo = isins if args.remap else sorted(set(isins) & set(tk.isins_to_map(conn, tcfg["recheck_days"])))
    log.info("Ticker-oppslag for %d ISIN-er (%d gjenbrukt)", len(todo), len(isins) - len(todo))
    figi = (lambda _isins, _cfg: {}) if args.no_figi else None
    if todo:
        tk.map_tickers(conn, tcfg, yahoo, todo, threads=threads, figi_lookup=figi)

    maps = mapping_rows(conn, isins)
    starts = tk.fund_starts(conn)
    since = date.today() - timedelta(days=pcfg["history_days"])

    def check(row):
        m = maps.get(row["isin"]) or {}
        rec = {k: row.get(k) for k in ("isin", "name", "fund_type", "category", "domicile", "issuer_name",
                                       "currency", "start_date", "yield_1y", "yield_3y", "price")}
        chosen = m.get("chosen") and m.get("ok")
        rec.update(ticker=m.get("yahoo_ticker") if chosen else None, source=m.get("source") if chosen else None,
                   exchange=m.get("exchange") if chosen else None, yahoo_name=m.get("yahoo_name") if chosen else None,
                   first_date=m.get("first_date") if chosen else None,
                   n_months=m.get("n_months") if chosen else None,
                   error=None if chosen else (m.get("error") or "ikke slått opp"))
        if not chosen:
            rec.update(status=None, years=0, covers_start=False)
            return rec
        rec["years"] = round((m.get("n_months") or 0) / 12, 1)
        rec["covers_start"] = tk.covers_start(m, starts.get(row["isin"]), tcfg.get("start_slack_days", 120),
                                              str(tcfg.get("yahoo_history_floor", "2008-01-01")))
        try:
            res = fetch_ticker(yahoo, m["yahoo_ticker"], since=since)
        except YahooError as e:
            rec.update(status="ukjent", error=str(e)[:200])
            return rec
        meta, closes = (res[0], res[1]) if res else ({}, None)
        rec.update(fp.check_share_class(closes, meta.get("currency") or m.get("currency"), row,
                                        pcfg["tol_1y_pp"], pcfg["tol_3y_pp"], pcfg["price_ratio_tol"]))
        return rec

    by_isin = {r["isin"]: r for r in sample}
    with ThreadPoolExecutor(max_workers=threads) as ex:
        records = list(ex.map(check, [by_isin[i] for i in isins]))

    summary = fp.summarize(records)
    print()
    print(fp.format_summary(summary))

    out = resolve(args.out or pcfg["report_dir"])
    out.mkdir(parents=True, exist_ok=True)
    report = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "n_funds": len(rows), "n_sample": len(isins), "seed": pcfg["seed"] if args.seed is None else args.seed,
              "openfigi": not args.no_figi, "yahoo_calls": yahoo.n_calls, "summary": summary,
              "avvik": [{k: r.get(k) for k in ("isin", "name", "ticker", "yahoo_name", "d1", "d3", "price_ratio")}
                        for r in records if r.get("status") == "avvik"][:50]}
    (out / "probe_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str),
                                           encoding="utf-8")
    pd.DataFrame(records).to_csv(out / "probe_details.csv", index=False)
    print(f"\nRapport: {out / 'probe_report.json'}, detaljer: {out / 'probe_details.csv'} "
          f"({yahoo.n_calls} Yahoo-kall)")


if __name__ == "__main__":
    main()
