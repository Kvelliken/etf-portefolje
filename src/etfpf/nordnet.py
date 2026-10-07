"""Fetch and parse Nordnet's ETF list (https://www.nordnet.no/etf/liste).

The list data is embedded in the HTML as escaped JSON inside a <script> (a JS string
literal containing JSON). We locate the string literal that holds `"results":[`,
decode it with the JSON string decoder (handles every escape, not just \\"), and then
parse the `results` array with a real JSON decoder. A regex fallback based on the
original nordnet_etf.py is kept in case the page structure changes.
"""
import gzip
import json
import logging
import math
import re
import shutil
import time
from datetime import date, datetime
from pathlib import Path

import requests

log = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (personlig ETF-oversikt)",
    "Accept-Language": "nb-NO,nb;q=0.9",
}
ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
_RESULTS_RE = re.compile(r'"results"\s*:\s*\[')
_RESULTS_ESC_RE = re.compile(r'\\"results\\"\s*:\s*\[')
_TOTAL_RE = re.compile(r'"total_hits"\s*:\s*(\d+)')

# Normalised fields we extract from each row. Each maps to candidate leaf keys in the
# flattened row (first match wins). The raw row is always stored too, so new fields can
# be added later without scraping again.
FIELD_CANDIDATES = {
    "fee": ["ongoing_charges", "total_expense_ratio", "ter", "yearly_fee", "management_fee", "fee"],
    "category": ["category_name", "category", "fund_category", "etf_category", "asset_class"],
    "number_of_owners": ["number_of_owners", "owners", "num_owners"],
    "dividend_policy": ["dividend_policy", "dividend_type", "distribution_policy", "income_treatment"],
    "risk": ["risk_level", "risk", "srri", "risk_value", "sri"],
    "rating": ["morningstar_rating", "rating", "morningstar_stars"],
    "fund_size": ["fund_size", "aum", "total_assets", "assets_under_management", "fund_capital"],
    "replication": ["replication_method", "replication", "index_replication"],
    "index_name": ["index_name", "underlying_index", "benchmark", "tracked_index"],
    "price": ["last", "last_price", "price"],
    "yield_1y": ["yield_1y"],
    "yield_3y": ["yield_3y"],
    "yield_5y": ["yield_5y"],
}
INFO_FIELDS = ["name", "long_name", "symbol", "isin", "currency", "price_unit", "clearing_place",
               "issuer_name", "instrument_type", "instrument_group_type", "is_tradable",
               "is_monthly_saveable", "is_shortable"]


# ---------------------------------------------------------------- parsing

def _string_literal_bounds(text, pos):
    """Return (start, end) of the JS/JSON string literal enclosing position `pos`.
    A quote is a delimiter when preceded by an even number of backslashes."""
    def unescaped(i):
        n = 0
        j = i - 1
        while j >= 0 and text[j] == "\\":
            n += 1
            j -= 1
        return n % 2 == 0

    start = pos
    while start > 0:
        start -= 1
        if text[start] == '"' and unescaped(start):
            break
    end = pos
    while end < len(text):
        if text[end] == '"' and unescaped(end):
            break
        end += 1
    return start, end


def _decoded_json_texts(html):
    """Yield candidate JSON texts that contain a results array."""
    if _RESULTS_ESC_RE.search(html):
        seen = set()
        for m in _RESULTS_ESC_RE.finditer(html):
            s, e = _string_literal_bounds(html, m.start())
            if (s, e) in seen:
                continue
            seen.add((s, e))
            try:
                yield json.loads(html[s:e + 1])
            except json.JSONDecodeError:
                # Literal boundaries not where we expected: plain unescape as fallback.
                yield html[s + 1:e].replace('\\"', '"').replace("\\\\", "\\")
    if _RESULTS_RE.search(html):
        yield html


def _results_arrays(text):
    dec = json.JSONDecoder()
    for m in _RESULTS_RE.finditer(text):
        try:
            arr, _ = dec.raw_decode(text, m.end() - 1)
        except json.JSONDecodeError:
            continue
        if isinstance(arr, list) and arr and isinstance(arr[0], dict) and "instrument_info" in arr[0]:
            totals = _TOTAL_RE.findall(text[max(0, m.start() - 300):m.start()])
            yield arr, int(totals[-1]) if totals else None


def flatten(obj, prefix=""):
    """Flatten nested dicts to {'a.b.c': value}. Nordnet-style {'value': x, ...}
    wrappers are reduced to their value."""
    out = {}
    if isinstance(obj, dict):
        if "value" in obj and not isinstance(obj["value"], (dict, list)) and set(obj) <= {
                "value", "decimals", "currency", "unit"}:
            out[prefix.rstrip(".")] = obj["value"]
            return out
        for k, v in obj.items():
            out.update(flatten(v, f"{prefix}{k}."))
    elif isinstance(obj, list):
        out[prefix.rstrip(".")] = json.dumps(obj, ensure_ascii=False)
    else:
        out[prefix.rstrip(".")] = obj
    return out


def _pick(flat, candidates):
    for cand in candidates:
        for key, val in flat.items():
            if key.rsplit(".", 1)[-1] == cand and val not in (None, ""):
                return val
    return None


