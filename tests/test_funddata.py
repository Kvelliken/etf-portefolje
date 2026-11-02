import json
import re
import sqlite3

import numpy as np
import pandas as pd
import pytest

from etfpf import funddata as fd


def test_annualize():
    assert fd.annualize(21, 2) == pytest.approx(0.1)
    assert fd.annualize(None, 3) is None
    assert fd.annualize("x", 3) is None
    assert fd.annualize(-100, 1) is None


def raw_fund(name="Test Global Indeks A", fund_type="Indeks", yearly=0.5, refund=0.2, platform=0.15, total=0.45):
    return {
        "instrument_info": {"long_name": name},
        "nnx_info": {"display_slug": "test-global-indeks-a-abc123"},
        "fund_info": {"fund_yearly_fee": yearly, "fund_refunding": refund, "fund_platform_fee": platform,
                      "fund_total_fee": total, "fund_branding_company": "Testfond", "fund_min_investment": 100,
                      "fund_nordnet_selection": True, "fund_raw_sfdr": 8, "fund_esg_score": 20},
        "historical_returns_info": {"yield_1y": 10.0, "yield_3y": 33.1, "yield_5y": None, "yield_10y": 159.37,
                                    "yield_ytd": 5.0, "yield_1m": 1.0, "yield_3m": 2.0},
    }


def master_row(raw, domicile="NO", **kw):
    r = {"isin": "NO0000000001", "symbol": "TGI", "name": raw["instrument_info"]["long_name"], "currency": "NOK",
         "category": "Global Equity Large Cap", "fund_type": "Indeks", "fee": 0.5, "total_fee": 0.45,
         "number_of_owners": 100, "dividend_policy": "Akkumuleres i fondet", "risk": 4, "rating": 3,
         "fund_size": 2e9, "start_date": "2010-05-01", "domicile": domicile, "is_tradable": "1", "raw": raw,
         "run_at": "2026-11-02T06:00:00+00:00"}
    r.update(kw)
    return pd.Series(r)


def test_fund_row_costs_returns_and_ask():
    hedged = re.compile(r"(?<!tail )hedg|\bhdg\b", re.I)
    f = fd.fund_row(master_row(raw_fund()), {"NO", "SE"}, hedged)
    assert f["cost"] == 0.45 and f["fee"] == 0.5 and f["kickback"] == 0.2 and f["platform_fee"] == 0.15
    assert f["r1"] == pytest.approx(0.10) and f["r3"] == pytest.approx(0.10, abs=1e-4)
    assert f["r5"] is None and f["r10"] == pytest.approx(0.10, abs=1e-4)
    assert f["ask"] is True and f["index"] is True and f["acc"] is True and f["hedged"] is False
    assert f["company"] == "Testfond" and f["sfdr"] == 8 and f["start_year"] == 2010
    assert f["url"] == "https://www.nordnet.no/fond/liste/test-global-indeks-a-abc123"
    assert f["asset_class"] == "Aksjer" and f["region"] == "Global"
    g = fd.fund_row(master_row(raw_fund("Aktiv Fond NOK Hedged", "Aksje"), domicile="CH", fund_type="Aksje"),
                    {"NO"}, hedged)
    assert g["ask"] is False and g["index"] is False and g["hedged"] is True


def test_etf_returns_to_same_date():
    idx = pd.bdate_range("2014-01-01", "2026-11-02")
    growth = 1.0004 ** np.arange(len(idx))
    prices = pd.DataFrame({"A": 100 * growth, "B": np.nan}, index=idx)
    prices.loc[prices.index >= "2024-01-01", "B"] = 50.0
    out = fd.etf_returns(prices, "2026-11-02")
    a = out["A"]
    assert all(v is not None for v in a) and a[0] > 0
    assert out["B"][0] == pytest.approx(0.0) and out["B"][2] is None and out["B"][3] is None
    stale = prices.copy(); stale.loc[stale.index > "2026-10-01", "A"] = np.nan
    assert "A" not in fd.etf_returns(stale[["A"]], "2026-11-02")


def test_export_roundtrip(tmp_path):
    from etfpf import db, nordnet
    conn = db.connect(tmp_path / "fond.db")
    raw = raw_fund()
    raw["instrument_info"].update({"instrument_id": 1, "name": "Test Global Indeks A", "symbol": "TGI",
                                   "isin": "NO0000000001", "currency": "NOK", "is_tradable": True})
    raw["fund_info"].update({"fund_category": "Global Equity Large Cap", "fund_type": "Indeks",
                             "fund_dividend_strategy": "Akkumuleres i fondet"})
    db.store(conn, {1: nordnet.normalize_row(raw, ["NO"])}, 1, partial=False)
    cfg = {"account": {"ask_countries": ["NO"]}, "universe": {"hedged_name_regex": "hedg"}}
    idx = pd.bdate_range("2020-01-01", pd.Timestamp.today())
    prices = pd.DataFrame({"IE0000000002": np.linspace(100, 150, len(idx))}, index=idx)
    info = fd.export(conn, prices, cfg, tmp_path)
    d = json.loads((tmp_path / "funds.json").read_text())
    assert info["n"] == 1 and d["n"] == 1 and d["funds"][0]["isin"] == "NO0000000001"
    assert d["funds"][0]["r1"] == pytest.approx(0.10) and d["periods"] == [1, 3, 5, 10]
    assert "IE0000000002" in d["etf_returns"]
