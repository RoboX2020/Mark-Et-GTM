"""Fetch.ai uAgents bridge for the Mark-Et swarm.

Every synthetic customer becomes a uAgent. Word-of-mouth messages from the
simulation are not delivered by the engine directly. A coordinator agent tells
each speaker to message its friend, and the speaker sends a `WordOfMouth`
message to the friend's agent address over the uAgents protocol. Only messages
the receiving agent actually handled are reported back as delivered.

HTTP API (used by apps/engine/src/fetchai.ts):
  POST /register {agents: [{id, name, neighbours: [id]}]}  -> {registered}
  POST /relay    {round, messages: [AgentMessage]}          -> {delivered: [AgentMessage]}
  GET  /health

Agents run in a local Bureau without endpoints, so nothing is registered on the
Almanac and no wallet funds are needed. Set AGENTVERSE_API_KEY and
FETCH_MAILBOX=true to expose agents through Agentverse mailboxes instead.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
from collections import defaultdict

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from uagents import Agent, Bureau, Context, Model

log = logging.getLogger("bridge")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

PORT = int(os.environ.get("FETCH_BRIDGE_PORT", "8100"))
BUREAU_PORT = int(os.environ.get("FETCH_BUREAU_PORT", "8101"))
RELAY_TIMEOUT_S = float(os.environ.get("FETCH_RELAY_TIMEOUT", "8"))
READY_TIMEOUT_S = float(os.environ.get("FETCH_READY_TIMEOUT", "120"))
PROBE = "__probe__"
SEED_SALT = os.environ.get("FETCH_SEED_SALT") or secrets.token_hex(8)


# ── uAgents protocol messages ─────────────────────────────────────────────────


class WordOfMouth(Model):
    round: int
    from_id: str
    to_id: str
    text: str
    sentiment: float


class Speak(Model):
    """Coordinator → speaker: please tell your friend this."""

    round: int
    to_id: str
    text: str
    sentiment: float


# ── HTTP payloads ─────────────────────────────────────────────────────────────


class AgentSpec(BaseModel):
    id: str
    name: str
    neighbours: list[str] = []


class RegisterReq(BaseModel):
    agents: list[AgentSpec]


class Msg(BaseModel):
    round: int
    to: str
    text: str
    sentiment: float
    transport: str = "local"
    # "from" is a Python keyword; accept it via alias.
    from_: str

    model_config = {"populate_by_name": True, "extra": "ignore"}

    def __init__(self, **data):
        if "from" in data:
            data["from_"] = data.pop("from")
        super().__init__(**data)

    def out(self) -> dict:
        return {"round": self.round, "from": self.from_, "to": self.to, "text": self.text, "sentiment": self.sentiment, "transport": "fetchai"}


class RelayReq(BaseModel):
    round: int
    messages: list[Msg]


# ── Swarm state ───────────────────────────────────────────────────────────────


class Swarm:
    """Holds every uAgent the bridge has started.

    Bureaus are never torn down (cancelling a running Bureau is unreliable), so
    agents persist across runs: a re-registered id reuses its agent with the new
    social ties, and only unseen ids are started, in a fresh Bureau.
    """

    def __init__(self) -> None:
        self.agents: dict[str, Agent] = {}
        self.neighbours: dict[str, set[str]] = {}
        self.outbox: asyncio.Queue[tuple[str, Speak]] = asyncio.Queue()
        self.delivered: dict[int, list[dict]] = defaultdict(list)
        self.tasks: list[asyncio.Task] = []
        self.generation = 0
        self.ready = asyncio.Event()

    async def register(self, specs: list[AgentSpec]) -> int:
        loop = asyncio.get_running_loop()
        self.delivered.clear()
        self.neighbours = {s.id: set(s.neighbours) for s in specs}
        fresh = [s for s in specs if s.id not in self.agents]
        if not fresh:
            log.info("re-registered %d existing uAgents", len(specs))
            return len(specs)

        self.generation += 1
        self.ready = asyncio.Event()
        bureau = Bureau(port=BUREAU_PORT + self.generation, loop=loop, log_level=logging.WARNING)
        if self.generation == 1:
            coordinator = Agent(name="coordinator", seed=f"mark-et-coordinator-{SEED_SALT}", log_level=logging.WARNING)

            @coordinator.on_interval(period=0.05)
            async def dispatch(ctx: Context) -> None:
                while not self.outbox.empty():
                    speaker_id, speak = self.outbox.get_nowait()
                    speaker = self.agents.get(speaker_id)
                    if speaker:
                        await ctx.send(speaker.address, speak)

            bureau.add(coordinator)
        for spec in fresh:
            agent = self._make_agent(spec)
            self.agents[spec.id] = agent
            bureau.add(agent)
        self.tasks.append(loop.create_task(bureau.run_async()))

        # Agents can take a while to start (the ledger is probed on startup, and that
        # is slow when the network is unreachable). Round-trip a probe before reporting ready.
        await self.outbox.put((fresh[0].id, Speak(round=-1, to_id=PROBE, text="", sentiment=0)))
        try:
            await asyncio.wait_for(self.ready.wait(), READY_TIMEOUT_S)
        except asyncio.TimeoutError:
            log.warning("agents not ready after %.0fs; relays may time out", READY_TIMEOUT_S)
        log.info("registered %d uAgents (%d new, generation %d)", len(specs), len(fresh), self.generation)
        return len(specs)

    def _make_agent(self, spec: AgentSpec) -> Agent:
        agent = Agent(name=spec.id, seed=f"mark-et-{spec.id}-{SEED_SALT}", log_level=logging.WARNING)
        swarm = self

        @agent.on_message(model=Speak)
        async def speak(ctx: Context, sender: str, msg: Speak) -> None:
            if msg.to_id == PROBE:
                swarm.ready.set()
                return
            friend = swarm.agents.get(msg.to_id)
            # Agents only talk to their own social ties.
            if friend is None or msg.to_id not in swarm.neighbours.get(spec.id, set()):
                return
            await ctx.send(friend.address, WordOfMouth(round=msg.round, from_id=spec.id, to_id=msg.to_id, text=msg.text, sentiment=msg.sentiment))

        @agent.on_message(model=WordOfMouth)
        async def hear(ctx: Context, sender: str, msg: WordOfMouth) -> None:
            if msg.to_id != spec.id:
                return
            swarm.delivered[msg.round].append(
                {"round": msg.round, "from": msg.from_id, "to": msg.to_id, "text": msg.text, "sentiment": msg.sentiment, "transport": "fetchai"}
            )

        return agent

    async def relay(self, round_: int, messages: list[Msg]) -> list[dict]:
        self.delivered[round_] = []
        expected = 0
        for m in messages:
            if m.from_ in self.agents and m.to in self.neighbours.get(m.from_, set()):
                expected += 1
                await self.outbox.put((m.from_, Speak(round=round_, to_id=m.to, text=m.text, sentiment=m.sentiment)))
        deadline = asyncio.get_running_loop().time() + RELAY_TIMEOUT_S
        while len(self.delivered[round_]) < expected and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.05)
        got = self.delivered[round_]
        if len(got) < expected:
            log.warning("round %d: %d/%d messages delivered before timeout", round_, len(got), expected)
        return list(got)


swarm = Swarm()
app = FastAPI(title="Mark-Et Fetch.ai bridge")


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "agents": len(swarm.agents)}


@app.post("/register")
async def register(req: RegisterReq) -> dict:
    return {"registered": await swarm.register(req.agents)}


@app.post("/relay")
async def relay(req: RelayReq) -> dict:
    return {"delivered": await swarm.relay(req.round, req.messages)}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
