import sqlite3
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from etfpf import prices as pr
from etfpf import tickers as tk
from etfpf.yahoo import currency_unit, parse_chart

D = lambda s: date.fromisoformat(s)


def chart_fixture():
    # 4 trading days, Europe/Berlin (+7200). Last bar empty (Yahoo quirk) -> filled from meta.
    ts = [1790924400, 1791183600, 1791270000, 1791356400]  # 2026-10-02, 05, 06, 07 07:00 UTC
    return {"meta": {"currency": "EUR", "gmtoffset": 7200, "regularMarketTime": 1791387363,
                     "regularMarketPrice": 64.0},
            "timestamp": ts,
            "indicators": {"quote": [{"close": [62.5, None, 63.0, None]}]},
            "events": {"dividends": {"1791183600": {"amount": 0.5, "date": 1791183600}},
                       "splits": {"1790924400": {"date": 1790924400, "numerator": 2, "denominator": 1}}}}


def test_parse_chart():
    meta, c, dv, sp = parse_chart(chart_fixture())
    assert meta["currency"] == "EUR"
    assert c["date"].tolist() == [D("2026-10-02"), D("2026-10-06"), D("2026-10-07")]
    assert c["close"].tolist() == [62.5, 63.0, 64.0]
    assert dv.to_dict("records") == [{"date": D("2026-10-05"), "amount": 0.5}]
    assert sp["ratio"].tolist() == [2.0]


def test_currency_unit():
    assert currency_unit("GBp") == ("GBP", 0.01)
    assert currency_unit("USD") == ("USD", 1.0)


def test_total_return_index():
    idx = [D("2026-01-01"), D("2026-01-02"), D("2026-01-05")]
    close = pd.Series([100.0, 98.0, 99.0], index=idx)
    # Dividend of 2 on a non-trading day (Jan 3) belongs to Jan 5.
    tr = total = pr.total_return_index(close, pd.Series([2.0], index=[D("2026-01-03")]))
    assert tr.iloc[-1] == pytest.approx(99.0)
    r = tr.pct_change().dropna().tolist()
    assert r[0] == pytest.approx(-0.02)
    assert r[1] == pytest.approx(101 / 98 - 1)
    assert pr.total_return_index(close).iloc[0] == pytest.approx(100.0)
    del total


def test_clean_closes_removes_spike():
    idx = pd.date_range("2026-01-01", periods=10).date
    s = pd.Series([10, 10.1, 10.2, 500, 10.1, 10.0, 0, 10.2, 10.3, 10.1], index=idx, dtype=float)
    out = pr.clean_closes(s, 1.3)
    assert 500 not in out.values and 0 not in out.values and len(out) == 8


def test_norges_bank_csv_unit_mult():
    csv = ("FREQ;Frequency;BASE_CUR;Base Currency;QUOTE_CUR;Quote Currency;TENOR;Tenor;DECIMALS;CALCULATED;"
           "UNIT_MULT;Unit Multiplier;COLLECTION;Collection Indicator;TIME_PERIOD;OBS_VALUE\n"
           "B;Business;EUR;Euro;NOK;Norwegian krone;SP;Spot;4;false;0;Units;C;x;2026-10-01;11.70\n"
           "B;Business;SEK;Swedish krona;NOK;Norwegian krone;SP;Spot;4;false;2;Hundreds;C;x;2026-10-01;107.5\n")
    fx = pr.parse_norges_bank_csv(csv)
    assert fx.set_index("currency")["nok"].to_dict() == pytest.approx({"EUR": 11.70, "SEK": 1.075})


def test_nok_series_converts_with_ffill_and_pence():
    close = pd.Series([100.0, 110.0, 121.0], index=[D("2026-10-02"), D("2026-10-05"), D("2026-10-06")])
    fx = pd.DataFrame({"date": [D("2026-10-01"), D("2026-10-05")], "currency": ["GBP", "GBP"],
                       "nok": [13.0, 14.0]})
    s = pr.nok_series(close, None, fx, "GBp", spike_ratio=0)
    assert s.tolist() == pytest.approx([13.0, 15.4, 16.94])   # 1.00*13, 1.10*14, 1.21*14
    assert pr.nok_series(close, None, fx, "USD") is None
    assert pr.nok_series(close, None, fx, "NOK").tolist() == pytest.approx(close.tolist())


def frame(ticker_dates_closes):
    return pd.DataFrame(ticker_dates_closes, columns=["date", "close"])


def test_store_merge_and_partitioned_save(tmp_path):
    st = pr.PriceStore(tmp_path)
    full = frame([(D("2025-12-30"), 1.0), (D("2025-12-31"), 1.1), (D("2026-01-02"), 1.2)])
    divs = pd.DataFrame([(D("2025-12-31"), 0.1)], columns=["date", "amount"])
    st.apply([("A.DE", full, divs, True), ("B.DE", full, divs.iloc[:0], True)])
    assert st.save() == 3  # close_2025, close_2026, dividends
    # Incremental: overlapping fetch from 2026-01-02 replaces that day and adds one.
    st2 = pr.PriceStore(tmp_path)
    assert len(st2.close) == 6 and len(st2.divs) == 1
    inc = frame([(D("2026-01-02"), 1.25), (D("2026-01-05"), 1.3)])
    st2.apply([("A.DE", inc, divs.iloc[:0], False)])
    assert st2.save() == 1  # only close_2026 rewritten
    st3 = pr.PriceStore(tmp_path)
    a = st3.series()["A.DE"][0]
    assert a.tolist() == [1.0, 1.1, 1.25, 1.3]
    assert len(st3.divs) == 1
    assert st3.save() == 0
    # Full refetch replaces everything for the ticker.
    st3.apply([("A.DE", frame([(D("2026-01-05"), 2.0)]), divs.iloc[:0], True)])
    st3.save()
    st4 = pr.PriceStore(tmp_path)
    assert st4.series()["A.DE"][0].tolist() == [2.0]
    assert st4.divs.empty and len(st4.series()["B.DE"][0]) == 3


