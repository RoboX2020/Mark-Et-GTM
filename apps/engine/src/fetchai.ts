import type { AgentMessage, Persona, SocialEdge } from "@market/core";
import type { EventBus } from "./bus.js";

/**
 * Client for the Python uAgents bridge (agents/fetch). Each persona is
 * registered as a uAgent with its social neighbours; word-of-mouth messages
 * are then sent agent-to-agent over the Fetch.ai protocol and the bridge
 * returns what was actually delivered. If the bridge is unreachable the
 * simulation keeps local delivery and logs it.
 */
export class FetchBridge {
  private ok = true;
  constructor(private url: string, private bus: EventBus) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async register(personas: Persona[], neighbours: Map<string, SocialEdge[]>) {
    try {
      const r = await this.post<{ registered: number }>("/register", {
        agents: personas.map((p) => ({ id: p.id, name: p.name, neighbours: (neighbours.get(p.id) ?? []).map((e) => e.target) })),
      });
      this.bus.log(`Fetch.ai bridge: ${r.registered} uAgents registered`);
    } catch (err) {
      this.ok = false;
      this.bus.log(`Fetch.ai bridge unavailable (${(err as Error).message.slice(0, 120)}); using local message delivery`, "warn");
    }
  }

  async relay(round: number, messages: AgentMessage[]): Promise<AgentMessage[]> {
    if (!this.ok || !messages.length) return messages;
    try {
      const r = await this.post<{ delivered: AgentMessage[] }>("/relay", { round, messages });
      return r.delivered.map((m) => ({ ...m, transport: "fetchai" as const }));
    } catch (err) {
      this.ok = false;
      this.bus.log(`Fetch.ai relay failed (${(err as Error).message.slice(0, 120)}); falling back to local delivery`, "warn");
      return messages;
    }
  }
}
