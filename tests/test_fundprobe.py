import sqlite3
from datetime import date, timedelta

import pandas as pd

from conftest import make_row
from etfpf import db, fundprobe as fp, nordnet
from etfpf.config import list_settings, load_config


def fund_row(iid, isin, name, fund_type="Aksje", currency="NOK", y1=10.0, y3=30.0, price=100.0):
    r = make_row(iid, isin, name, symbol="", currency=currency)
    r["instrument_info"].update(instrument_type="FND", instrument_type_hierarchy="FND", instrument_group_type="FND")
    r["fund_info"]["fund_type"] = fund_type
    r["historical_returns_info"] = {"yield_1y": y1, "yield_3y": y3}
    r["price_info"] = {"last": {"price": price, "decimals": 2}}
    return r


def test_list_settings():
    cfg = load_config()
    etf, fond = list_settings(cfg, "etf"), list_settings(cfg, "fond")
    assert etf["db"] == cfg["paths"]["db"] and etf["nordnet"]["url"].endswith("/etf/liste")
    assert fond["db"] == cfg["funds"]["db"] != etf["db"]
    assert fond["nordnet"]["url"] == cfg["funds"]["url"]
    assert fond["nordnet"]["page_size"] == cfg["nordnet"]["page_size"]
    assert cfg["nordnet"]["url"].endswith("/etf/liste")  # not mutated


def test_latest_rows_prefers_nok_listing(ask):
    conn = sqlite3.connect(":memory:")
    conn.executescript(db.SCHEMA)
    raws = [fund_row(1, "NO0010582976", "Indeksfond A"), fund_row(2, "LU0000000001", "Rentefond EUR", "Rente",
                                                                   "EUR"),
            fund_row(3, "LU0000000001", "Rentefond NOK", "Rente", "NOK")]
    found = {r["instrument_id"]: r for r in (nordnet.normalize_row(x, ask) for x in raws)}
    db.store(conn, found, 3, partial=False)
    rows = {r["isin"]: r for r in fp.latest_rows(conn)}
    assert set(rows) == {"NO0010582976", "LU0000000001"}
    assert rows["LU0000000001"]["currency"] == "NOK"
    assert rows["NO0010582976"]["yield_1y"] == 10.0 and rows["NO0010582976"]["price"] == 100.0
    assert rows["NO0010582976"]["run_at"]


def test_stratified_sample():
    rows = ([{"isin": f"A{i:03d}", "fund_type": "Aksje"} for i in range(70)] +
            [{"isin": f"R{i:03d}", "fund_type": "Rente"} for i in range(28)] +
            [{"isin": f"K{i:03d}", "fund_type": "Kombinasjon"} for i in range(2)])
    s = fp.stratified_sample(rows, 20, seed=3)
    by = pd.Series([r["fund_type"] for r in s]).value_counts().to_dict()
    assert len(s) == 20 and by == {"Aksje": 14, "Rente": 5, "Kombinasjon": 1}
    assert [r["isin"] for r in s] == [r["isin"] for r in fp.stratified_sample(list(reversed(rows)), 20, seed=3)]
    assert len({r["isin"] for r in s}) == 20
    assert fp.stratified_sample(rows, 0) == rows and len(fp.stratified_sample(rows, 500)) == 100


def daily(start, end, f):
    days = pd.bdate_range(start, end)
    return pd.DataFrame({"date": [d.date() for d in days], "close": [f(i) for i in range(len(days))]})


def test_price_return():
    s = daily("2022-01-03", "2026-10-30", lambda i: 100 * 1.0004 ** i)
    ser = pd.Series(s["close"].to_numpy(), index=list(s["date"]))
    r1 = fp.price_return(ser, date(2026, 11, 2), 365)
    assert 10 < r1 < 12  # 1.0004 ** 261 handelsdager ≈ 11 %
    assert fp.price_return(ser, date(2026, 11, 2), 10 * 365) is None   # too short
    assert fp.price_return(ser, date(2027, 6, 1), 365) is None          # stale last price


def test_check_share_class():
    end = date(2026, 11, 2)
    closes = daily("2023-06-01", "2026-10-30", lambda i: 100 * 1.0004 ** i)
    ser = pd.Series(closes["close"].to_numpy(), index=list(closes["date"]))
    r1, r3 = fp.price_return(ser, end, 365), fp.price_return(ser, end, 3 * 365)
    row = {"currency": "NOK", "yield_1y": r1 + 0.5, "yield_3y": r3 - 1, "price": closes["close"].iloc[-1],
           "run_at": "2026-11-02T06:00:00+00:00"}
    c = fp.check_share_class(closes, "NOK", row)
    assert c["status"] == "ok" and abs(c["d1"] + 0.5) < 1e-9 and abs(c["price_ratio"] - 1) < 1e-9
    assert fp.check_share_class(closes, "NOK", dict(row, yield_1y=r1 + 4))["status"] == "avvik"
    assert fp.check_share_class(closes, "NOK", dict(row, price=row["price"] * 1.1))["status"] == "avvik"
    assert fp.check_share_class(closes, "EUR", row)["status"] == "ulik valuta"
    assert fp.check_share_class(closes, "NOK", dict(row, yield_1y=None, yield_3y=None, price=None))["status"] == "ukjent"
    assert fp.check_share_class(None, "NOK", row)["status"] == "ukjent"
    # Pence listings are rescaled before the price check.
    gbp = closes.assign(close=closes["close"] * 100)
    assert fp.check_share_class(gbp, "GBp", dict(row, currency="GBP"))["status"] == "ok"


def test_summarize_and_format():
    recs = [
        {"isin": "1", "fund_type": "Aksje", "domicile": "NO", "ticker": "0P1.IR", "source": "yahoo_search",
         "exchange": "Irish", "years": 12, "covers_start": True, "status": "ok"},
        {"isin": "2", "fund_type": "Aksje", "domicile": "LU", "ticker": "0P2.F", "source": "yahoo_search,openfigi",
         "exchange": "Frankfurt", "years": 2, "covers_start": False, "status": "ok"},
        {"isin": "3", "fund_type": "Rente", "domicile": "NO", "ticker": "0P3.IR", "source": "yahoo_search",
         "exchange": "Irish", "years": 6, "covers_start": True, "status": "avvik"},
        {"isin": "4", "fund_type": "Rente", "domicile": "NO", "ticker": None, "years": 0, "status": None},
    ]
    s = fp.summarize(recs)
    t = s["totalt"]
    assert t["n"] == 4 and t["med_ticker"] == 3 and t["minst_3_år"] == 2 and t["minst_10_år"] == 1
    assert t["andelsklasse_ok"] == 2 and t["avvik"] == 1 and t["brukbar"] == 1 and t["andel_brukbar"] == 0.25
    assert s["per"]["fund_type"]["Rente"]["brukbar"] == 0
    assert s["kilder"] == {"yahoo_search": 3, "openfigi": 1}
    text = fp.format_summary(s)
    assert "Totalt" in text and "brukbar" in text and "Aksje" in text
