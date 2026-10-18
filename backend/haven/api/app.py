"""HTTP + WebSocket surface. Every route is either a view of the world or a mutator of it."""

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ..world.engine import ReplayActiveError, WorldEngine
from ..world.events import AgentToggle, EquipmentCommand, ManagerRule, PlanDecision, SensorReading
from ..world.state import agent_label
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

    @app.get("/api/building")
    async def get_building():
        return engine.building.model_dump(mode="json")

    @app.get("/api/people")
    async def get_people():
        return engine.roster.model_dump(mode="json")

    @app.post("/api/sensor")
    async def post_sensor(reading: SensorReading, x_haven_token: str | None = Header(default=None)):
        if sensor_token and reading.source == "esp32" and x_haven_token != sensor_token:
            raise HTTPException(401, "bad sensor token")
        try:
            logged = await engine.submit(reading)
        except ReplayActiveError as e:
            raise HTTPException(409, str(e)) from e
        return {"seq": logged.seq, "step": logged.step}

    @app.post("/api/command")
    async def post_command(cmd: EquipmentCommand):
        if cmd.equipment_id not in engine.ctx.equipment:
            raise HTTPException(404, f"unknown equipment {cmd.equipment_id}")
        try:
            logged = await engine.submit(cmd)
        except ReplayActiveError as e:
            raise HTTPException(409, str(e)) from e
        return {"seq": logged.seq, "step": logged.step}

    async def _submit(event):
        try:
            logged = await engine.submit(event)
        except ReplayActiveError as e:
            raise HTTPException(409, str(e)) from e
        return {"seq": logged.seq, "step": logged.step}

    @app.get("/api/agents")
    async def get_agents():
        return [{"id": a, "label": agent_label(engine.ctx, a), "enabled": on}
                for a, on in engine.state.agents.items()]

    @app.post("/api/agent")
    async def post_agent(toggle: AgentToggle):
        if toggle.agent not in engine.state.agents:
            raise HTTPException(404, f"unknown agent {toggle.agent}")
        return await _submit(toggle)

    @app.post("/api/rule")
    async def post_rule(rule: ManagerRule):
        return await _submit(rule)

    @app.post("/api/plan/decision")
    async def post_decision(decision: PlanDecision):
        return await _submit(decision)

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
