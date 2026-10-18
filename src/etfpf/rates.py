"""Norwegian risk-free rate (Norges Bank policy rate) as a monthly series.

The monthly workflow fetches the daily policy rate from Norges Bank's open SDMX API and stores it in
data/prices/rates.parquet. If the fetch fails (or has never run), a built-in table of policy-rate
decisions is used instead. The policy rate (sight deposit rate) is close to NOWA and 3-month
treasury bills, which is good enough for Sharpe ratios and alpha.
"""
import io
import logging
from pathlib import Path

import pandas as pd
import requests

log = logging.getLogger(__name__)

NB_URL = "https://data.norges-bank.no/api/data/IR/B.KPRA.SD.R?format=csv&startPeriod={start}&locale=en"

# Policy rate decisions (effective date, % per year). Fallback only; the fetched series wins.
POLICY_RATE_FALLBACK = [
    ("2006-12-13", 3.50), ("2007-03-15", 3.75), ("2007-05-31", 4.00), ("2007-06-27", 4.25),
    ("2007-08-15", 4.50), ("2007-09-26", 4.75), ("2007-12-12", 5.25), ("2008-06-25", 5.75),
    ("2008-10-15", 5.25), ("2008-10-29", 4.75), ("2008-12-17", 3.00), ("2009-02-04", 2.50),
    ("2009-03-25", 2.00), ("2009-05-06", 1.50), ("2009-06-17", 1.25), ("2009-10-28", 1.50),
    ("2009-12-16", 1.75), ("2010-05-05", 2.00), ("2011-05-12", 2.25), ("2011-12-14", 1.75),
    ("2012-03-14", 1.50), ("2014-12-11", 1.25), ("2015-06-18", 1.00), ("2015-09-24", 0.75),
    ("2016-03-17", 0.50), ("2018-09-20", 0.75), ("2019-03-21", 1.00), ("2019-06-20", 1.25),
    ("2019-09-19", 1.50), ("2020-03-13", 1.00), ("2020-03-20", 0.25), ("2020-05-07", 0.00),
    ("2021-09-23", 0.25), ("2021-12-16", 0.50), ("2022-03-24", 0.75), ("2022-06-23", 1.25),
    ("2022-08-18", 1.75), ("2022-09-22", 2.25), ("2022-11-03", 2.50), ("2022-12-15", 2.75),
    ("2023-03-23", 3.00), ("2023-05-04", 3.25), ("2023-06-22", 3.75), ("2023-08-17", 4.00),
    ("2023-12-14", 4.50), ("2025-06-19", 4.25), ("2025-09-18", 4.00),
]


def parse_norges_bank_rate_csv(text):
    """Norges Bank IR CSV (semicolon) -> DataFrame[date, rate] with rate in % per year."""
    df = pd.read_csv(io.StringIO(text), sep=";")
    out = pd.DataFrame({"date": pd.to_datetime(df["TIME_PERIOD"]),
                        "rate": pd.to_numeric(df["OBS_VALUE"], errors="coerce")})
    return out.dropna().sort_values("date").reset_index(drop=True)


def fetch_policy_rate(start="2005-01-01", get=requests.get):
    r = get(NB_URL.format(start=start), timeout=60)
    r.raise_for_status()
    df = parse_norges_bank_rate_csv(r.text)
    if len(df) < 100:
        raise ValueError(f"for få observasjoner av styringsrenten ({len(df)})")
    return df


def update_rates(root, get=requests.get):
    """Fetch the policy rate and write rates.parquet. Never raises: returns (ok, message)."""
    path = Path(root) / "rates.parquet"
    try:
        df = fetch_policy_rate(get=get)
    except Exception as e:  # noqa: BLE001 - optional data, the site falls back to the table
        log.warning("Styringsrente fra Norges Bank feilet (%s); siden bruker innebygd tabell", e)
        return False, str(e)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)
    return True, f"{len(df)} observasjoner til {df['date'].max().date()}"


def fallback_daily(end):
    s = pd.Series({pd.Timestamp(d): r for d, r in POLICY_RATE_FALLBACK})
    idx = pd.date_range(s.index[0], end, freq="D")
    return s.reindex(idx).ffill()


def monthly_rf(months, root=None):
    """Monthly risk-free return (decimal) for each month-end in `months` and the source used.

    rf_m = (1 + average annual rate in the month) ** (1/12) - 1."""
    months = pd.DatetimeIndex(months)
    end = months.max() + pd.offsets.MonthEnd(0)
    daily, source = None, "innebygd tabell over styringsrenten"
    path = Path(root) / "rates.parquet" if root else None
    if path is not None and path.exists():
        df = pd.read_parquet(path)
        s = df.set_index(pd.to_datetime(df["date"]))["rate"].sort_index()
        s = s[~s.index.duplicated(keep="last")]
        idx = pd.date_range(min(s.index[0], months.min() - pd.offsets.MonthBegin(1)), end, freq="D")
        fb = fallback_daily(end).reindex(idx)
        daily = s.reindex(idx).ffill().combine_first(fb)
        source = f"Norges Banks styringsrente (til {s.index.max().date()})"
    if daily is None:
        daily = fallback_daily(end)
    avg = daily.resample("ME").mean() / 100.0
    avg = avg.reindex(months, method="ffill").fillna(avg.iloc[0])
    return ((1 + avg) ** (1 / 12) - 1), source
