import sqlite3
from datetime import date

from etfpf import db, tickers as tk

SUFFIX = {"xeta": ".DE", "xsto": ".ST"}
FIGI = {"GY": ".DE", "LN": ".L", "NA": ".AS", "GF": ".F"}


def test_yahoo_symbol():
    assert tk.yahoo_symbol("XACT OMXS30", ".ST") == "XACT-OMXS30.ST"
    assert tk.yahoo_symbol("eunl", ".DE") == "EUNL.DE"
    assert tk.yahoo_symbol("", ".DE") is None


def test_nordnet_candidates():
    raw = {"instrument_info": {"symbol": "FLXK"}, "market_info": {"identifier": "FLXK"},
           "nnx_info": {"display_slug": "franklin-ftse-korea-flxk-xeta"}}
    assert tk.nordnet_candidates(raw, SUFFIX) == ["FLXK.DE"]
    raw = {"instrument_info": {"symbol": "XACT OMXS30"}, "market_info": {"identifier": "XACT OMXS30"},
           "nnx_info": {"display_slug": "xact-omxs30-xact-omxs30-xsto"}}
    assert tk.nordnet_candidates(raw, SUFFIX) == ["XACT-OMXS30.ST"]
    assert tk.nordnet_candidates({"nnx_info": {"display_slug": "x-y-xnas"}}, SUFFIX) == []


def test_figi_candidates_priority_and_limit():
    items = [{"ticker": "SSAC", "exchCode": "LN"}, {"ticker": "ISAC", "exchCode": "LN"},
             {"ticker": "XYZ", "exchCode": "LN"}, {"ticker": "IUSQ", "exchCode": "GY"},
             {"ticker": "IUSQ", "exchCode": "GF"}, {"ticker": "Q", "exchCode": "US"}]
    assert tk.figi_candidates(items, FIGI) == ["IUSQ.DE", "SSAC.L", "ISAC.L", "IUSQ.F"]


def test_yahoo_search_candidates():
    quotes = [{"symbol": "ISAC.L", "quoteType": "ETF"}, {"symbol": "X", "quoteType": "OPTION"},
              {"symbol": "ISAC.L", "quoteType": "ETF"}]
    assert tk.yahoo_search_candidates(quotes) == ["ISAC.L"]


def test_merge_candidates():
    out = tk.merge_candidates(("nordnet", ["A.DE"]), ("yahoo_search", ["A.DE", "B.L"]),
                              ("openfigi", ["B.L", "C.AS"]), limit=2)
    assert out == [("A.DE", "nordnet,yahoo_search"), ("B.L", "yahoo_search,openfigi")]


def test_choose_prefers_most_months_and_recent():
    today = date(2026, 10, 8)
    p = lambda n, last, ok=1: {"ok": ok, "n_months": n, "last_date": last, "first_date": "2010-01-01"}
    probes = [("A.DE", p(100, "2026-10-07")), ("B.L", p(150, "2026-10-07")),
              ("C.AS", p(300, "2020-01-01")), ("D.MI", p(400, "2026-10-07", ok=0))]
    assert tk.choose(probes, today) == "B.L"
    assert probes[2][1]["ok"] == 0  # stale is marked not ok
    # tie on months -> earlier candidate (source priority) wins
    assert tk.choose([("A.DE", p(100, "2026-10-07")), ("B.L", p(100, "2026-10-07"))], today) == "A.DE"
    assert tk.choose([], today) is None


def test_covers_start():
    p = {"ok": 1, "first_date": "2008-01-31"}
    assert tk.covers_start(p, "2001-01-01")            # before Yahoo floor
    assert tk.covers_start({"ok": 1, "first_date": "2019-03-01"}, "2019-01-15")
    assert not tk.covers_start({"ok": 1, "first_date": "2024-01-01"}, "2019-01-15")
    assert not tk.covers_start(p, None)


class FakeResp:
    def __init__(self, status, data):
        self.status_code, self._data = status, data

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


def test_openfigi_lookup_batches_and_retries():
    calls = []

    def post(body):
        calls.append(len(body))
        if len(calls) == 1:
            return FakeResp(429, None)
        return FakeResp(200, [{"data": [{"ticker": "T" + j["idValue"][-1], "exchCode": "GY"}]}
                              if j["idValue"] != "B" else {"warning": "No identifier found."} for j in body])

    out = tk.openfigi_lookup(["A1", "B", "C3"], {"openfigi_batch": 2, "openfigi_delay_seconds": 0},
                             post=post, sleep=lambda s: None)
    assert calls == [2, 2, 1]
    assert out == {"A1": [{"ticker": "T1", "exchCode": "GY"}], "B": [], "C3": [{"ticker": "T3", "exchCode": "GY"}]}


class FakeYahoo:
    """Search returns nothing; chart returns monthly bars for known symbols."""
    def __init__(self, data):
        self.data = data

    def search(self, q):
        return []

    def chart(self, ticker, **kw):
        if ticker not in self.data:
            return None
        start, n = self.data[ticker]
        ts = [start + i * 2_629_800 for i in range(n)]
        return {"meta": {"currency": "EUR", "regularMarketTime": ts[-1]}, "timestamp": ts,
                "indicators": {"quote": [{"close": [10.0] * n}]}}


def test_map_tickers_end_to_end(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    from conftest import make_row
    from etfpf import nordnet
    rows = {}
    for iid, isin, sym in [(1, "IE00B4L5Y983", "EUNL"), (2, "IE00BHZRR030", "FLXK"), (3, "LU0000000006", "NONE")]:
        raw = make_row(iid, isin, f"ETF {sym}", symbol=sym)
        raw["nnx_info"] = {"display_slug": f"etf-{sym.lower()}-xeta"}
        raw["market_info"] = {"identifier": sym}
        rows[iid] = nordnet.normalize_row(raw, ["IE", "LU"])
    db.store(conn, rows, 3, partial=False)
    now_ts = int(date.today().strftime("%s"))
    yahoo = FakeYahoo({"EUNL.DE": (now_ts - 100 * 2_629_800, 101),
                       "FLXK.DE": (now_ts - 10 * 2_629_800, 11),
                       "FLXK.L": (now_ts - 50 * 2_629_800, 51)})
    figi = {"IE00BHZRR030": [{"ticker": "FLXK", "exchCode": "LN"}]}
    cfg = {"nordnet_suffix": SUFFIX, "figi_suffix": FIGI, "yahoo_search": True, "max_stale_days": 30}
    todo = tk.isins_to_map(conn, 180)
    assert len(todo) == 3
    res = tk.map_tickers(conn, cfg, yahoo, todo, threads=2, figi_lookup=lambda isins, c: figi)
    assert res["IE00B4L5Y983"] == "EUNL.DE"
    assert res["IE00BHZRR030"] == "FLXK.L"     # longer history via OpenFIGI wins
    assert res["LU0000000006"] is None
    assert tk.isins_to_map(conn, 180) == ["LU0000000006"]
    assert tk.chosen_tickers(conn)["IE00BHZRR030"] == ("FLXK.L", "EUR")
    tk.invalidate(conn, "FLXK.L", "test")
    assert "IE00BHZRR030" in tk.isins_to_map(conn, 180)
