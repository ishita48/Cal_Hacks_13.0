"""Record the canonical demo run headlessly and save its event log.

    cd backend && PYTHONPATH=. uv run python tools/record_demo.py [demo/blackwell_leak.json]

Drives the two-minute script in simulation time with the real WorldEngine (no server, no wall
clock): leak -> Maya's agent off -> on -> spoken rule -> approve -> HAVEN acts until the approved plan
is done. The input events (with their sim steps) are written to demo/blackwell_leak.json, which
`POST /api/runs/import` loads on any machine so the demo replays deterministically if the hardware
or the network flakes. Re-run it after any change to the planner or the physics.
"""

import asyncio
import json
import sys

from haven.agents.rules import parse_rule
from haven.world.engine import WorldEngine
from haven.world.events import AgentToggle, ManagerRule, PlanDecision, SensorReading
from haven.world.state import DT, advance
from haven.world.store import EventStore

OUT = sys.argv[1] if len(sys.argv) > 1 else "demo/blackwell_leak.json"
RULE = "Fine, but nobody gets moved off campus."


async def main() -> None:
    eng = WorldEngine(EventStore())
    run_id = eng.state.run_id

    async def run(seconds: float) -> None:
        for _ in range(int(seconds / DT)):
            advance(eng.state, eng.ctx)
            await eng._execute_due()

    await run(5)
    await eng.submit(SensorReading(sensor_id="basement_mech_1", value=0.85, source="esp32"))
    print("leak at", eng.state.step, "forecast events", len(eng.state.forecast.events))
    await run(20)
    await eng.submit(AgentToggle(agent="resident:maya", enabled=False))          # the Maya moment
    print("maya off:", eng.state.plan.headline)
    await run(15)
    await eng.submit(AgentToggle(agent="resident:maya", enabled=True))
    print("maya on: ", eng.state.plan.headline)
    await run(10)
    parsed = parse_rule(RULE)
    await eng.submit(ManagerRule(text=RULE, code=parsed.code))
    await run(10)
    version = eng.state.plan.version
    await eng.submit(PlanDecision(plan_version=version, decision="approve"))
    print("approved v", version, "at", eng.state.step)

    for _ in range(45 * 6):                       # up to 45 sim-minutes, in 10 s slices
        await run(10)
        ap = eng.state.approved_plan
        if ap is not None and ap.status == "done":
            break
    st = eng.state
    print("done:", st.approved_plan.status, "| moved", len(st.moved), "| maya at", st.moved.get("maya"),
          "| left behind", st.approved_plan.left_behind, "| valve", st.equipment["main_valve"].status,
          "| sim min", round(st.step * DT / 60, 1))

    events = eng.store.events(run_id)
    payload = {
        "scenario": "blackwell_basement_leak",
        "label": "demo",
        "recorded_from": run_id,
        "events": [{"step": e.step, "event": e.event.model_dump(mode="json")} for e in events],
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)
    print(f"wrote {OUT}: {len(events)} events")


if __name__ == "__main__":
    asyncio.run(main())
