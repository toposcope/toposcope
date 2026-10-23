import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { formatAggStat } from "../fill-histogram";
import { withUnit } from "../metric-unit";
import {
  axisSteps,
  embedLines,
  embedMessage,
  nextEmbedState,
  pollMs,
  tickLabel,
  type EmbedParams,
  type EmbedState,
  type SeriesBody,
} from "../embed-view";

/** Line colours: the plate for one line, the panels' split palette for many (23a, 23b). */
const palettes = {
  dark: { one: "#e7e1d3", many: ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#e2e8f0", "#c084fc", "#2dd4bf"] },
  light: { one: "#18181b", many: ["#18181b", "#2563eb", "#d97706", "#7c3aed", "#059669", "#db2777", "#0891b2", "#65a30d"] },
};

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** One panel of a share, and nothing that leads back into Toposcope (#227). */
export function EmbedPanel({ params }: { params: EmbedParams }) {
  const [state, setState] = useState<EmbedState>({ kind: "loading" });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    // The page loaded, so Toposcope answers: the host's fallback stands down.
    if (window.parent !== window) {
      window.parent.postMessage({ type: "toposcope:ready" }, "*");
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    async function read() {
      let next: EmbedState;
      try {
        const res = await fetch(`/share/v1/series?${params.query.toString()}`, {
          headers: { authorization: `Bearer ${params.ticket}` },
        });
        next = nextEmbedState(stateRef.current, { status: res.status, body: await res.json().catch(() => null) }, Date.now());
      } catch {
        next = nextEmbedState(stateRef.current, { failed: true }, Date.now());
      }
      if (stopped) return;
      setState(next);
      const message = embedMessage(next);
      if (message && window.parent !== window) {
        // No data in it: only what the host needs to show its own fallback.
        window.parent.postMessage({ type: message }, "*");
      }
      if (next.kind === "painted" || next.kind === "stale") {
        timer = setTimeout(read, pollMs(next.body));
      }
    }
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [params]);

  const body = state.kind === "painted" || state.kind === "stale" ? state.body : null;
  const stale = state.kind === "stale";
  const span = body?.from && body.to ? Date.parse(body.to) - Date.parse(body.from) : 0;
  const right =
    state.kind === "stale"
      ? `not answering${state.readAt ? ` · last read ${clock(state.readAt)}` : ""}`
      : body
        ? [params.query.get("range") ?? "", body.step_ms ? formatStep(body.step_ms) : ""].filter(Boolean).join(" · ")
        : "";

  return (
    <div className={`panel ${stale ? "is-stale" : ""}`}>
      <div className="head">
        <span className="title">{params.title}</span>
        <span className="what">{params.what}</span>
        <span className="grow" />
        <span className={`right ${stale ? "warn" : ""}`}>{right}</span>
      </div>
      {state.kind === "expired" ? (
        <Notice line="Expired — reload the page" sub={params.ticketUntil ? `This panel's ticket ran out at ${clock(params.ticketUntil)}.` : "This panel's ticket no longer works."} />
      ) : state.kind === "refused" ? (
        <Notice line={`Refused: ${state.error}`} sub={params.query.toString().replace(/&/g, " · ")} mono />
      ) : state.kind === "stale" && !body ? (
        <Notice line="Toposcope is not answering" sub="It will try again." />
      ) : body ? (
        <Plot body={body} span={span} theme={params.theme} muted={stale} />
      ) : null}
    </div>
  );
}

function formatStep(ms: number): string {
  return ms >= 86_400_000 ? `${ms / 86_400_000}d` : ms >= 3_600_000 ? `${ms / 3_600_000}h` : ms >= 60_000 ? `${ms / 60_000}m` : ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`;
}

function Notice({ line, sub, mono = false }: { line: string; sub: string; mono?: boolean }) {
  return (
    <div className="notice">
      <span className="notice-line">{line}</span>
      <span className={`notice-sub ${mono ? "mono" : ""}`}>{sub}</span>
    </div>
  );
}

function Plot({ body, span, theme, muted }: { body: SeriesBody; span: number; theme: "dark" | "light"; muted: boolean }) {
  const { lines, unit } = useMemo(() => embedLines(body), [body]);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 400, h: 180 });
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const values = lines.flatMap((l) => l.points.map((p) => p.v));
  if (values.length === 0) {
    return (
      <div className="plot-wrap">
        <div className="plot" ref={box}>
          <span className="empty">No points in this window</span>
        </div>
      </div>
    );
  }
  const palette = palettes[theme];
  const split = lines.length > 1 || lines[0]?.key !== "";
  const color = (i: number) => (split ? palette.many[i % palette.many.length]! : palette.one);
  const steps = axisSteps(Math.max(...values));
  const top = steps[0]!;
  const from = body.from ? Date.parse(body.from) : Math.min(...lines.flatMap((l) => l.points.map((p) => p.t)));
  const to = body.to ? Date.parse(body.to) : Math.max(...lines.flatMap((l) => l.points.map((p) => p.t)));
  const left = 44;
  const bottom = 18;
  const w = Math.max(1, size.w - left);
  const h = Math.max(1, size.h - bottom);
  const x = (t: number) => left + ((t - from) / Math.max(1, to - from)) * w;
  const y = (v: number) => h - (v / top) * (h - 6);
  const ticks = [0, 1, 2, 3].map((i) => from + ((to - from) * i) / 4);
  const times = [...new Set(lines.flatMap((l) => l.points.map((p) => p.t)))].sort((a, b) => a - b);
  const hoverT = hover === null ? null : times[hover] ?? null;

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = from + ((e.clientX - rect.left - left) / w) * (to - from);
    let best = 0;
    times.forEach((tt, i) => {
      if (Math.abs(tt - t) < Math.abs(times[best]! - t)) best = i;
    });
    setHover(times.length ? best : null);
  }

  return (
    <div className={`plot-wrap ${split && size.w >= 560 ? "with-legend" : ""}`}>
      <div className="plot" ref={box} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg width={size.w} height={size.h} role="img" aria-label="panel series" className={muted ? "muted" : ""}>
          {steps.map((v) => (
            <g key={v}>
              <line className="grid" x1={left} x2={size.w} y1={y(v)} y2={y(v)} />
              <text className="axis" x={left - 6} y={y(v) + 3.5} textAnchor="end">
                {v === 0 ? "0" : withUnit(formatAggStat(v), unit)}
              </text>
            </g>
          ))}
          {ticks.map((t) => (
            <text key={t} className="axis" x={x(t)} y={size.h - 4}>
              {tickLabel(t, span)}
            </text>
          ))}
          {lines.map((l, i) => (
            <polyline
              key={l.key || "line"}
              fill="none"
              stroke={muted ? "currentColor" : color(i)}
              strokeWidth="1.6"
              strokeDasharray={muted ? "4 3" : l.key === "other" ? "3 3" : undefined}
              strokeLinejoin="round"
              points={l.points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}
            />
          ))}
          {hoverT !== null && !muted ? <line className="hair" x1={x(hoverT)} x2={x(hoverT)} y1={0} y2={h} /> : null}
        </svg>
        {hoverT !== null && !muted ? (
          <div role="status" className="readout" style={x(hoverT) > size.w * 0.55 ? { right: size.w - x(hoverT) + 12 } : { left: x(hoverT) + 12 }}>
            <span className="readout-time">{new Date(hoverT).toISOString().slice(span >= 86_400_000 ? 5 : 11, 16).replace("T", " ")}</span>
            {lines.map((l, i) => {
              const p = l.points.find((pp) => pp.t === hoverT);
              return p ? (
                <span key={l.key || "v"} className="readout-row">
                  {split ? <span className="swatch" style={{ background: color(i) }} /> : null}
                  {split ? <span className="readout-key">{l.key}</span> : null}
                  <span>{withUnit(formatAggStat(p.v), unit)}</span>
                </span>
              ) : null;
            })}
          </div>
        ) : null}
      </div>
      {split ? (
        <div className="legend">
          {lines.map((l, i) => (
            <span key={l.key} className="legend-row">
              <span className="swatch" style={{ background: color(i) }} />
              {l.key}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
