import { useEffect, useMemo, useRef, useState, type ElementRef, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { EventEnvelope, RunState } from "@market/core";
import type { Player } from "../lib/player";
import { countMoods, moodOf, useEventFeed, usePlayerKey, usePlayerVersion, verdictOf, type Mood } from "./useWorld";

export type Selection = { kind: "agent"; id: string } | { kind: "hood"; id: string } | null;

export const PALETTE = ["#e08a6b", "#7fae96", "#e9bd6c", "#86a2cf", "#c493b9", "#d9a27e", "#93bcb0", "#cf9a9a"];
export const MOOD_COLOR: Record<Exclude<Mood, "none">, string> = { adopt: "#4fa86a", wait: "#e8ad2e", reject: "#d9574a" };
const SKIN = ["#f2c9a6", "#e2ad86", "#c98c64", "#8f5c3c", "#f6d8c1", "#b87a55"];
const BG = "#f2e8d8";
const CLAY = "#b4613e";
const TOWER_H = 7.2;
const SP = 0.95;
const MAX_PULSES = 96;
const ARC_SEG = 14;
const MAX_BUBBLES = 4;

// ── Layout ──────────────────────────────────────────────────────────

export interface Hood {
  id: string;
  label: string;
  summary: string;
  color: string;
  cx: number;
  cz: number;
  angle: number;
  half: number;
  members: string[];
}

interface Layout {
  key: string;
  hoods: Hood[];
  ids: string[];
  index: Map<string, number>;
  home: Float32Array;
  hoodOf: Int16Array;
  ring: number;
  island: number;
  houses: { x: number; z: number; rot: number; color: string; s: number }[];
  trees: { x: number; z: number; s: number }[];
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function buildLayout(state: RunState, key: string): Layout {
  const segNodes = [...state.nodes.values()].filter((n) => n.kind === "segment");
  const bySeg = new Map<string, string[]>();
  for (const p of state.personas.values()) {
    if (!bySeg.has(p.segmentId)) bySeg.set(p.segmentId, []);
    bySeg.get(p.segmentId)!.push(p.id);
  }
  const order = [...segNodes.map((n) => n.id).filter((id) => bySeg.has(id)), ...[...bySeg.keys()].filter((id) => !segNodes.some((n) => n.id === id))];
  const cols = order.map((id) => Math.ceil(Math.sqrt(bySeg.get(id)!.length)));
  const halfs = cols.map((c) => (c * SP) / 2 + 1.7);
  const maxHalf = Math.max(2.5, ...halfs);
  const n = Math.max(order.length, 1);
  const ring = n === 1 ? 6 + maxHalf : Math.max(6.5 + maxHalf, (maxHalf * 1.5) / Math.sin(Math.PI / n));
  const island = ring + maxHalf + 4.5;

  const ids: string[] = [];
  const index = new Map<string, number>();
  const homes: number[] = [];
  const hoodOf: number[] = [];
  const houses: Layout["houses"] = [];
  const hoods: Hood[] = order.map((id, h) => {
    const node = state.nodes.get(id);
    const angle = (h / n) * Math.PI * 2 - Math.PI / 2;
    const cx = Math.cos(angle) * ring;
    const cz = Math.sin(angle) * ring;
    const rx = Math.cos(angle);
    const rz = Math.sin(angle);
    const tx = -rz;
    const tz = rx;
    const members = bySeg.get(id)!;
    const c = cols[h];
    const color = PALETTE[h % PALETTE.length];
    members.forEach((pid, k) => {
      const col = k % c;
      const row = Math.floor(k / c);
      const u = (col - (c - 1) / 2) * SP + (hash(ids.length) - 0.5) * 0.25;
      const v = (row - (c - 1) / 2) * SP - 0.7 + (hash(ids.length + 999) - 0.5) * 0.25;
      index.set(pid, ids.length);
      ids.push(pid);
      homes.push(cx + tx * u + rx * v, cz + tz * u + rz * v);
      hoodOf.push(h);
    });
    const houseCount = Math.max(2, Math.round(c * 0.8));
    for (let k = 0; k < houseCount; k++) {
      const u = (k - (houseCount - 1) / 2) * ((halfs[h] * 1.8) / houseCount);
      const v = halfs[h] - 0.9;
      houses.push({ x: cx + tx * u + rx * v, z: cz + tz * u + rz * v, rot: -angle + Math.PI / 2, color, s: 0.85 + hash(h * 31 + k) * 0.4 });
    }
    return { id, label: node?.label ?? id.replace(/^seg_/, "").replace(/_/g, " "), summary: node?.summary ?? "", color, cx, cz, angle, half: halfs[h], members };
  });

  const trees: Layout["trees"] = [];
  for (let k = 0; k < n; k++) {
    const a = ((k + 0.5) / n) * Math.PI * 2 - Math.PI / 2;
    for (let j = 0; j < 3; j++) {
      const r = ring * (0.55 + hash(k * 7 + j) * 0.6);
      const aa = a + (hash(k * 13 + j) - 0.5) * (n > 2 ? 0.5 : 1.2);
      trees.push({ x: Math.cos(aa) * r, z: Math.sin(aa) * r, s: 0.8 + hash(k * 3 + j) * 0.6 });
    }
  }
  const outer = Math.round(island * 1.4);
  for (let k = 0; k < outer; k++) {
    const a = (k / outer) * Math.PI * 2 + hash(k) * 0.2;
    const r = island - 1.6 - hash(k + 50) * 1.4;
    trees.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, s: 0.7 + hash(k + 77) * 0.7 });
  }

  return { key, hoods, ids, index, home: new Float32Array(homes), hoodOf: Int16Array.from(hoodOf), ring, island, houses, trees };
}

