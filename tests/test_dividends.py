import numpy as np
import pandas as pd

from etfpf import dividends as dv


def _panel(days=1500, missing=True):
    """Two ETFs on the same index: an accumulating one (total return 8 % a year) and a distributing one
    that pays 3 % a year in dividends. With `missing`, the distributing one's dividends are not in the data."""
    idx = pd.bdate_range("2020-01-01", periods=days)
    t = np.arange(days) / 252
    acc = pd.Series(100 * 1.08 ** t, index=idx)
    price = pd.Series(50 * (1.08 / 1.03) ** t, index=idx)          # price index of the distributing class
    pay = idx[::63][1:]                                             # quarterly
    divs = pd.Series(price.loc[pay].to_numpy() * 0.0074, index=pay)
    tr_dist = price if missing else None
    meta = pd.DataFrame({"accumulating": [1, 0], "cluster_id": [7, 7], "fee": [0.10, 0.10], "fund_size": [1e9, 1e8],
                         "name": ["Index ETF Acc", "Index ETF Dist"]}, index=["ACC", "DIST"])
    return idx, acc, price, divs, tr_dist, meta


def test_trailing_yield():
    idx = pd.bdate_range("2025-01-01", periods=300)
    close = pd.Series(100.0, index=idx)
    divs = pd.Series([1.0, 1.0, 1.0], index=[idx[10], idx[100], idx[250]])
    assert abs(dv.trailing_yield(close, divs) - 0.02) < 1e-12        # the first one is over a year old
    assert dv.trailing_yield(close, pd.Series(dtype=float)) == 0.0
    assert dv.trailing_yield(None, divs) is None


def test_rebuild_follows_reference_and_keeps_last_price():
    idx = pd.bdate_range("2022-01-03", periods=600)
    ref = pd.Series(np.linspace(100, 160, 600), index=idx)
    dist = pd.Series(np.linspace(40, 50, 600), index=idx)
    out = dv.rebuild(dist, ref, 0.0)
    assert abs(out.iloc[-1] - 50) < 1e-9                          # real last price kept
    assert abs(out.iloc[0] / out.iloc[-1] - 100 / 160) < 1e-9      # growth from the reference


def test_check_repairs_missing_dividends_and_flags():
    idx, acc, price, divs, _, meta = _panel()
    px = pd.DataFrame({"ACC": acc, "DIST": price})
    series = {"A": (acc, pd.Series(dtype=float)), "D": (price, pd.Series(dtype=float))}
    out, info, rep = dv.check(meta, px, series, {"ACC": "A", "DIST": "D"})
    assert rep["n_repaired"] == 1 and info["DIST"]["div_fix"] == "ACC"
    g = (out["DIST"].iloc[-1] / out["DIST"].iloc[-253]) - 1
    assert abs(g - 0.08) < 0.002                                   # now earns what the accumulating class earns
    assert abs(out["DIST"].iloc[-1] - price.iloc[-1]) < 1e-9

    # with the dividends in the data (total return already right) nothing is repaired
    tr = price.copy()
    tr[:] = 50 * 1.08 ** (np.arange(len(idx)) / 252)
    px2 = pd.DataFrame({"ACC": acc, "DIST": tr})
    series2 = {"A": (acc, pd.Series(dtype=float)), "D": (price, divs)}
    _, info2, rep2 = dv.check(meta, px2, series2, {"ACC": "A", "DIST": "D"})
    assert rep2["n_repaired"] == 0 and info2["DIST"]["yield12"] > 0.025

    # no accumulating class to repair from, no dividends for a year: flagged
    solo = meta.loc[["DIST"]]
    _, info3, rep3 = dv.check(solo, px[["DIST"]], {"D": (price, pd.Series(dtype=float))}, {"DIST": "D"})
    assert rep3["missing"] == ["DIST"] and info3["DIST"]["div_missing"]
