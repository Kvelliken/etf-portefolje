"""Loads config.yaml. All thresholds live there, never hard-coded."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def load_config(path=None):
    path = Path(path) if path else ROOT / "config.yaml"
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def resolve(p):
    """Resolve a path from config relative to the repo root."""
    p = Path(p)
    return p if p.is_absolute() else ROOT / p