class ChartYahoo:
    def __init__(self, fail=()):
        self.fail, self.calls = set(fail), []

    def chart(self, ticker, **kw):
        self.calls.append((ticker, kw.get("period1")))
        if ticker in self.fail:
            return None
        today = date.today()
        days = [today - timedelta(days=i) for i in (3, 2, 1)]
        ts = [int(pd.Timestamp(d).timestamp()) + 9 * 3600 for d in days]
        return {"meta": {"currency": "EUR", "gmtoffset": 0}, "timestamp": ts,
                "indicators": {"quote": [{"close": [10.0, 10.5, 11.0]}]}}


def test_update_prices_and_failure_threshold(tmp_path):
    conn = sqlite3.connect(":memory:")
    st = pr.PriceStore(tmp_path)
    failed = pr.update_prices(conn, st, ChartYahoo(fail={"X.DE"}), {"A.DE": "EUR", "B.L": "GBp", "X.DE": "EUR"},
                              {"max_stale_days": 30}, threads=2, max_fail_fraction=0.5)
    assert failed == [("X.DE", "ingen data")]
    meta = {r[0]: r[1:] for r in conn.execute("SELECT ticker, ok, n_obs FROM price_meta")}
    assert meta == {"A.DE": (1, 3), "B.L": (1, 3), "X.DE": (0, None)}
    with pytest.raises(pr.PriceUpdateError):
        pr.update_prices(conn, pr.PriceStore(tmp_path), ChartYahoo(fail={"A.DE", "B.L"}),
                         {"A.DE": "EUR", "B.L": "EUR"}, {}, max_fail_fraction=0.25)
    # Incremental: second run asks only from last date minus overlap.
    st.save()
    y = ChartYahoo()
    pr.update_prices(conn, pr.PriceStore(tmp_path), y, {"A.DE": "EUR"}, {"overlap_days": 14})
    assert y.calls[0][1] > pr.EPOCH_START


def test_nok_prices_and_coverage(tmp_path):
    from conftest import make_row
    from etfpf import db, nordnet
    conn = db.connect(tmp_path / "t.db")
    rows = {i: nordnet.normalize_row(make_row(i, isin, f"E{i}"), ["IE"])
            for i, isin in [(1, "IE00B4L5Y983"), (2, "IE00BHZRR030")]}
    db.store(conn, rows, 2, partial=False)
    tk.ensure_schema(conn)
    conn.execute("INSERT INTO ticker_map(isin, yahoo_ticker, source, verified_at, ok, chosen, currency) "
                 "VALUES('IE00B4L5Y983', 'EUNL.DE', 'nordnet', '2026-10-08', 1, 1, 'EUR')")
    conn.commit()
    st = pr.PriceStore(tmp_path)
    days = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=1400).date
    st.apply([("EUNL.DE", frame(list(zip(days, np.linspace(50, 100, len(days))))),
               pd.DataFrame(columns=["date", "amount"]), True)])
    fx = pd.DataFrame({"date": [days[0]], "currency": ["EUR"], "nok": [11.0]})
    nok = pr.nok_prices(conn, st, fx)
    assert list(nok.columns) == ["IE00B4L5Y983"]
    assert nok.iloc[-1, 0] == pytest.approx(1100.0)
    cov = pr.coverage(conn, nok)
    assert cov["active_isins"] == 2 and cov["with_prices"] == 1 and cov["coverage_pct"] == 50.0
    assert cov["history"]["min_5y"] == 1 and cov["history"]["min_10y"] == 0


def test_clean_closes_keeps_crash_removes_false_regime_and_fixes_units():
    idx = pd.bdate_range("2026-01-01", periods=80).date
    base = np.full(80, 100.0)
    base[40:] = 60.0                       # genuine crash that stays: kept
    s = pd.Series(base, index=idx)
    s.iloc[10:14] = 150.0                  # 4-day false level: removed
    s.iloc[60] = 6000.0                    # 100x unit flip: rescaled
    out = pr.clean_closes(s, 1.3)
    assert 150.0 not in out.values
    assert out.loc[idx[60]] == pytest.approx(60.0)
    assert (out.loc[idx[40]:] == 60.0).all() and len(out) == 76


def test_trim_after_jumps():
    idx = pd.bdate_range("2026-01-01", periods=6).date
    s = pd.Series([10, 10.1, 20, 20.2, 20.1, 20.3], index=idx)
    out, n = pr.trim_after_jumps(s, 1.3)
    assert n == 1 and out.index[0] == idx[2] and len(out) == 4
    assert pr.trim_after_jumps(s, 0)[0] is s
