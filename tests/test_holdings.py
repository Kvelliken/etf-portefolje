import json
import shutil
import sqlite3
import subprocess
from pathlib import Path

import pytest

from etfpf import holdings as hd

ROOT = Path(__file__).resolve().parents[1]
CFG = {"retries": 2, "timeout_seconds": 5, "delay_seconds": 0, "refresh_days": 20, "threads": 1}

API = {
    "regional_allocation": [{"weight": 72.6, "type": "USA"}, {"weight": 0.0, "type": "Afrika"}, {"weight": 27.4, "type": "Eurosonen"}],
    "sector_allocation": [{"weight": 38.3, "type": "Teknologi"}, {"weight": 0.01, "type": "Eiendom"}],
    "asset_allocation": [{"weight": 99.7, "type": "Aksjer"}, {"weight": 0.3, "type": "Kontanter"}],
    "instrument_underlying_info": [{"instrument_id": 2, "weight": 3.5}, {"instrument_id": 1, "weight": 5.9},
                                   {"instrument_id": 3, "weight": 0.0}, {"weight": 1.0}],
    "morningstar_info": {"release_top_holding_date": "2026-10-31"},
}


class Resp:
    def __init__(self, status, data):
        self.status_code, self._d = status, data

    def json(self):
        return self._d


class Session:
    """Answers fund/info per instrument id and the name lookup; counts the calls."""
    def __init__(self):
        self.calls = []

    def get(self, url, headers=None, timeout=None):
        self.calls.append(url)
        if url.endswith("/fund/info"):
            iid = int(url.split("/")[-3])
            return Resp(404, None) if iid == 99 else Resp(200, [API])
        ids = [int(x) for x in url.rsplit("/", 1)[1].split(",")]
        return Resp(200, [{"instrument_id": i, "name": f"Selskap {i}", "isin_code": "US000000000" + str(i), "symbol": f"S{i}"}
                          for i in ids if i != 2])


def test_compact_keeps_what_the_site_needs():
    c = hd.compact(API)
    assert c["reg"] == {"USA": 72.6, "Eurosonen": 27.4}            # zero slices dropped
    assert c["sec"] == {"Teknologi": 38.3}                         # below MIN_WEIGHT dropped
    assert c["top"] == [[1, 5.9], [2, 3.5]]                        # sorted, zero weight and broken rows dropped
    assert c["date"] == "2026-10-31"
    assert hd.compact({}) is None and hd.compact(None) is None


def test_fetch_names_export_and_refresh(tmp_path):
    h = hd.connect(tmp_path / "h.db")
    items = [("NO001", "fond", 10), ("IE002", "etf", 11), ("XX099", "etf", 99)]
    s = Session()
    n = hd.fetch_all(h, items, CFG, sleep=lambda x: None, session=s)
    assert n == {"todo": 3, "ok": 2}
    assert hd.to_fetch(h, items, 20) == []                          # all fresh, also the 404
    assert hd.fetch_all(h, items, CFG, sleep=lambda x: None, session=s)["todo"] == 0
    names = hd.fetch_names(h, CFG, sleep=lambda x: None, session=s)
    assert names == {"asked": 2, "found": 1}
    assert hd.missing_names(h) == []                                # the unknown id is remembered as unknown
    info = hd.export(h, tmp_path)
    out = json.loads((tmp_path / "innhold.json").read_text())
    assert info["n"] == 2 and set(out["items"]) == {"NO001", "IE002"}
    assert out["items"]["NO001"]["top"] == [[1, 5.9]]               # holding without a name is left out
    assert out["names"] == {"1": ["Selskap 1", "US"]}


def test_instruments_one_per_isin():
    c = sqlite3.connect(":memory:")
    c.execute("CREATE TABLE etf_master(isin, instrument_id, active, number_of_owners)")
    c.executemany("INSERT INTO etf_master VALUES (?,?,?,?)", [("A", 1, 1, 5), ("A", 2, 1, 9), ("B", 3, 0, 1), (None, 4, 1, 1)])
    assert hd.instruments(c, "etf") == [("A", "etf", 2)]


# ---------------------------------------------------------------- insight.js (node)

def node(js):
    return json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)