def normalize_row(raw, ask_countries=None):
    """Turn a raw Nordnet result row into a flat dict with our normalised columns."""
    info = raw.get("instrument_info", {})
    row = {"instrument_id": int(info["instrument_id"])}
    for f in INFO_FIELDS:
        row[f] = info.get(f)
    if row["isin"] and not ISIN_RE.match(row["isin"]):
        row["isin"] = None
    flat = flatten({k: v for k, v in raw.items() if k != "instrument_info"})
    for col, cands in FIELD_CANDIDATES.items():
        row[col] = _pick(flat, cands)
    for col in ("fee", "number_of_owners", "fund_size", "price", "yield_1y", "yield_3y", "yield_5y", "rating"):
        if row[col] is not None:
            try:
                row[col] = float(row[col])
            except (TypeError, ValueError):
                pass
    row["domicile"] = row["isin"][:2] if row["isin"] else None
    if ask_countries is not None:
        row["ask_eligible"] = int(bool(row["domicile"] and row["domicile"] in ask_countries))
    row["raw_json"] = json.dumps(raw, ensure_ascii=False, sort_keys=True)
    return row


def _legacy_parse(html):
    """Fallback from the original nordnet_etf.py: split on instrument_info blocks."""
    text = html.replace('\\"', '"')
    m = _TOTAL_RE.search(text)
    total = int(m.group(1)) if m else None
    rows = []
    for part in re.split(r'"instrument_info"\s*:\s*\{', text)[1:]:
        block = part[:3000]
        mid = re.search(r'"instrument_id"\s*:\s*(\d+)', block)
        if not mid:
            continue
        info = {"instrument_id": int(mid.group(1))}
        for f in INFO_FIELDS:
            mm = re.search(r'"%s"\s*:\s*"(.*?)"' % f, block)
            info[f] = mm.group(1) if mm else None
        rows.append({"instrument_info": info})
    return rows, total


def parse_page(html, ask_countries=None):
    """Return (rows, total_hits). Each row is normalised (see normalize_row)."""
    raw_rows, total = [], None
    for text in _decoded_json_texts(html):
        for arr, t in _results_arrays(text):
            raw_rows.extend(arr)
            total = total or t
        if raw_rows:
            break
    if not raw_rows:
        log.warning("Fant ingen JSON-results-array; bruker reserveparser (regex).")
        raw_rows, total = _legacy_parse(html)
    rows, seen = [], set()
    for raw in raw_rows:
        if "instrument_info" not in raw or "instrument_id" not in raw["instrument_info"]:
            continue
        r = normalize_row(raw, ask_countries)
        if r["instrument_id"] in seen:
            continue
        seen.add(r["instrument_id"])
        rows.append(r)
    return rows, total


# ---------------------------------------------------------------- fetching

class FetchError(RuntimeError):
    pass


def fetch_page(page, cfg, session=None):
    s = session or requests.Session()
    params = dict(cfg.get("list_params") or {})
    if page > 1:
        params["page"] = page
    for attempt in range(cfg["retries"]):
        try:
            r = s.get(cfg["url"], params=params or None, headers=HEADERS, timeout=cfg["timeout_seconds"])
            if r.status_code == 200:
                return r.text
            log.warning("side %d: HTTP %d", page, r.status_code)
            wait = 30 * (attempt + 1) if r.status_code == 429 else 5 * 2 ** attempt
        except requests.RequestException as e:
            log.warning("side %d: %s", page, e)
            wait = 5 * 2 ** attempt
        time.sleep(wait)
    raise FetchError(f"Klarte ikke hente side {page} etter {cfg['retries']} forsøk")


def scrape(cfg, max_pages=0, raw_dir=None, ask_countries=None, fetch=fetch_page, sleep=time.sleep):
    """Fetch all pages. Returns (found: {instrument_id: row}, total_hits, pages_written).
    Raw HTML from round 1 is written gzipped to raw_dir (a staging dir; caller moves it)."""
    found, total, written = {}, None, []
    session = requests.Session()
    for rnd in range(1, cfg["max_rounds"] + 1):
        page, pages = 1, max_pages or 1
        while page <= pages:
            html = fetch(page, cfg, session)
            rows, t = parse_page(html, ask_countries)
            total = total or t
            if page == 1 and not max_pages and t:
                pages = math.ceil(t / cfg["page_size"])
            if raw_dir and rnd == 1:
                raw_dir.mkdir(parents=True, exist_ok=True)
                p = raw_dir / f"page_{page:03d}.html.gz"
                with gzip.open(p, "wt", encoding="utf-8") as f:
                    f.write(html)
                written.append(p)
            new = 0
            for r in rows:
                if r["instrument_id"] not in found:
                    found[r["instrument_id"]] = r
                    new += 1
            log.info("Runde %d, side %d/%d: %d rader, %d nye, totalt %d", rnd, page, pages, len(rows), new, len(found))
            page += 1
            sleep(cfg["delay_seconds"])
        # The list is sorted by 1y return, so rows may shift between pages mid-run.
        if max_pages or not total or len(found) >= total:
            break
        log.info("Har %d av %d, tar en ny runde for å fylle hull ...", len(found), total)
    return found, total, written


def prune_raw(raw_root, keep_months, today=None):
    """Delete data/raw/<YYYY-MM-DD> folders older than keep_months."""
    if not keep_months:
        return []
    today = today or date.today()
    cutoff_idx = today.year * 12 + today.month - keep_months
    removed = []
    for d in Path(raw_root).glob("????-??-??"):
        try:
            dt = datetime.strptime(d.name, "%Y-%m-%d").date()
        except ValueError:
            continue
        if dt.year * 12 + dt.month < cutoff_idx:
            shutil.rmtree(d)
            removed.append(d)
    return removed
