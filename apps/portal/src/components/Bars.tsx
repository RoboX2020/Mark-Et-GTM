export interface BarRow {
  label: string;
  value: number | null;
  color: string;
  /** Shown instead of the formatted value, e.g. "never". */
  text?: string;
  hatch?: boolean;
}

/**
 * Horizontal bars that all share one linear scale (and a zero line when some
 * values are negative), so a smaller number is always a visibly shorter bar.
 */
export function BarGroup({ title, rows, fmt, domain }: { title?: string; rows: BarRow[]; fmt: (v: number) => string; domain?: [number, number] }) {
  const vals = rows.map((r) => r.value ?? 0);
  const lo = Math.min(0, domain?.[0] ?? 0, ...vals);
  const hi = Math.max(1e-9, domain?.[1] ?? 0, ...vals);
  const span = hi - lo;
  const zero = (-lo / span) * 100;
  return (
    <div className="hbar-group">
      {title && <h4>{title}</h4>}
      {rows.map((r, i) => {
        const v = r.value ?? 0;
        const left = v >= 0 ? zero : zero - (-v / span) * 100;
        const width = (Math.abs(v) / span) * 100;
        return (
          <div className="hbar-row" key={i}>
            <span className="lbl" title={r.label}>{r.label}</span>
            <span className={`hbar-track ${lo < 0 ? "neg-axis" : ""}`}>
              {r.value !== null && (
                <i
                  style={{
                    left: `${left}%`,
                    width: `max(${width}%, 2px)`,
                    background: r.hatch ? `repeating-linear-gradient(135deg, ${r.color} 0 4px, transparent 4px 7px)` : r.color,
                    outline: r.hatch ? `1px solid ${r.color}` : undefined,
                    outlineOffset: -1,
                  }}
                />
              )}
              {lo < 0 && <span className="zero" style={{ left: `${zero}%` }} />}
            </span>
            <span className={`val ${v < 0 ? "neg" : ""}`}>{r.text ?? (r.value === null ? "—" : fmt(r.value))}</span>
          </div>
        );
      })}
    </div>
  );
}
