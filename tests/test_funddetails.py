import json
import sqlite3

import pytest

from etfpf import db, funddetails as fdet, nordnet

RISK = {"fiveYears": {"alpha": 0.15, "beta": 1.02, "r2": 98.38, "sharpeRatio": 0.87, "standardDeviation": 12.98,
                      "trackingError": 1.67},
        "oneYear": {"alpha": 1.61, "beta": 0.88, "r2": 97.42, "sharpeRatio": 1.37, "standardDeviation": 10.08,
                    "trackingError": 2.08},
        "threeYears": {}, "updatedAt": "2026-10-31"}
API = [{"risk_statistics": {"alpha_y1": -0.1622, "beta_y1": 0.9015, "sharpe_ratio_y1": -0.1164,
                            "standard_deviation_y1": 12.2341, "sharpe_ratio_y3": 0.825, "standard_deviation_y3": 12.19},
        "morningstar_info": {"risk": 4}, "inception_date": "2022-06-08", "is_index_fund": True,
        "sector_allocation": [{"weight": 30}]}]


def page_html(escaped=True):
    """Fund page as Nordnet serves it: state JSON inside a JS string literal (quotes written \\")."""
    state = json.dumps({"fund": {"name": 'Fond "A"', "risksStatistics": RISK, "x": 1}})
    lit = json.dumps(state) if escaped else state
    return f"<html><script>window.__S__=JSON.parse({lit});</script></html>"


@pytest.mark.parametrize("escaped", [True, False])
def test_parse_page_risk(escaped):
    assert fdet.parse_page_risk(page_html(escaped)) == RISK
    assert fdet.parse_page_risk("<html>ingen tall</html>") is None


def test_risk_fields_units_and_sources():
    api = {"risk_statistics": API[0]["risk_statistics"]}
    r = fdet.risk_fields(api, RISK)
    # NOK figures from the API, percent -> fraction
    assert r["vol1"] == pytest.approx(0.122341) and r["sharpe1"] == pytest.approx(-0.116)
    assert r["alpha1"] == pytest.approx(-0.001622) and r["beta1"] == pytest.approx(0.9015, abs=1e-3)
    assert r["vol3"] == pytest.approx(0.1219) and r["alpha3"] is None and r["vol5"] is None
    # R² and TE from the page (Morningstar); the page's own volatility is not used
    assert r["r21"] == pytest.approx(0.9742) and r["te5"] == pytest.approx(0.0167) and r["r23"] is None
    assert all(v is None for v in fdet.risk_fields(None, None).values())


class FakeResp:
    def __init__(self, status, text):
        self.status_code, self.text = status, text


class FakeSession:
    def __init__(self):
        self.urls = []

    def get(self, url, headers=None, timeout=None):
        self.urls.append(url)
        if "/api/2/instruments/" in url:
            return FakeResp(200, json.dumps(API)) if "/1/" in url else FakeResp(404, "")
        return FakeResp(200, page_html())


def fund_db(tmp_path):
    conn = db.connect(tmp_path / "fond.db")
    rows = {}
    for iid in (1, 2):
        raw = {"instrument_info": {"instrument_id": iid, "name": f"Fond {iid}", "isin": f"NO000000000{iid}",
                                   "currency": "NOK"},
               "nnx_info": {"display_slug": f"fond-{iid}"}, "statistical_info": {"number_of_owners": 10 * iid}}
        rows[iid] = nordnet.normalize_row(raw, ["NO"])
    db.store(conn, rows, 2, partial=False)
    return conn


def test_fetch_all_stores_and_skips_fresh(tmp_path):
    conn = fund_db(tmp_path)
    cfg = {"timeout_seconds": 5, "retries": 2, "delay_seconds": 0, "refresh_days": 20}
    s = FakeSession()
    n = fdet.fetch_all(conn, cfg, sleep=lambda _: None, session=s)
    assert n == {"todo": 2, "api_ok": 1, "page_ok": 2}
    assert any(u.endswith("/fond/liste/fond-1") for u in s.urls)
    det = fdet.load_details(conn)
    api, page, fetched = det[1]
    assert set(api) == {"risk_statistics", "morningstar_info", "inception_date", "is_index_fund"}  # no holdings
    assert page == RISK and det[2][0] is None
    # Fund 1 is fresh and complete; fund 2 had no API answer (404) and is tried again.
    assert [t[0] for t in fdet.funds_to_fetch(conn, 20)] == [2]


def test_load_details_without_table():
    assert fdet.load_details(sqlite3.connect(":memory:")) == {}
