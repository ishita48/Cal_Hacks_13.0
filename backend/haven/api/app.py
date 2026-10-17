"""HTTP + WebSocket surface. Every route is either a view of the world or a mutator of it."""

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ..world.engine import ReplayActiveError, WorldEngine
from ..world.events import SensorReading
from ..world.store import EventStore


def create_app(store: EventStore | None = None, run_loop: bool = True) -> FastAPI:
    store = store or EventStore(os.environ.get("HAVEN_DB", "data/haven.db"))
    engine = WorldEngine(store)
    sensor_token = os.environ.get("HAVEN_SENSOR_TOKEN")

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if run_loop:
            await engine.start()
        yield
        await engine.stop()

    app = FastAPI(title="HAVEN world-state service", lifespan=lifespan)
    app.state.engine = engine
    app.add_middleware(
        CORSMiddleware,
        allow_origins=os.environ.get("HAVEN_CORS_ORIGINS", "*").split(","),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health():
        return {"ok": True, "run_id": engine.state.run_id, "step": engine.state.step}

    @app.get("/api/state")
    async def get_state():
        return engine.snapshot()

    @app.post("/api/sensor")
    async def post_sensor(reading: SensorReading, x_haven_token: str | None = Header(default=None)):
        if sensor_token and reading.source == "esp32" and x_haven_token != sensor_token:
            raise HTTPException(401, "bad sensor token")
        try:
            logged = await engine.submit(reading)
        except ReplayActiveError as e:
            raise HTTPException(409, str(e)) from e
        return {"seq": logged.seq, "step": logged.step}

    class ClockBody(BaseModel):
        playing: bool | None = None
        speed: float | None = Field(default=None, gt=0)

    @app.post("/api/clock")
    async def post_clock(body: ClockBody):
        await engine.set_clock(body.playing, body.speed)
        return engine.clock()

    @app.post("/api/scenario/reset")
    async def reset():
        state = await engine.reset()
        return {"run_id": state.run_id}

    @app.get("/api/runs")
    async def runs():
        return store.runs()

    @app.get("/api/runs/{run_id}/events")
    async def run_events(run_id: str):
        return [e.model_dump(mode="json") for e in store.events(run_id)]

    class ReplayBody(BaseModel):
        run_id: str
        speed: float | None = Field(default=None, gt=0)

    @app.post("/api/replay")
    async def replay(body: ReplayBody):
        if not any(r["id"] == body.run_id for r in store.runs(limit=10_000)):
            raise HTTPException(404, "unknown run")
        state = await engine.start_replay(body.run_id, body.speed)
        return {"run_id": state.run_id, "mode": state.mode}

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        q = engine.subscribe()
        try:
            while True:
                msg = await q.get()
                await socket.send_json(msg)
        except (WebSocketDisconnect, asyncio.CancelledError, RuntimeError):
            pass
        finally:
            engine.unsubscribe(q)

    return app