// ── Geometry ────────────────────────────────────────────────────────

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function iconGeometries() {
  const v = 0.09;
  const plus = mergeGeometries([box(v * 3, v, v), box(v, v * 3, v)])!;
  const minus = box(v * 3, v, v);
  const cells: [number, number][] = [
    [-1, 2], [0, 2.5], [1, 2], [1, 1], [0, 0.4], [0, -0.6], [0, -2],
  ];
  const q = mergeGeometries(cells.map(([cx, cy]) => box(v, v, v, cx * v, cy * v * 0.72, 0)))!;
  return { adopt: plus, wait: q, reject: minus };
}

// ── Scene pieces ────────────────────────────────────────────────────

function Ground({ layout, onHood }: { layout: Layout | null; onHood: (id: string) => void }) {
  const island = layout?.island ?? 16;
  return (
    <group>
      <mesh position={[0, -0.35, 0]} receiveShadow>
        <cylinderGeometry args={[island, island * 0.97, 0.7, 64]} />
        <meshStandardMaterial color="#a9c48a" roughness={0.95} />
      </mesh>
      <mesh position={[0, -1.3, 0]}>
        <cylinderGeometry args={[island * 0.97, island * 0.86, 1.3, 64]} />
        <meshStandardMaterial color="#c79f74" roughness={1} />
      </mesh>
      <mesh position={[0, -1.6, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[island * 3.2, 64]} />
        <meshStandardMaterial color="#cfe0d4" roughness={1} />
      </mesh>
      {layout?.hoods.map((h) => {
        const len = Math.max(0.5, layout.ring - h.half - 2);
        const mid = 2 + len / 2;
        return (
          <group key={h.id}>
            <mesh position={[Math.cos(h.angle) * mid, 0.02, Math.sin(h.angle) * mid]} rotation={[0, -h.angle, 0]} receiveShadow>
              <boxGeometry args={[len, 0.06, 1.1]} />
              <meshStandardMaterial color="#ead6b0" roughness={1} />
            </mesh>
            <mesh
              position={[h.cx, 0.04, h.cz]}
              rotation={[0, -h.angle, 0]}
              receiveShadow
              onClick={(e) => {
                e.stopPropagation();
                onHood(h.id);
              }}
            >
              <boxGeometry args={[h.half * 2, 0.1, h.half * 2]} />
              <meshStandardMaterial color={new THREE.Color(h.color).lerp(new THREE.Color("#f6ecd9"), 0.62)} roughness={1} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

function Houses({ layout }: { layout: Layout }) {
  const walls = useRef<THREE.InstancedMesh>(null);
  const roofs = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    layout.houses.forEach((h, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.rot);
      s.set(h.s, h.s, h.s);
      m.compose(new THREE.Vector3(h.x, 0, h.z), q, s);
      walls.current?.setMatrixAt(i, m);
      roofs.current?.setMatrixAt(i, m);
      roofs.current?.setColorAt(i, c.set(h.color));
      walls.current?.setColorAt(i, c.set(i % 3 === 0 ? "#fbf1e1" : i % 3 === 1 ? "#f4e3c9" : "#efe6da"));
    });
    for (const r of [walls.current, roofs.current]) {
      if (!r) continue;
      r.instanceMatrix.needsUpdate = true;
      if (r.instanceColor) r.instanceColor.needsUpdate = true;
    }
  }, [layout]);
  const wallGeo = useMemo(() => mergeGeometries([box(1.1, 0.85, 0.95, 0, 0.42, 0), box(0.22, 0.38, 0.04, 0, 0.19, -0.48)])!, []);
  const roofGeo = useMemo(() => mergeGeometries([box(1.25, 0.22, 1.1, 0, 0.96, 0), box(0.85, 0.2, 0.8, 0, 1.17, 0), box(0.4, 0.18, 0.5, 0, 1.36, 0)])!, []);
  return (
    <>
      <instancedMesh ref={walls} args={[wallGeo, undefined, layout.houses.length]} castShadow receiveShadow>
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={roofs} args={[roofGeo, undefined, layout.houses.length]} castShadow>
        <meshStandardMaterial roughness={0.8} />
      </instancedMesh>
    </>
  );
}

function Trees({ layout }: { layout: Layout }) {
  const trunks = useRef<THREE.InstancedMesh>(null);
  const tops = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    layout.trees.forEach((t, i) => {
      m.makeScale(t.s, t.s, t.s).setPosition(t.x, 0, t.z);
      trunks.current?.setMatrixAt(i, m);
      tops.current?.setMatrixAt(i, m);
      tops.current?.setColorAt(i, c.set(i % 4 === 0 ? "#e2b86a" : i % 4 === 1 ? "#88ad6e" : i % 4 === 2 ? "#6f9a63" : "#9cbd78"));
    });
    for (const r of [trunks.current, tops.current]) {
      if (!r) continue;
      r.instanceMatrix.needsUpdate = true;
      if (r.instanceColor) r.instanceColor.needsUpdate = true;
    }
  }, [layout]);
  const trunkGeo = useMemo(() => box(0.22, 0.6, 0.22, 0, 0.3, 0), []);
  const topGeo = useMemo(() => mergeGeometries([box(0.8, 0.6, 0.8, 0, 0.85, 0), box(0.5, 0.4, 0.5, 0, 1.3, 0)])!, []);
  return (
    <>
      <instancedMesh ref={trunks} args={[trunkGeo, undefined, layout.trees.length]} castShadow>
        <meshStandardMaterial color="#8a6448" roughness={1} />
      </instancedMesh>
      <instancedMesh ref={tops} args={[topGeo, undefined, layout.trees.length]} castShadow>
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
    </>
  );
}

function Tower({ name, player, onOpenReport }: { name: string; player: Player; onOpenReport: () => void }) {
  const done = usePlayerKey(player, (s) => (s.status === "ok" && s.bass ? (s.finance ? 2 : 1) : 0));
  usePlayerVersion(player);
  const verdict = done ? verdictOf(player.state) : null;
  const crown = useRef<THREE.MeshStandardMaterial>(null);
  const windows = useMemo(() => {
    const geos: THREE.BufferGeometry[] = [];
    for (let f = 0; f < 4; f++) {
      for (let y = 0; y < 5; y++) {
        for (let x = -1; x <= 1; x++) {
          const g = box(0.34, 0.5, 0.05, x * 0.68, 1.6 + y * 1.05, 1.22);
          g.rotateY((f * Math.PI) / 2);
          geos.push(g);
        }
      }
    }
    return mergeGeometries(geos)!;
  }, []);
  useFrame(({ clock }) => {
    if (!crown.current) return;
    const tone = verdict?.tone;
    const target = tone === "pos" ? "#7cc48a" : tone === "warn" ? "#f0c25a" : tone === "neg" ? "#e9806f" : "#ffcf8a";
    crown.current.emissive.lerp(new THREE.Color(target), 0.05);
    crown.current.emissiveIntensity = 0.55 + Math.sin(clock.elapsedTime * 2) * 0.15;
  });
  return (
    <group>
      <mesh position={[0, 0.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[3.6, 0.8, 3.6]} />
        <meshStandardMaterial color="#d9c2a0" roughness={0.9} />
      </mesh>
      <mesh position={[0, 0.8 + TOWER_H / 2 - 0.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[2.4, TOWER_H - 0.8, 2.4]} />
        <meshStandardMaterial color={CLAY} roughness={0.75} />
      </mesh>
      <mesh geometry={windows}>
        <meshStandardMaterial color="#fff1d0" emissive="#ffcf8a" emissiveIntensity={0.6} roughness={0.5} />
      </mesh>
      <mesh position={[0, TOWER_H + 0.3, 0]} castShadow>
        <boxGeometry args={[2.9, 0.6, 2.9]} />
        <meshStandardMaterial ref={crown} color="#f3dcc0" emissive="#ffcf8a" emissiveIntensity={0.5} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.5, 1.81]}>
        <boxGeometry args={[0.8, 1.0, 0.05]} />
        <meshStandardMaterial color="#6b3b26" roughness={1} />
      </mesh>
      <Html position={[0, TOWER_H + 1.5, 0]} center zIndexRange={[30, 10]} className="w-html">
        <div className={`w-tower-sign ${verdict ? "done" : ""}`}>
          <div className="w-tower-name">{name}</div>
          {verdict && (
            <div className={`w-verdict ${verdict.tone}`}>
              <strong>{verdict.headline}</strong>
              <span>{verdict.detail}</span>
              <button className="w-btn small" onClick={onOpenReport}>Open full report</button>
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

function HoodLabels({ layout, player, onHood, selected }: { layout: Layout; player: Player; onHood: (id: string) => void; selected: string | null }) {
  usePlayerVersion(player);
  return (
    <>
      {layout.hoods.map((h) => {
        const c = countMoods(player.state, h.id);
        const decided = c.adopt + c.wait + c.reject;
        const pct = c.total ? Math.round((c.adopt / c.total) * 100) : 0;
        const r = layout.ring + h.half + 0.6;
        return (
          <Html key={h.id} position={[Math.cos(h.angle) * r, 0.3, Math.sin(h.angle) * r]} center zIndexRange={[25, 5]} className="w-html">
            <button className={`w-hood-label ${selected === h.id ? "on" : ""}`} style={{ borderColor: h.color }} onClick={() => onHood(h.id)}>
              <span className="w-hood-dot" style={{ background: h.color }} />
              <span className="w-hood-name">{h.label}</span>
              <span className="w-hood-pct">{decided ? `${pct}%` : "–"}</span>
            </button>
          </Html>
        );
      })}
    </>
  );
}

interface Bubble {
  key: number;
  agent: number;
  text: string;
  tone: Mood | "msg";
  born: number;
}

const MOOD_IDX: Record<Mood, number> = { none: 0, adopt: 1, wait: 2, reject: 3 };
const MOOD_THREE = {
  adopt: new THREE.Color(MOOD_COLOR.adopt),
  wait: new THREE.Color(MOOD_COLOR.wait),
  reject: new THREE.Color(MOOD_COLOR.reject),
};

function Residents({
  layout,
  player,
  selection,
  onAgent,
  agentPos,
}: {
  layout: Layout;
  player: Player;
  selection: Selection;
  onAgent: (id: string) => void;
  agentPos: MutableRefObject<Float32Array>;
}) {
  const N = layout.ids.length;
  const bodies = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const icons = { adopt: useRef<THREE.InstancedMesh>(null), wait: useRef<THREE.InstancedMesh>(null), reject: useRef<THREE.InstancedMesh>(null) };
  const pulseLines = useRef<THREE.LineSegments>(null);
  const orbs = useRef<THREE.InstancedMesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const package_ = useRef<THREE.Group>(null);
  const wave = useRef<THREE.Mesh>(null);
  const beam = useRef<THREE.Mesh>(null);
  const sparks = useRef<THREE.InstancedMesh>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);

  const geo = useMemo(() => ({ body: box(0.36, 0.48, 0.26, 0, 0.26, 0), head: box(0.3, 0.3, 0.3, 0, 0.68, 0), ...iconGeometries() }), []);
  const sim = useMemo(() => {
    const spawn = new Float32Array(N).fill(-1);
    return {
      spawn,
      mood: new Int8Array(N),
      changed: new Float32Array(N).fill(-10),
      phase: Float32Array.from({ length: N }, (_, i) => hash(i + 5) * Math.PI * 2),
      built: -1,
      pulses: Array.from({ length: MAX_PULSES }, () => ({ a: 0, b: 0, start: -100, color: new THREE.Color() })),
      nextPulse: 0,
      queue: [] as Omit<Bubble, "key" | "born">[],
      lastBubble: -10,
      bubbleKey: 0,
      launch: -100,
      roundPulse: -100,
      sparkDir: Array.from({ length: 48 }, (_, i) => {
        const h = layout.hoods.length ? layout.hoods[i % layout.hoods.length] : null;
        return { x: (h?.cx ?? 0) + (hash(i) - 0.5) * 4, z: (h?.cz ?? 0) + (hash(i + 3) - 0.5) * 4, d: 0.8 + hash(i + 9) * 0.6 };
      }),
    };
  }, [N, layout]);

  const lineGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_PULSES * ARC_SEG * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_PULSES * ARC_SEG * 6), 3));
    return g;
  }, []);

  useEffect(() => {
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      bodies.current?.setColorAt(i, c.set(layout.hoods[layout.hoodOf[i]].color));
      heads.current?.setColorAt(i, c.set(SKIN[Math.floor(hash(i + 17) * SKIN.length)]));
    }
    if (bodies.current?.instanceColor) bodies.current.instanceColor.needsUpdate = true;
    if (heads.current?.instanceColor) heads.current.instanceColor.needsUpdate = true;
    agentPos.current = new Float32Array(N * 2);
  }, [layout, N, agentPos]);

  const resetEffects = () => {
    sim.pulses.forEach((p) => (p.start = -100));
    sim.queue.length = 0;
    sim.launch = -100;
    setBubbles([]);
  };

  const addPulse = (a: number | undefined, b: number | undefined, color: string, t: number) => {
    if (a === undefined || b === undefined || a === b) return;
    const p = sim.pulses[sim.nextPulse];
    sim.nextPulse = (sim.nextPulse + 1) % MAX_PULSES;
    p.a = a;
    p.b = b;
    p.start = t + Math.random() * 0.35;
    p.color.set(color);
  };

  useEventFeed(
    player,
    (env: EventEnvelope, t) => {
      const e = env.event;
      if (e.type === "round.started") {
        if (sim.launch < 0 && e.round <= 1) sim.launch = t;
        else sim.roundPulse = t;
      } else if (e.type === "agent.decision") {
        const d = e.decision;
        const to = layout.index.get(d.agentId);
        const m = moodOf(d.state);
        if (d.state !== d.previous && m !== "none") {
          for (const inf of d.influencedBy.slice(0, 2)) addPulse(layout.index.get(inf), to, MOOD_COLOR[m], t);
          const text = (d.comment || "").trim();
          if (text && to !== undefined) {
            sim.queue.push({ agent: to, text, tone: m });
            if (sim.queue.length > 24) sim.queue.shift();
          }
        }
      } else if (e.type === "agent.message") {
        const m = e.message;
        const tone = m.sentiment > 0.2 ? MOOD_COLOR.adopt : m.sentiment < -0.2 ? MOOD_COLOR.reject : "#ffd9a0";
        addPulse(layout.index.get(m.from), layout.index.get(m.to), tone, t);
        const from = layout.index.get(m.from);
        if (m.text && from !== undefined && Math.random() < 0.35) {
          sim.queue.push({ agent: from, text: m.text, tone: "msg" });
          if (sim.queue.length > 24) sim.queue.shift();
        }
      }
    },
    resetEffects,
  );

  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), c: new THREE.Color(), y: new THREE.Vector3(0, 1, 0), a: new THREE.Vector3(), b: new THREE.Vector3() }), []);

  useFrame(({ clock, camera }) => {
    const t = clock.elapsedTime;
    const st = player.state;
    if (sim.built < 0) {
      sim.built = t;
      const settled = st.currentRound > 0;
      for (let i = 0; i < N; i++) sim.spawn[i] = settled ? t - 10 : t + (i / Math.max(1, N)) * 2.2 + hash(i) * 0.3;
    }
    const { m, q, s, p, c } = tmp;
    const pos = agentPos.current;
    let colorDirty = false;
    for (let i = 0; i < N; i++) {
      const hx = layout.home[i * 2];
      const hz = layout.home[i * 2 + 1];
      const age = t - sim.spawn[i];
      const ph = sim.phase[i];
      let x: number;
      let z: number;
      let y = 0;
      let scale = 1;
      if (age < 0) {
        x = 0;
        z = 0;
        scale = 0;
      } else {
        const w = Math.min(1, age / 1.8);
        const e = 1 - Math.pow(1 - w, 3);
        const ex = Math.cos(layout.hoods[layout.hoodOf[i]].angle) * 1.9;
        const ez = Math.sin(layout.hoods[layout.hoodOf[i]].angle) * 1.9;
        x = ex + (hx - ex) * e + Math.sin(t * 0.45 + ph) * 0.1 * e;
        z = ez + (hz - ez) * e + Math.cos(t * 0.38 + ph * 1.3) * 0.1 * e;
        y = w < 1 ? Math.abs(Math.sin(age * 9)) * 0.12 : Math.abs(Math.sin(t * 1.6 + ph)) * 0.025;
        scale = Math.min(1, age * 4);
      }
      const id = layout.ids[i];
      const mood = moodOf(st.agentState.get(id)?.state);
      const mi = MOOD_IDX[mood];
      if (mi !== sim.mood[i]) {
        sim.mood[i] = mi;
        sim.changed[i] = t;
        c.set(layout.hoods[layout.hoodOf[i]].color);
        if (mood !== "none") c.lerp(MOOD_THREE[mood], 0.35);
        bodies.current?.setColorAt(i, c);
        colorDirty = true;
      }
      const since = t - sim.changed[i];
      if (since < 0.45) y += Math.sin((since / 0.45) * Math.PI) * 0.45;
      pos[i * 2] = x;
      pos[i * 2 + 1] = z;
      q.identity();
      s.set(scale, scale, scale);
      m.compose(p.set(x, y, z), q, s);
      bodies.current?.setMatrixAt(i, m);
      heads.current?.setMatrixAt(i, m);

      const face = Math.atan2(camera.position.x - x, camera.position.z - z);
      const pop = mood === "none" ? 0 : since < 0.4 ? easeOutBack(since / 0.4) : 1;
      for (const k of ["adopt", "wait", "reject"] as const) {
        const ref = icons[k].current;
        if (!ref) continue;
        const sc = k === mood ? pop * scale : 0;
        q.setFromAxisAngle(tmp.y, face);
        s.set(sc, sc, sc);
        m.compose(p.set(x, y + 1.22 + Math.sin(t * 2.2 + ph) * 0.05, z), q, s);
        ref.setMatrixAt(i, m);
      }
    }
    for (const r of [bodies.current, heads.current, icons.adopt.current, icons.wait.current, icons.reject.current]) if (r) r.instanceMatrix.needsUpdate = true;
    if (colorDirty && bodies.current?.instanceColor) bodies.current.instanceColor.needsUpdate = true;

    // Word-of-mouth pulses: an arc that lights up from speaker to listener.
    const lp = lineGeo.getAttribute("position") as THREE.BufferAttribute;
    const lc = lineGeo.getAttribute("color") as THREE.BufferAttribute;
    const P = lp.array as Float32Array;
    const C = lc.array as Float32Array;
    for (let k = 0; k < MAX_PULSES; k++) {
      const pl = sim.pulses[k];
      const prog = (t - pl.start) / 1.25;
      const base = k * ARC_SEG * 6;
      const live = prog >= 0 && prog < 1.6;
      const ax = pos[pl.a * 2] ?? 0;
      const az = pos[pl.a * 2 + 1] ?? 0;
      const bx = pos[pl.b * 2] ?? 0;
      const bz = pos[pl.b * 2 + 1] ?? 0;
      const h = 0.8 + Math.hypot(bx - ax, bz - az) * 0.18;
      const fade = prog < 1 ? 1 : Math.max(0, 1 - (prog - 1) / 0.6);
      for (let sgi = 0; sgi < ARC_SEG; sgi++) {
        for (let e = 0; e < 2; e++) {
          const u = (sgi + e) / ARC_SEG;
          const o = base + sgi * 6 + e * 3;
          if (!live) {
            C[o] = C[o + 1] = C[o + 2] = 0;
            continue;
          }
          P[o] = ax + (bx - ax) * u;
          P[o + 1] = 0.9 + 4 * h * u * (1 - u);
          P[o + 2] = az + (bz - az) * u;
          const head = Math.max(0, 1 - Math.abs(u - Math.min(prog, 1)) * 5);
          const inten = (u <= prog ? 0.35 : 0) * fade + head * 0.9 * fade;
          C[o] = pl.color.r * inten;
          C[o + 1] = pl.color.g * inten;
          C[o + 2] = pl.color.b * inten;
        }
      }
      if (orbs.current) {
        const sc = prog >= 0 && prog <= 1 ? 0.2 : 0;
        const u = Math.min(1, Math.max(0, prog));
        m.compose(p.set(ax + (bx - ax) * u, 0.9 + 4 * h * u * (1 - u), az + (bz - az) * u), q.identity(), s.set(sc, sc, sc));
        orbs.current.setMatrixAt(k, m);
        orbs.current.setColorAt(k, pl.color);
      }
    }
    lp.needsUpdate = true;
    lc.needsUpdate = true;
    if (orbs.current) {
      orbs.current.instanceMatrix.needsUpdate = true;
      if (orbs.current.instanceColor) orbs.current.instanceColor.needsUpdate = true;
    }

    // Launch: the package lifts off the tower, then a wave and sparks spread over the town.
    const lk = sim.launch < 0 ? -1 : t - sim.launch;
    if (package_.current) {
      const g = package_.current;
      if (lk < 0) {
        g.visible = true;
        g.position.set(0, TOWER_H + 1.0 + Math.sin(t * 2) * 0.12, 0);
        g.rotation.y = t * 0.6;
        g.scale.setScalar(1);
      } else if (lk < 0.9) {
        g.visible = true;
        g.position.y = TOWER_H + 1.0 + lk * 4.5;
        g.rotation.y += 0.25;
        g.scale.setScalar(1 + lk * 0.8);
      } else g.visible = false;
    }
    const wk = Math.max(lk - 0.9, t - sim.roundPulse < 2.2 ? (t - sim.roundPulse) * 1.3 : -1);
    if (wave.current) {
      const mat = wave.current.material as THREE.MeshBasicMaterial;
      if (wk >= 0 && wk < 2.2) {
        const r = 1 + (wk / 2.2) * layout.island;
        wave.current.visible = true;
        wave.current.scale.set(r, r, 1);
        mat.opacity = 0.55 * (1 - wk / 2.2) * (lk >= 0.9 && lk < 3.1 ? 1 : 0.45);
      } else wave.current.visible = false;
    }
    if (beam.current) {
      const mat = beam.current.material as THREE.MeshBasicMaterial;
      if (lk >= 0.7 && lk < 2.6) {
        beam.current.visible = true;
        mat.opacity = 0.5 * (1 - (lk - 0.7) / 1.9);
        beam.current.scale.set(1 + (lk - 0.7) * 0.6, 1, 1 + (lk - 0.7) * 0.6);
      } else beam.current.visible = false;
    }
    if (sparks.current) {
      sim.sparkDir.forEach((sd, i) => {
        const k = (lk - 0.9) / sd.d;
        const sc = k >= 0 && k <= 1 ? 0.28 * (1 - k * 0.6) : 0;
        const kk = Math.min(1, Math.max(0, k));
        m.compose(p.set(sd.x * kk, TOWER_H + 4.8 * (1 - kk) + 10 * kk * (1 - kk), sd.z * kk), q.setFromAxisAngle(tmp.y, t * 3 + i), s.set(sc, sc, sc));
        sparks.current!.setMatrixAt(i, m);
      });
      sparks.current.instanceMatrix.needsUpdate = true;
    }

    // Selection marker.
    if (ring.current) {
      const idx = selection?.kind === "agent" ? layout.index.get(selection.id) : undefined;
      ring.current.visible = idx !== undefined;
      if (idx !== undefined) {
        ring.current.position.set(pos[idx * 2], 0.08, pos[idx * 2 + 1]);
        ring.current.scale.setScalar(1 + Math.sin(t * 4) * 0.08);
      }
    }

    // Speech bubbles, throttled so the town never turns into a wall of text.
    const expired = bubbles.some((b) => t - b.born >= 3.8);
    let next = expired ? bubbles.filter((b) => t - b.born < 3.8) : bubbles;
    if (sim.queue.length && next.length < MAX_BUBBLES && t - sim.lastBubble > 0.9) {
      const pick = sim.queue.pop()!;
      sim.queue.length = Math.min(sim.queue.length, 10);
      sim.lastBubble = t;
      if (!next.some((b) => b.agent === pick.agent)) next = [...next, { ...pick, key: sim.bubbleKey++, born: t }];
    }
    if (next !== bubbles) setBubbles(next);
  });

  return (
    <>
      <instancedMesh
        ref={bodies}
        args={[geo.body, undefined, N]}
        castShadow
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.instanceId !== undefined) onAgent(layout.ids[e.instanceId]);
        }}
        onPointerOver={() => (document.body.style.cursor = "pointer")}
        onPointerOut={() => (document.body.style.cursor = "")}
      >
        <meshStandardMaterial roughness={0.8} />
      </instancedMesh>
      <instancedMesh
        ref={heads}
        args={[geo.head, undefined, N]}
        castShadow
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.instanceId !== undefined) onAgent(layout.ids[e.instanceId]);
        }}
      >
        <meshStandardMaterial roughness={0.85} />
      </instancedMesh>
      {(["adopt", "wait", "reject"] as const).map((k) => (
        <instancedMesh key={k} ref={icons[k]} args={[geo[k], undefined, N]} frustumCulled={false}>
          <meshStandardMaterial color={MOOD_COLOR[k]} emissive={MOOD_COLOR[k]} emissiveIntensity={0.55} roughness={0.5} />
        </instancedMesh>
      ))}
      <lineSegments ref={pulseLines} geometry={lineGeo} frustumCulled={false}>
        <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} />
      </lineSegments>
      <instancedMesh ref={orbs} args={[undefined, undefined, MAX_PULSES]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.32, 0.46, 24]} />
        <meshBasicMaterial color="#fff6e6" transparent opacity={0.95} />
      </mesh>
      <group ref={package_}>
        <mesh castShadow>
          <boxGeometry args={[0.9, 0.9, 0.9]} />
          <meshStandardMaterial color="#ffd27a" emissive="#ffb347" emissiveIntensity={0.9} />
        </mesh>
        <mesh>
          <boxGeometry args={[0.95, 0.95, 0.2]} />
          <meshStandardMaterial color="#e0573f" emissive="#e0573f" emissiveIntensity={0.4} />
        </mesh>
        <mesh>
          <boxGeometry args={[0.2, 0.95, 0.95]} />
          <meshStandardMaterial color="#e0573f" emissive="#e0573f" emissiveIntensity={0.4} />
        </mesh>
        <pointLight color="#ffc47a" intensity={6} distance={7} />
      </group>
      <mesh ref={wave} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.25, 0]} visible={false}>
        <ringGeometry args={[0.86, 1, 96]} />
        <meshBasicMaterial color="#ffd08a" transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={beam} position={[0, TOWER_H + 8, 0]} visible={false}>
        <cylinderGeometry args={[0.5, 0.9, 16, 24, 1, true]} />
        <meshBasicMaterial color="#ffe0a8" transparent depthWrite={false} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <instancedMesh ref={sparks} args={[undefined, undefined, 48]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#ffd27a" toneMapped={false} />
      </instancedMesh>
      {bubbles.map((b) => (
        <Html key={b.key} position={[layout.home[b.agent * 2], 1.75, layout.home[b.agent * 2 + 1]]} center distanceFactor={22} zIndexRange={[40, 20]} className="w-html no-pointer">
          <div className={`w-bubble ${b.tone}`}>{b.text.length > 84 ? `${b.text.slice(0, 82)}…` : b.text}</div>
        </Html>
      ))}
    </>
  );
}

