#!/usr/bin/env python3
"""Diagnose external data sources (run where the network is open, e.g. GitHub Actions).

- reachability of Nordnet, Yahoo, OpenFIGI and Norges Bank
- one Nordnet page: structure around the results array and the first raw row
- whether list_params (stable sorting) are honoured by Nordnet
"""
import json
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from etfpf import nordnet  # noqa: E402
from etfpf.config import load_config  # noqa: E402

URLS = {
    "nordnet": "https://www.nordnet.no/etf/liste",
    "yahoo_q1": "https://query1.finance.yahoo.com/v8/finance/chart/EUNL.DE?range=5d&interval=1d",
    "yahoo_q2": "https://query2.finance.yahoo.com/v8/finance/chart/EUNL.DE?range=5d&interval=1d",
    "yahoo_fc": "https://fc.yahoo.com",
    "openfigi": "https://api.openfigi.com/v3/mapping",
    "norges_bank": "https://data.norges-bank.no/api/data/EXR/B.USD.NOK.SP?format=sdmx-json&lastNObservations=1",
}


def reachability():
    print("== Tilgjengelighet")
    for k, u in URLS.items():
        try:
            if k == "openfigi":
                r = requests.post(u, json=[{"idType": "ID_ISIN", "idValue": "IE00B6R52259"}],
                                  headers=nordnet.HEADERS, timeout=30)
            else:
                r = requests.get(u, headers=nordnet.HEADERS, timeout=30)
            print(f"  {k:12s} HTTP {r.status_code}  {len(r.content)} B  {r.text[:160]!r}")
        except requests.RequestException as e:
            print(f"  {k:12s} FEIL {e}")


def page_rows(params):
    r = requests.get(URLS["nordnet"], params=params or None, headers=nordnet.HEADERS, timeout=45)
    rows, total = nordnet.parse_page(r.text)
    return r, rows, total


def structure(cfg):
    print("\n== Nordnet side 1 (standard)")
    r, rows, total = page_rows({})
    html = r.text
    print(f"  HTTP {r.status_code}, {len(html)} tegn, total_hits={total}, rader={len(rows)}, "
          f"unike ISIN={len({x['isin'] for x in rows if x['isin']})}")
    i = html.find('results')
    print("  Kontekst før første 'results':", repr(html[max(0, i - 400):i + 40]))
    if rows:
        print("  Første rå rad:")
        print(json.dumps(json.loads(rows[0]["raw_json"]), indent=1, ensure_ascii=False)[:6000])
        keys = set()
        for x in rows:
            keys |= set(nordnet.flatten(json.loads(x["raw_json"])))
        print("  Alle flate nøkler:", sorted(keys))
    out = Path("probe_page1.html")
    out.write_text(html, encoding="utf-8")


def sorting():
    print("\n== Stabil sortering")
    for params in [{"sort_attribute": "name", "sort_order": "asc"},
                   {"sortField": "name", "sortOrder": "asc"}]:
        for page in (1, 2):
            p = dict(params, **({"page": page} if page > 1 else {}))
            try:
                r, rows, total = page_rows(p)
            except requests.RequestException as e:
                print(f"  {p}: FEIL {e}")
                continue
            names = [x["name"] or "" for x in rows]
            keys = sorted(set(__import__("re").findall(r'etflist\?[^"\\]*', r.text)))[:3]
            print(f"  {p}: HTTP {r.status_code}, rader={len(rows)}, total={total}, "
                  f"sortert={names == sorted(names, key=str.casefold)}, nøkler={keys}")
            print("     første navn:", names[:4], "siste:", names[-2:])


if __name__ == "__main__":
    cfg = load_config()
    reachability()
    structure(cfg)
    sorting()
