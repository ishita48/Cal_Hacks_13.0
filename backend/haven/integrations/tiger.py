"""Tiger Data (TimescaleDB) sink for live sensor readings.

Key-gated by TIGER_DATABASE_URL (a Postgres URL from Tiger Cloud). Readings are written as a
time-series hypertable so the dashboard can chart the probe; the world itself never reads this
store (the event log is the source of truth, this is the analytics copy).
Without the URL, every call is a no-op and `history` falls back to the event log.
"""

import asyncio
import logging
import os
import time

log = logging.getLogger("haven.tiger")

_DDL = """
CREATE TABLE IF NOT EXISTS sensor_readings (
    time        TIMESTAMPTZ NOT NULL,
    sensor_id   TEXT NOT NULL,
    run_id      TEXT NOT NULL,
    step        INTEGER NOT NULL,
    value       DOUBLE PRECISION NOT NULL,
    wet         BOOLEAN NOT NULL,
    source      TEXT NOT NULL
);
"""
_HYPER = "SELECT create_hypertable('sensor_readings', 'time', if_not_exists => TRUE);"
_INSERT = """INSERT INTO sensor_readings (time, sensor_id, run_id, step, value, wet, source)
             VALUES (to_timestamp(%s), %s, %s, %s, %s, %s, %s)"""
_HISTORY = """SELECT extract(epoch from time), value, wet, source, run_id, step FROM sensor_readings
              WHERE sensor_id = %s ORDER BY time DESC LIMIT %s"""


class TigerSink:
    def __init__(self, url: str | None = None) -> None:
        self.url = url or os.environ.get("TIGER_DATABASE_URL")
        self._ready = False
        self._failed = False

    @property
    def configured(self) -> bool:
        return bool(self.url) and not self._failed

    def _connect(self):
        import psycopg

        return psycopg.connect(self.url, autocommit=True, connect_timeout=5)

    def _ensure(self) -> None:
        if self._ready or self._failed or not self.url:
            return
        try:
            with self._connect() as conn:
                conn.execute(_DDL)
                try:
                    conn.execute(_HYPER)
                except Exception:  # plain Postgres without the timescaledb extension still works
                    log.info("timescaledb extension not available; using a plain table")
            self._ready = True
        except Exception:
            log.exception("Tiger Data unreachable; sensor history disabled")
            self._failed = True

    def _write(self, sensor_id: str, run_id: str, step: int, value: float, wet: bool, source: str) -> None:
        self._ensure()
        if not self._ready:
            return
        try:
            with self._connect() as conn:
                conn.execute(_INSERT, (time.time(), sensor_id, run_id, step, value, wet, source))
        except Exception:
            log.exception("Tiger Data write failed")

    async def record(self, sensor_id: str, run_id: str, step: int, value: float, wet: bool, source: str) -> None:
        if not self.configured:
            return
        await asyncio.to_thread(self._write, sensor_id, run_id, step, value, wet, source)

    def _read(self, sensor_id: str, limit: int) -> list[dict]:
        self._ensure()
        if not self._ready:
            return []
        try:
            with self._connect() as conn:
                rows = conn.execute(_HISTORY, (sensor_id, limit)).fetchall()
        except Exception:
            log.exception("Tiger Data read failed")
            return []
        return [{"time": t, "value": v, "wet": w, "source": s, "run_id": r, "step": st} for t, v, w, s, r, st in rows]

    async def history(self, sensor_id: str, limit: int = 200) -> list[dict]:
        if not self.configured:
            return []
        return await asyncio.to_thread(self._read, sensor_id, limit)
