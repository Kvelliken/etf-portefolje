import pytest

from etfpf import db


def row(iid, name, fee=0.2, isin="IE0000000001", **kw):
    r = {c: None for c in db.DATA_COLS + db.SNAPSHOT_ONLY}
    r.update(instrument_id=iid, isin=isin, symbol=f"S{iid}", name=name, currency="EUR", fee=fee, is_tradable=True)
    r.update(kw)
    return r


@pytest.fixture
def conn(tmp_path):
    return db.connect(tmp_path / "etf.db")


def changes(conn, run_id):
    return sorted(conn.execute("SELECT instrument_id, change, field, old, new FROM changes WHERE run_id=?",
                               (run_id,)).fetchall())


def test_first_run_all_new(conn):
    res = db.store(conn, {1: row(1, "A"), 2: row(2, "B")}, 2, partial=False, now="t1")
    assert res["run_id"] == 1 and sorted(res["new"]) == [1, 2]
    assert conn.execute("SELECT COUNT(*) FROM etf_snapshot WHERE run_id=1").fetchone()[0] == 2


def test_diff_new_gone_changed_reappeared(conn):
    db.store(conn, {i: row(i, f"E{i}") for i in range(1, 11)}, 10, False, now="t1")
    run2 = {i: row(i, f"E{i}") for i in range(2, 12)}  # 1 gone, 11 new
    run2[5] = row(5, "E5 nytt navn", fee=0.15)
    res = db.store(conn, run2, 10, False, now="t2")
    assert res["new"] == [11] and res["gone"] == [1] and res["changed"] == 2
    ch = changes(conn, 2)
    assert (1, "gone", None, "E1", None) in ch
    assert (5, "changed", "fee", "0.2", "0.15") in ch
    assert (5, "changed", "name", "E5", "E5 nytt navn") in ch
    assert conn.execute("SELECT active, delisted_at FROM etf_master WHERE instrument_id=1").fetchone() == (0, "t2")
    # ETF 1 comes back
    run3 = dict(run2)
    run3[1] = row(1, "E1")
    res = db.store(conn, run3, 11, False, now="t3")
    assert res["reappeared"] == [1] and res["gone"] == []
    assert conn.execute("SELECT active, delisted_at FROM etf_master WHERE instrument_id=1").fetchone() == (1, None)


def test_partial_run_never_marks_gone(conn):
    db.store(conn, {i: row(i, f"E{i}") for i in range(1, 101)}, 100, False, now="t1")
    res = db.store(conn, {1: row(1, "E1")}, 100, partial=True, now="t2")
    assert res["gone"] == []
    assert conn.execute("SELECT COUNT(*) FROM etf_master WHERE active=1").fetchone()[0] == 100


def test_safety_check_below_90_percent(conn):
    db.store(conn, {i: row(i, f"E{i}") for i in range(1, 101)}, 100, False, now="t1")
    with pytest.raises(db.SafetyCheckError):
        db.store(conn, {i: row(i, f"E{i}") for i in range(1, 90)}, 100, False, now="t2")
    # nothing written
    assert conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM etf_master WHERE active=1").fetchone()[0] == 100
    # 90 % is fine
    db.store(conn, {i: row(i, f"E{i}") for i in range(1, 91)}, 100, False, now="t3")


def test_zero_rows_fails(conn):
    with pytest.raises(db.SafetyCheckError):
        db.store(conn, {}, 0, partial=True)


def test_numeric_type_noise_is_not_a_change(conn):
    db.store(conn, {1: row(1, "A", fee=0.2)}, 1, False, now="t1")
    res = db.store(conn, {1: row(1, "A", fee="0.2", is_tradable=1)}, 1, False, now="t2")
    assert res["changed"] == 0


def test_migrates_legacy_db(tmp_path):
    import sqlite3
    p = tmp_path / "old.db"
    c = sqlite3.connect(p)
    c.executescript("""CREATE TABLE etf_master(instrument_id INTEGER PRIMARY KEY, isin TEXT, symbol TEXT, name TEXT,
        long_name TEXT, currency TEXT, clearing_place TEXT, issuer_name TEXT, instrument_type TEXT,
        first_seen TEXT, last_seen TEXT, active INTEGER DEFAULT 1, delisted_at TEXT);
        CREATE TABLE runs(run_id INTEGER PRIMARY KEY AUTOINCREMENT, run_at TEXT, total_hits INTEGER, n_found INTEGER);
        INSERT INTO etf_master(instrument_id, isin, name, active) VALUES (1, 'IE0000000001', 'A', 1);""")
    c.commit(); c.close()
    conn = db.connect(p)
    res = db.store(conn, {1: row(1, "A")}, 1, False, now="t2")
    assert res["new"] == [] and res["gone"] == []
