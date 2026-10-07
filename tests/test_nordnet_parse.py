import gzip
from datetime import date
from pathlib import Path

from conftest import make_page_html, make_row
from etfpf import nordnet

FIX = Path(__file__).parent / "fixtures"


def sample_rows():
    return [
        make_row(17059750, "IE00BHZRR030", "Franklin FTSE Korea UCITS ETF", "FLXK"),
        make_row(1, "LU1900066207", 'Amundi MSCI Korea "Acc" Brød \\ test', "LKOR", fee=0.45),
        make_row(2, "LU1900066207", "Amundi MSCI Korea (SEK)", "LKOR", currency="SEK", clearing="SSE"),
        make_row(3, "US78462F1030", "SPDR S&P 500 ETF", "SPY", currency="USD", clearing="XNYS"),
        make_row(4, "BADISIN", "Uten gyldig ISIN", "BAD"),
    ]


def test_parse_escaped_json():
    rows, total = nordnet.parse_page(make_page_html(sample_rows(), 2253), ask_countries=["IE", "LU"])
    assert total == 2253
    assert [r["instrument_id"] for r in rows] == [17059750, 1, 2, 3, 4]
    r0 = rows[0]
    assert r0["isin"] == "IE00BHZRR030" and r0["symbol"] == "FLXK" and r0["clearing_place"] == "PERS_DE"
    assert r0["fee"] == 0.2 and r0["number_of_owners"] == 100 and r0["category"] == "Aksjer Global"
    assert r0["dividend_policy"] == "Akkumulerende" and r0["price"] == 12.5 and r0["yield_1y"] == 14.2
    assert abs(r0["total_fee"] - 0.3) < 1e-9
    assert r0["start_date"] == "2019-06-04" and r0["risk"] == 4 and r0["fund_type"] == "Aksje"
    assert r0["spread_pct"] == 0.16 and r0["exchange_country"] == "DE"
    assert r0["is_tradable"] is True and r0["ask_eligible"] == 1 and r0["domicile"] == "IE"
    # Escaped quotes, backslashes and non-ASCII characters survive decoding.
    assert rows[1]["name"] == 'Amundi MSCI Korea "Acc" Brød \\ test'
    assert rows[3]["ask_eligible"] == 0  # US-domiciled: not allowed on ASK
    assert rows[4]["isin"] is None       # invalid ISIN rejected


def test_parse_plain_json():
    rows, total = nordnet.parse_page(make_page_html(sample_rows(), 5, escaped=False))
    assert total == 5 and len(rows) == 5 and rows[1]["fee"] == 0.45


def test_duplicate_isin_kept_as_separate_listings():
    rows, _ = nordnet.parse_page(make_page_html(sample_rows(), 5))
    isins = [r["isin"] for r in rows if r["isin"]]
    assert len(isins) == 4 and len(set(isins)) == 3


def test_legacy_fallback_when_results_is_not_valid_json():
    html = make_page_html(sample_rows(), 99).replace('\\"results\\":[', '\\"results\\":[ BROKEN ')
    rows, total = nordnet.parse_page(html)
    assert total == 99 and len(rows) == 5 and rows[0]["symbol"] == "FLXK"


def test_no_rows():
    rows, total = nordnet.parse_page("<html><body>Ingen data</body></html>")
    assert rows == [] and total is None


def test_snippet_from_prompt():
    """The exact escaped form shown in the assignment."""
    html = (FIX / "nordnet_snippet.html").read_text(encoding="utf-8")
    rows, total = nordnet.parse_page(html)
    assert total == 2253 and len(rows) == 1
    assert rows[0]["isin"] == "IE00BHZRR030" and rows[0]["issuer_name"] == "Franklin Templeton"


def test_scrape_rounds_and_raw(tmp_path):
    """Rows shift between pages during round 1; round 2 fills the hole."""
    all_rows = [make_row(i, f"IE00000000{i:02d}", f"ETF {i}") for i in range(1, 6)]
    calls = []

    def fake_fetch(page, cfg, session):
        calls.append(page)
        rnd = 1 if len(calls) <= 3 else 2
        if rnd == 1:  # page 2 misses ETF 4 because it moved to page 1 after page 1 was fetched
            pages = {1: all_rows[0:2], 2: [all_rows[2], all_rows[4]], 3: []}
        else:
            pages = {1: all_rows[0:2], 2: all_rows[2:4], 3: all_rows[4:]}
        return make_page_html(pages[page], 5)

    cfg = {"page_size": 2, "max_rounds": 3, "delay_seconds": 0}
    found, total, written = nordnet.scrape(cfg, 0, tmp_path / "raw", fetch=fake_fetch, sleep=lambda s: None)
    assert total == 5 and sorted(found) == [1, 2, 3, 4, 5]
    assert calls == [1, 2, 3, 1, 2, 3]
    assert [p.name for p in written] == ["page_001.html.gz", "page_002.html.gz", "page_003.html.gz"]
    with gzip.open(written[0], "rt", encoding="utf-8") as f:
        assert "results" in f.read()


def test_max_pages_single_round():
    calls = []

    def fake_fetch(page, cfg, session):
        calls.append(page)
        return make_page_html([make_row(page, "IE0000000001", "x")], 500)

    cfg = {"page_size": 100, "max_rounds": 3, "delay_seconds": 0}
    found, total, _ = nordnet.scrape(cfg, 1, None, fetch=fake_fetch, sleep=lambda s: None)
    assert calls == [1] and len(found) == 1 and total == 500


def test_prune_raw(tmp_path):
    for d in ["2026-01-02", "2026-04-01", "2026-09-30", "2026-10-01", "notadate"]:
        (tmp_path / d).mkdir()
    removed = nordnet.prune_raw(tmp_path, 6, today=date(2026, 10, 7))
    assert sorted(p.name for p in removed) == ["2026-01-02"]
    assert (tmp_path / "2026-04-01").exists()
