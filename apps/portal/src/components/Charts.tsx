import { useLayoutEffect, useRef, useState } from "react";
import type { FinanceMonth } from "@market/core";

/** Renders at the container's real pixel width so text and strokes stay crisp at every size. */
function useWidth(initial = 640): [React.RefObject<SVGSVGElement>, number] {
  const ref = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(240, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(240, el.clientWidth));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// Hand-drawn SVG charts: hairline axes, cobalt for the forecast, ink for what really happened.

interface Series {
  points: { x: number; y: number }[];
  kind: "curve" | "alt" | "actual";
  dots?: boolean;
  area?: boolean;
  color?: string;
}

function scale(d0: number, d1: number, r0: number, r1: number) {
  return (v: number) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export { niceMax };

export function LineChart({
  series,
  xMax,
  yFmt,
  height = 240,
  markerX,
  yFloor = 0,
  yMax: fixedMax,
}: {
  series: Series[];
  xMax: number;
  yFmt: (v: number) => string;
  height?: number;
  markerX?: number;
  /** Minimum top of the y axis, so near-empty charts don't collapse to one value. */
  yFloor?: number;
  /** Fixed top of the y axis, so several charts can be read on one scale. */
  yMax?: number;
}) {
  const [ref, W] = useWidth();
  const H = height;
  const pad = { l: 52, r: 16, t: 14, b: 30 };
  const yMax = fixedMax ?? niceMax(Math.max(yFloor, 1e-9, ...series.flatMap((s) => s.points.map((p) => p.y))) * 1.08);
  const x = scale(0, xMax, pad.l, W - pad.r);
  const y = scale(0, yMax, H - pad.b, pad.t);
  const ticksY = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const stepX = xMax <= 12 ? 1 : Math.ceil(xMax / 6);
  const ticksX = Array.from({ length: Math.floor(xMax / stepX) + 1 }, (_, i) => i * stepX);
  const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join("");
  return (
    <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img">
      {ticksY.map((t) => (
        <g key={t}>
          <line className="grid-l" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
          <text className="tick" x={pad.l - 8} y={y(t) + 3} textAnchor="end">
            {yFmt(t)}
          </text>
        </g>
      ))}
      {ticksX.map((t) => (
        <text key={t} className="tick" x={x(t)} y={H - 10} textAnchor="middle">
          {t}
        </text>
      ))}
      <line className="axis" x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} />
      {markerX !== undefined && <line className="axis" x1={x(markerX)} x2={x(markerX)} y1={pad.t} y2={H - pad.b} strokeDasharray="2 4" />}
      {series.map((s, i) => (
        <g key={`${i}-${s.points.length}`}>
          {s.area && s.points.length > 1 && <path className="area" style={s.color ? { fill: s.color } : undefined} d={`${path(s.points)}L${x(s.points[s.points.length - 1].x)},${y(0)}L${x(s.points[0].x)},${y(0)}Z`} />}
          {s.points.length > 1 && <path pathLength={1} className={`curve ${s.kind === "curve" ? "" : s.kind} draw`} style={s.color ? { stroke: s.color } : undefined} d={path(s.points)} />}
          {s.dots && s.points.map((p, j) => <circle key={j} className={`pt ${s.kind === "actual" ? "actual" : ""}`} cx={x(p.x)} cy={y(p.y)} r={3.6} style={s.color ? { stroke: s.kind === "actual" ? undefined : s.color, fill: s.kind === "actual" ? s.color : undefined } : undefined} />)}
        </g>
      ))}
    </svg>
  );
}

export function FinanceChart({ months, fmt }: { months: FinanceMonth[]; fmt: (v: number) => string }) {
  const [ref, W] = useWidth();
  const H = 260;
  const pad = { l: 60, r: 16, t: 14, b: 30 };
  const maxV = niceMax(Math.max(1, ...months.map((m) => Math.max(m.revenue, m.marketing + m.fixed + m.cogs))));
  const cashMax = Math.max(1, ...months.map((m) => Math.abs(m.cash)));
  const x = scale(0.5, months.length + 0.5, pad.l, W - pad.r);
  const y = scale(0, maxV, H - pad.b, pad.t);
  const yc = scale(-cashMax, cashMax, H - pad.b, pad.t);
  const bw = ((W - pad.l - pad.r) / months.length) * 0.32;
  return (
    <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line className="grid-l" x1={pad.l} x2={W - pad.r} y1={y(f * maxV)} y2={y(f * maxV)} />
          <text className="tick" x={pad.l - 8} y={y(f * maxV) + 3} textAnchor="end">
            {fmt(f * maxV)}
          </text>
        </g>
      ))}
      {months.map((m) => (
        <g key={m.month}>
          <rect x={x(m.month) - bw - 1} y={y(m.revenue)} width={bw} height={Math.max(0, y(0) - y(m.revenue))} fill="var(--pos)" opacity={0.75} />
          <rect x={x(m.month) + 1} y={y(m.marketing + m.fixed + m.cogs)} width={bw} height={Math.max(0, y(0) - y(m.marketing + m.fixed + m.cogs))} fill="var(--ink-4)" opacity={0.7} />
          <text className="tick" x={x(m.month)} y={H - 10} textAnchor="middle">
            {m.month}
          </text>
        </g>
      ))}
      <path pathLength={1} className="curve alt draw" d={months.map((m, i) => `${i ? "L" : "M"}${x(m.month)},${yc(m.cash)}`).join("")} />
      <line className="axis" x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} />
    </svg>
  );
}

export function Spark({ values, width = 120, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1e-9);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - (v / max) * (height - 2) - 1}`).join(" ");
  return (
    <svg width={width} height={height} className="chart">
      <polyline points={pts} fill="none" stroke="var(--ink-2)" strokeWidth={1.4} />
    </svg>
  );
}
