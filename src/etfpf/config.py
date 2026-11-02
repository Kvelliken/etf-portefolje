"""Loads config.yaml. All thresholds live there, never hard-coded."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def load_config(path=None):
    path = Path(path) if path else ROOT / "config.yaml"
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def list_settings(cfg, kind="etf"):
    """Settings for one Nordnet list: kind 'etf' (default) or 'fond'.

    Returns {nordnet, db, raw_dir, last_fetch, noun}. For 'fond' the fetch parameters come from
    `nordnet` with the url from `funds`, and the fund data lives in its own database and raw dir.
    """
    if kind == "etf":
        return {"nordnet": cfg["nordnet"], "db": cfg["paths"]["db"], "raw_dir": cfg["paths"]["raw_dir"],
                "last_fetch": "data/last_fetch.json", "noun": "ETF-er"}
    if kind == "fond":
        f = cfg["funds"]
        return {"nordnet": dict(cfg["nordnet"], url=f["url"]), "db": f["db"], "raw_dir": f["raw_dir"],
                "last_fetch": f["last_fetch"], "noun": "fond"}
    raise ValueError(f"ukjent liste: {kind}")


def resolve(p):
    """Resolve a path from config relative to the repo root."""
    p = Path(p)
    return p if p.is_absolute() else ROOT / p