@pytest.mark.skipif(shutil.which("node") is None, reason="node mangler")
def test_insight_js():
    out = node(f"""
const I = require({json.dumps(str(ROOT / 'site' / 'insight.js'))});
const r = Float64Array.from([0.1, -0.5, 0.2, 0.2, 0.2, 0.2, 0.2, 0, 0, 0, 0, 0, 0, 0.1]);
const s = I.riskStory(r, 0, r.length - 1);
const A = {{ reg: {{ USA: 70, Japan: 30 }}, sec: {{ Tek: 50, Finans: 50 }}, ast: {{ Aksjer: 100 }}, top: [[1, 5], [2, 4], [3, 3], [4, 2], [5, 1]] }};
const B = {{ reg: {{ USA: 70, Japan: 30 }}, sec: {{ Tek: 50, Finans: 50 }}, ast: {{ Aksjer: 100 }}, top: [[1, 5], [2, 4], [3, 3], [4, 2], [5, 1]] }};
const C = {{ reg: {{ Japan: 100 }}, sec: {{ Finans: 100 }}, ast: {{ Aksjer: 100 }}, top: [[6, 9], [7, 8], [8, 7], [9, 6], [5, 1]] }};
const R = {{ ast: {{ Obligasjoner: 90, Kontanter: 10 }}, reg: {{}}, sec: {{}}, top: [] }};
const rf = new Float64Array(72).fill(0.003), proxy = Float64Array.from({{ length: 72 }}, (_, i) => 0.01 + 0.04 * Math.sin(i));
const ps = I.proxySeries(proxy, rf, 71, {{ k: 1, target: [5, 0.08], drag: 0.012 }});
const syn = I.proxySeries(null, rf, 71, {{ vol: 0.02, target: [3, 0.05] }});
const mkt = Float64Array.from({{ length: 72 }}, (_, i) => 0.006 + 0.045 * Math.cos(i * 1.7));
const cr = I.proxySeries(null, rf, 71, {{ vol: 0.04, mkt, mktVol: 0.045 * Math.sqrt(6), corr: 0.5 }});
const corr = (a, b) => {{ const n = a.length, ma = a.reduce((p, q) => p + q, 0) / n, mb = b.reduce((p, q) => p + q, 0) / n; let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {{ c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }} return c / Math.sqrt(va * vb); }};
const ann = (x, from, to) => {{ let g = 1; for (let t = from; t <= to; t++) g *= 1 + x[t]; return Math.pow(g, 12 / (to - from + 1)) - 1; }};
const sd = (x) => {{ const m = x.reduce((a, b) => a + b, 0) / x.length; return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1) * 12); }};
const pts = [{{ vol: 0.02, w: [1, 0] }}, {{ vol: 0.10, w: [0.5, 0.5] }}, {{ vol: 0.18, w: [0, 1] }}];
console.log(JSON.stringify({{
  cheap: I.savingsValue(0, 1000, 20, 0.07, 0.002), dear: I.savingsValue(0, 1000, 20, 0.07, 0.015), lump: I.savingsValue(1000, 0, 2, 0.1, 0),
  s: {{ worst: s.worst, fall: s.fall, neg: s.negShare }}, same: I.similarity(A, B).score, diff: I.similarity(A, C), none: I.similarity(A, null),
  look: I.lookThrough([{{ w: 0.5, h: A }}, {{ w: 0.3, h: C }}, {{ w: 0.2, h: R }}]),
  crCorr: corr(Array.from(cr), Array.from(mkt)), crVol: sd(Array.from(cr)),
  ps5: ann(ps, 12, 71), early: ps[0] - proxy[0], syn3: ann(syn, 36, 71), synVol: sd(Array.from(syn)),
  mid: Array.from(I.forRisk(pts, 0.06)), low: Array.from(I.forRisk(pts, 0.0)), high: Array.from(I.forRisk(pts, 0.5)),
}}));
""")
    # the owner's example: 1 000 kr a month for 20 years at 7 % is about 499 000 with 0.2 % fee and 431 000 with 1.5 %
    assert round(out["cheap"], -3) == 499000 and round(out["dear"], -3) == 431000
    assert abs(out["lump"] - 1210) < 1e-6
    s = out["s"]
    assert s["fall"]["peak"] == 0 and s["fall"]["trough"] == 1 and abs(s["fall"]["depth"] + 0.5) < 1e-12
    assert s["fall"]["recovered"] == 5 and s["fall"]["monthsBack"] == 4 and s["fall"]["monthsDown"] == 1   # 0.5 * 1.2^4 > 1
    assert s["worst"]["from"] == 1 and abs(s["worst"]["ret"] - (0.5 * 1.2 ** 5 - 1)) < 1e-9
    assert abs(out["same"] - 1) < 1e-9 and out["none"] is None
    d = out["diff"]
    assert abs(d["reg"] - 0.3) < 1e-9 and abs(d["sec"] - 0.5) < 1e-9 and abs(d["top"] - 1 / 15) < 1e-9 and d["score"] < 0.3
    look = out["look"]
    assert abs(look["ast"]["Aksjer"] - 0.8) < 1e-9 and abs(look["ast"]["Obligasjoner"] - 0.18) < 1e-9
    assert abs(look["reg"]["USA"] - 0.35 / 0.8) < 1e-9 and abs(sum(look["reg"].values()) - 1) < 1e-9
    comp = {str(k): v for k, v in look["companies"]}
    assert abs(comp["1"] - 0.025) < 1e-9 and abs(comp["5"] - (0.005 + 0.003)) < 1e-9       # held by two funds: added up
    assert abs(out["ps5"] - 0.08) < 1e-6                 # last five years give exactly the fund's reported return
    assert abs(out["early"] + 0.001) < 1e-9              # before that: the proxy minus the cost difference
    assert abs(out["syn3"] - 0.05) < 1e-6 and abs(out["synVol"] - 0.02) < 0.004
    assert 0.3 < out["crCorr"] < 0.7 and abs(out["crVol"] - 0.04) < 0.008      # credit fund: follows the market halfway
    assert out["mid"] == pytest.approx([0.75, 0.25]) and out["low"] == [1, 0] and out["high"] == [0, 1]