function easeOutBack(x: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function NeighbourLines({ layout, player, id, agentPos }: { layout: Layout; player: Player; id: string; agentPos: MutableRefObject<Float32Array> }) {
  const edgeCount = usePlayerKey(player, (s) => s.socialEdges.length);
  const pairs = useMemo(() => {
    const me = layout.index.get(id);
    if (me === undefined) return [] as number[];
    const out: number[] = [];
    for (const e of player.state.socialEdges) {
      const other = e.source === id ? e.target : e.target === id ? e.source : null;
      const o = other ? layout.index.get(other) : undefined;
      if (o !== undefined) out.push(o);
    }
    return out.slice(0, 40);
  }, [layout, id, player, edgeCount]);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(1, pairs.length) * 6), 3));
    return g;
  }, [pairs]);
  useFrame(() => {
    const me = layout.index.get(id);
    if (me === undefined) return;
    const pos = agentPos.current;
    const P = (geo.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    pairs.forEach((o, k) => {
      P.set([pos[me * 2], 0.55, pos[me * 2 + 1], pos[o * 2], 0.55, pos[o * 2 + 1]], k * 6);
    });
    geo.getAttribute("position").needsUpdate = true;
  });
  if (!pairs.length) return null;
  return (
    <lineSegments geometry={geo} frustumCulled={false}>
      <lineBasicMaterial color="#7a4a2e" transparent opacity={0.55} />
    </lineSegments>
  );
}

