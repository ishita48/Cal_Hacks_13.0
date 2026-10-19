"""Append-only event log.

SQLite locally (zero setup); the same interface can be backed by Postgres in deploy.
Runs group events: each scenario reset starts a new run, and replay re-emits one run.
"""

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from pydantic import TypeAdapter

from .events import InputEvent, LoggedEvent

_event_adapter: TypeAdapter[InputEvent] = TypeAdapter(InputEvent)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    scenario TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step INTEGER NOT NULL,
    wall_time REAL NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE TABLE IF NOT EXISTS outcomes (
    run_id TEXT PRIMARY KEY REFERENCES runs(id),
    recorded_at REAL NOT NULL,
    payload TEXT NOT NULL
);
"""


class EventStore:
    def housing_records(self) -> dict:
        """Housing records survive incident resets and process restarts; the input log remains authoritative."""
        records: dict = {}
        with self._lock:
            rows = self._conn.execute("SELECT payload FROM events ORDER BY seq").fetchall()
        for (payload,) in rows:
            event = json.loads(payload)
            if event.get("type") == "housing":
                records.setdefault(event["collection"], {})[event["record_id"]] = event["value"]
        return records

    def __init__(self, path: str | Path = ":memory:") -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_SCHEMA)

    def create_run(self, scenario: str) -> str:
        run_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        with self._lock:
            self._conn.execute(
                "INSERT INTO runs (id, scenario, created_at) VALUES (?, ?, ?)",
                (run_id, scenario, time.time()),
            )
            self._conn.commit()
        return run_id

    def append(self, run_id: str, step: int, event: InputEvent) -> LoggedEvent:
        wall_time = time.time()
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO events (run_id, step, wall_time, payload) VALUES (?, ?, ?, ?)",
                (run_id, step, wall_time, event.model_dump_json()),
            )
            self._conn.commit()
            seq = cur.lastrowid
        assert seq is not None
        return LoggedEvent(seq=seq, run_id=run_id, step=step, wall_time=wall_time, event=event)

    def events(self, run_id: str) -> list[LoggedEvent]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT seq, run_id, step, wall_time, payload FROM events WHERE run_id = ? ORDER BY seq",
                (run_id,),
            ).fetchall()
        return [
            LoggedEvent(
                seq=seq,
                run_id=rid,
                step=step,
                wall_time=wall_time,
                event=_event_adapter.validate_python(json.loads(payload)),
            )
            for seq, rid, step, wall_time, payload in rows
        ]

    def save_outcome(self, run_id: str, outcome: dict) -> None:
        """How an incident ended (minutes to done, left behind, violations, rules): the memory of it."""
        with self._lock:
            self._conn.execute("INSERT OR REPLACE INTO outcomes (run_id, recorded_at, payload) VALUES (?, ?, ?)",
                               (run_id, time.time(), json.dumps(outcome)))
            self._conn.commit()

    def outcomes(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = self._conn.execute("SELECT run_id, recorded_at, payload FROM outcomes ORDER BY recorded_at DESC LIMIT ?",
                                      (limit,)).fetchall()
        return [dict(json.loads(payload), run_id=run_id, recorded_at=at) for run_id, at, payload in rows]

    def rule_history(self, exclude_run: str | None = None, limit: int = 200) -> list[dict]:
        """Manager rules spoken in earlier runs, newest first: the cross-incident memory."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT run_id, wall_time, payload FROM events WHERE payload LIKE '%\"manager_rule\"%' "
                "ORDER BY seq DESC LIMIT ?", (limit,),
            ).fetchall()
        out = []
        for run_id, wall_time, payload in rows:
            if run_id == exclude_run:
                continue
            ev = json.loads(payload)
            if ev.get("type") != "manager_rule":
                continue
            out.append({"run_id": run_id, "time": wall_time, "code": ev["code"], "text": ev["text"], "actor": ev.get("actor", "manager")})
        return out

    def runs(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                """SELECT r.id, r.scenario, r.created_at, COUNT(e.seq)
                   FROM runs r LEFT JOIN events e ON e.run_id = r.id
                   GROUP BY r.id ORDER BY r.created_at DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [
            {"id": rid, "scenario": scenario, "created_at": created_at, "event_count": count}
            for rid, scenario, created_at, count in rows
        ]
