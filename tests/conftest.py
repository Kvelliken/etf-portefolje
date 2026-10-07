import json

import pytest

ASK = ["IE", "LU", "DE", "FR", "SE", "NO"]


def make_row(iid, isin, name, symbol="SYM", currency="EUR", clearing="PERS_DE", fee=0.2, owners=100,
             category="Aksjer Global", dividend="Akkumulerende"):
    return {
        "instrument_info": {
            "instrument_id": iid, "name": name, "long_name": name, "symbol": symbol,
            "instrument_group_type": "PAR", "instrument_type_hierarchy": "WNT/PAR/UETF",
            "instrument_type": "UETF", "isin": isin, "currency": currency, "price_unit": currency,
            "clearing_place": clearing, "is_tradable": True, "issuer_name": "Utsteder",
            "is_monthly_saveable": False, "instrument_icon_url": "https://example.com/x.png"},
        "price_info": {"last": {"price": 12.5, "decimals": 2}, "diff_pct": 0.3},
        "historical_returns_info": {"yield_1y": 14.2, "yield_3y": 30.1},
        "etf_info": {"ongoing_charges": fee, "dividend_policy": dividend, "category_name": category},
        "statistical_info": {"number_of_owners": owners},
    }


def make_page_html(rows, total, escaped=True):
    """Build HTML resembling Nordnet's: JSON state embedded as an escaped JS string literal."""
    state = {"data": {"etflist?limit=100&sort_attribute=yield_1y&sort_order=desc":
                      {"rows": len(rows), "total_hits": total, "results": rows}}}
    js = json.dumps(state, ensure_ascii=True)
    if escaped:
        literal = json.dumps(js)  # JS string literal: escapes " as \" and \ as \\
        body = f'<script>window.__STATE__ = JSON.parse({literal});</script>'
    else:
        body = f'<script type="application/json">{js}</script>'
    return f"<!doctype html><html><head><title>ETF-liste</title></head><body><div id=app></div>{body}</body></html>"


@pytest.fixture
def ask():
    return ASK