function CameraRig({ layout, selection, agentPos, autoOrbit }: { layout: Layout | null; selection: Selection; agentPos: MutableRefObject<Float32Array>; autoOrbit: boolean }) {
  const controls = useRef<ElementRef<typeof OrbitControls>>(null);
  const { camera } = useThree();
  const state = useRef({ interacting: false, lastTouch: -100, focusUntil: 0, placedFor: "" });
  const island = layout?.island ?? 16;

  useEffect(() => {
    if (!layout || state.current.placedFor === layout.key) return;
    state.current.placedFor = layout.key;
    const d = island * 1.55;
    camera.position.set(d * 0.72, d * 0.62, d * 0.72);
    camera.lookAt(0, 1, 0);
  }, [layout, island, camera]);

  useEffect(() => {
    state.current.focusUntil = performance.now() / 1000 + 1.4;
  }, [selection]);

  useFrame(({ clock }) => {
    const c = controls.current;
    if (!c) return;
    const t = clock.elapsedTime;
    c.autoRotate = autoOrbit && !state.current.interacting && t - state.current.lastTouch > 5 && !selection;
    if (performance.now() / 1000 < state.current.focusUntil) {
      let tx = 0;
      let tz = 0;
      if (selection?.kind === "agent" && layout) {
        const i = layout.index.get(selection.id);
        if (i !== undefined) {
          tx = agentPos.current[i * 2];
          tz = agentPos.current[i * 2 + 1];
        }
      } else if (selection?.kind === "hood" && layout) {
        const h = layout.hoods.find((x) => x.id === selection.id);
        if (h) {
          tx = h.cx;
          tz = h.cz;
        }
      }
      c.target.lerp(new THREE.Vector3(tx, selection ? 0.5 : 1, tz), 0.08);
    }
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      autoRotateSpeed={0.45}
      maxPolarAngle={Math.PI * 0.44}
      minDistance={6}
      maxDistance={island * 3}
      onStart={() => {
        state.current.interacting = true;
      }}
      onEnd={() => {
        state.current.interacting = false;
        state.current.lastTouch = performance.now() / 1000;
      }}
    />
  );
}

function Scene({ player, name, selection, onSelect, onOpenReport, autoOrbit }: TownProps) {
  const key = usePlayerKey(player, (s) => {
    const ready = s.stages.population.status === "done" || s.currentRound > 0 || s.status === "ok";
    return ready && s.personas.size ? `${s.runId}|${s.personas.size}` : `${s.runId}|0`;
  });
  const layout = useMemo(() => (key.endsWith("|0") ? null : buildLayout(player.state, key)), [key, player]);
  const agentPos = useRef<Float32Array>(new Float32Array(0));
  const island = layout?.island ?? 16;
  const R = island;
  return (
    <>
      <color attach="background" args={[BG]} />
      <fog attach="fog" args={[BG, R * 2.4, R * 5.5]} />
      <hemisphereLight args={["#fff3dd", "#b5946f", 1.0]} />
      <ambientLight intensity={0.25} color="#ffe9cf" />
      <directionalLight
        position={[R * 0.7, R * 1.3, R * 0.45]}
        intensity={1.9}
        color="#ffe1bd"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-camera-left={-R}
        shadow-camera-right={R}
        shadow-camera-top={R}
        shadow-camera-bottom={-R}
        shadow-camera-near={1}
        shadow-camera-far={R * 4}
      />
      <Ground layout={layout} onHood={(id) => onSelect({ kind: "hood", id })} />
      <Tower name={name} player={player} onOpenReport={onOpenReport} />
      {layout && (
        <>
          <Houses layout={layout} />
          <Trees layout={layout} />
          <Residents key={layout.key} layout={layout} player={player} selection={selection} onAgent={(id) => onSelect({ kind: "agent", id })} agentPos={agentPos} />
          <HoodLabels layout={layout} player={player} onHood={(id) => onSelect({ kind: "hood", id })} selected={selection?.kind === "hood" ? selection.id : null} />
          {selection?.kind === "agent" && <NeighbourLines layout={layout} player={player} id={selection.id} agentPos={agentPos} />}
        </>
      )}
      <CameraRig layout={layout} selection={selection} agentPos={agentPos} autoOrbit={autoOrbit} />
    </>
  );
}

export interface TownProps {
  player: Player;
  name: string;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onOpenReport: () => void;
  autoOrbit: boolean;
}

export function Town(props: TownProps) {
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ fov: 38, position: [26, 22, 26], near: 0.5, far: 400 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      onPointerMissed={() => props.onSelect(null)}
    >
      <Scene {...props} />
    </Canvas>
  );
}

export function hoodsOf(state: RunState) {
  return [...state.nodes.values()].filter((n) => n.kind === "segment");
}
