import { useEffect, useMemo, useRef, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from "d3-force";
import type { GraphNode, NodeKind } from "@market/core";
import { useNav, useRun } from "../lib/context";
import { KIND_COLOR, KIND_LABEL, label, pct } from "../lib/format";

interface SimNode extends SimulationNodeDatum {
  id: string;
  kind: NodeKind;
}
interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  id: string;
  weight: number;
}

const RING: Record<NodeKind, number> = { product: 0, segment: 150, competitor: 240, pain: 270, trend: 280, price_point: 230, channel: 300, condition: 340 };

export function Graph() {
  const { state } = useRun();
  const nav = useNav();
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef(new Map<string, SimNode>());
  const [, setTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const nodes = [...state.nodes.values()];
  const edges = [...state.edges.values()];

  useEffect(() => {
    const sim = forceSimulation<SimNode, SimLink>()
      .force("charge", forceManyBody<SimNode>().strength((d) => (d.kind === "product" ? -900 : -260)))
      .force("collide", forceCollide<SimNode>().radius(30))
      .force("center", forceCenter(0, 0))
      .force("x", forceX<SimNode>(0).strength(0.03))
      .force("y", forceY<SimNode>(0).strength(0.03))
      .alphaDecay(0.03)
      .on("tick", () => setTick((t) => t + 1));
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, []);

  // Feed new nodes/edges into the running layout as they stream in.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const map = nodesRef.current;
    let changed = false;
    for (const n of nodes) {
      if (map.has(n.id)) continue;
      const angle = Math.random() * Math.PI * 2;
      const r = RING[n.kind] ?? 200;
      map.set(n.id, { id: n.id, kind: n.kind, x: Math.cos(angle) * r, y: Math.sin(angle) * r, ...(n.kind === "product" ? { fx: 0, fy: 0 } : {}) });
      changed = true;
    }
    for (const id of [...map.keys()]) if (!state.nodes.has(id)) (map.delete(id), (changed = true));
    const links: SimLink[] = edges.filter((e) => map.has(e.source) && map.has(e.target)).map((e) => ({ id: e.id, source: e.source, target: e.target, weight: e.weight }));
    if (changed || (sim.force("link") as any)?.links().length !== links.length) {
      sim.nodes([...map.values()]);
      sim.force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) => 90 + (1 - l.weight) * 80)
          .strength((l) => 0.15 + l.weight * 0.35),
      );
      sim.alpha(0.6).restart();
    }
  }, [nodes.length, edges.length, state.runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const neighbours = useMemo(() => {
    const focus = hover ?? selected;
    if (!focus) return null;
    const s = new Set([focus]);
    for (const e of edges) {
      if (e.source === focus) s.add(e.target);
      if (e.target === focus) s.add(e.source);
    }
    return s;
  }, [hover, selected, edges.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = (id: string) => nodesRef.current.get(id);
  const sel = selected ? state.nodes.get(selected) : undefined;
  const kinds = [...new Set(nodes.map((n) => n.kind))];

  if (!nodes.length) return <div className="empty"><h3>The graph is empty</h3>Nodes appear here as the extractor reads the evidence.</div>;

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h2>Market graph</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            {nodes.length} nodes · {edges.length} relationships · every node cites the posts and market signals behind it
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setView({ x: 0, y: 0, k: 1 })}>Reset view</button>
        </div>
      </div>
      <div className="card graph-wrap">
        <svg
          viewBox="-480 -320 960 640"
          onWheel={(e) => setView((v) => ({ ...v, k: Math.min(3, Math.max(0.4, v.k * (e.deltaY > 0 ? 0.92 : 1.08))) }))}
          onMouseDown={(e) => (drag.current = { x: e.clientX, y: e.clientY })}
          onMouseMove={(e) => {
            if (!drag.current) return;
            const dx = e.clientX - drag.current.x;
            const dy = e.clientY - drag.current.y;
            drag.current = { x: e.clientX, y: e.clientY };
            setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
          }}
          onMouseUp={() => (drag.current = null)}
          onMouseLeave={() => (drag.current = null)}
          onClick={(e) => e.target === e.currentTarget && setSelected(null)}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {edges.map((e) => {
              const a = pos(e.source);
              const b = pos(e.target);
              if (!a || !b || a.x === undefined || b.x === undefined) return null;
              const on = neighbours && neighbours.has(e.source) && neighbours.has(e.target);
              return <line key={e.id} className={`gedge ${neighbours ? (on ? "hot" : "dim") : ""}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y!} strokeWidth={0.6 + e.weight * 1.6} />;
            })}
            {nodes.map((n) => {
              const p = pos(n.id);
              if (!p || p.x === undefined) return null;
              const r = n.kind === "product" ? 16 : 5 + n.weight * 11;
              return (
                <g
                  key={n.id}
                  className={`gnode ${neighbours && !neighbours.has(n.id) ? "dim" : ""}`}
                  transform={`translate(${p.x} ${p.y})`}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setSelected(n.id);
                  }}
                >
                  <circle r={r} fill={KIND_COLOR[n.kind]} fillOpacity={n.kind === "product" ? 1 : 0.85} stroke={selected === n.id ? "var(--ink)" : "var(--card)"} strokeWidth={selected === n.id ? 2 : 1.5} />
                  {(neighbours ? neighbours.has(n.id) : n.kind === "product" || n.kind === "segment" || n.kind === "competitor" || n.kind === "channel" || (n.kind === "pain" && n.weight >= 0.75)) && (
                    <text x={r + 5} y={4}>
                      {n.label.length > 34 ? n.label.slice(0, 33) + "…" : n.label}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="legend graph-legend">
          {kinds.map((k) => (
            <span key={k}>
              <i style={{ background: KIND_COLOR[k], borderRadius: "50%" }} /> {KIND_LABEL[k]}
            </span>
          ))}
        </div>
        {sel && <Inspector node={sel} onClose={() => setSelected(null)} onEvidence={nav.openEvidence} onNode={setSelected} />}
      </div>
    </div>
  );
}

function Inspector({ node, onClose, onEvidence, onNode }: { node: GraphNode; onClose: () => void; onEvidence: (id: string) => void; onNode: (id: string) => void }) {
  const { state } = useRun();
  const ev = new Map(state.evidence.map((e) => [e.id, e]));
  const sig = new Map(state.signals.map((s) => [s.id, s]));
  const rel = [...state.edges.values()].filter((e) => e.source === node.id || e.target === node.id);
  return (
    <div className="card inspector">
      <div className="row between">
        <span className="eyebrow" style={{ color: KIND_COLOR[node.kind] }}>{KIND_LABEL[node.kind]}</span>
        <button className="btn icon" onClick={onClose} aria-label="Close">×</button>
      </div>
      <h3 style={{ marginTop: 6 }}>{node.label}</h3>
      {node.summary && <p className="subtle" style={{ fontSize: 13, margin: "6px 0 0" }}>{node.summary}</p>}
      <div className="row wrap" style={{ marginTop: 10 }}>
        <span className="chip mono">weight {pct(node.weight)}</span>
        {Object.entries(node.attrs ?? {}).map(([k, v]) => (
          <span key={k} className="chip mono">{k} {String(v)}</span>
        ))}
      </div>
      {rel.length > 0 && (
        <>
          <div className="eyebrow" style={{ marginTop: 16 }}>Relationships</div>
          {rel.slice(0, 12).map((e) => {
            const other = e.source === node.id ? e.target : e.source;
            return (
              <div key={e.id} style={{ fontSize: 12.5, marginTop: 6, cursor: "pointer" }} onClick={() => onNode(other)}>
                <span className="muted">{e.source === node.id ? label(e.relation) : `← ${label(e.relation)}`}</span> {state.nodes.get(other)?.label ?? other}
              </div>
            );
          })}
        </>
      )}
      <div className="eyebrow" style={{ marginTop: 16 }}>Evidence · {node.evidenceIds.length}</div>
      {node.evidenceIds.length === 0 && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>No direct citations: inferred from the brief.</div>}
      {node.evidenceIds.slice(0, 8).map((id) => {
        const e = ev.get(id);
        const s = sig.get(id);
        return (
          <div key={id} style={{ fontSize: 12.5, marginTop: 10, cursor: "pointer" }} onClick={() => onEvidence(id)}>
            <span className="chip mono">{e?.source ?? s?.venue ?? "anchor"}</span>{" "}
            <span className="subtle">{(e?.title ?? e?.text ?? s?.question ?? id).slice(0, 140)}</span>
          </div>
        );
      })}
    </div>
  );
}
