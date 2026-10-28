import { useEffect, useMemo, useRef, useState } from "react";
import { HbarWidget } from "@/components/hbar-widget";
import { MetricSpark, sparkTimes } from "@/components/metric-spark";
import { PanelTells } from "@/components/panel-words";
import { StatWidget } from "@/components/stat-widget";
import type { SearchAggResult } from "@/types";
import { unitsDifferWords } from "../metric-unit";
import {
  embedAggResult,
  embedMessage,
  nextEmbedState,
  pollMs,
  type EmbedParams,
  type EmbedState,
  type SeriesBody,
} from "../embed-view";

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
        const res = await fetch(`${params.path}?${params.query.toString()}`, {
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
        <Plot params={params} body={body} muted={stale} />
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

/**
 * The plot, painted by the app's own panel components (#235): what a panel draws in Toposcope it
 * draws here. Muted while Toposcope is not answering.
 */
function Plot({ params, body, muted }: { params: EmbedParams; body: SeriesBody; muted: boolean }) {
  const result = useMemo(() => embedAggResult(body), [body]) as unknown as SearchAggResult;
  const times = useMemo(() => sparkTimes([], result), [result]);
  const window = params.query.get("range") ?? "";
  const metric = params.query.get("metric");
  const reading = (body.series as { reading?: string } | null | undefined)?.reading;
  return (
    <div className={`flex min-h-0 flex-1 flex-col ${muted ? "opacity-40" : ""}`}>
      {params.chart === "top" || params.chart === "donut" ? (
        <HbarWidget
          view={params.chart === "donut" ? "donut" : "bars"}
          split="service"
          attr={body.key ?? params.query.get("key")}
          values={body.values ?? []}
          total={body.total ?? (body.values ?? []).reduce((sum, v) => sum + v.n, 0)}
          n={Number(params.query.get("n") ?? 10) || 10}
          pct={false}
          loading={false}
        />
      ) : params.chart === "stat" ? (
        <StatWidget
          total={body.total ?? 0}
          agg={metric ? null : (body.agg ?? "count")}
          metric={metric}
          aggResult={metric ? result : body.agg === "rate" ? result : null}
          loading={false}
        />
      ) : (
        <>
          {/* Points sent in more than one unit or kind (#331): the one line that says why, as the board says it. */}
          <PanelTells held={null} units={unitsDifferWords(result.units_differ)} />
          <MetricSpark
            times={times}
            result={result}
            readingWord={reading ?? (metric ? (result.kind === "counter" ? "sum" : "avg") : (body.agg ?? "count"))}
            kindWord={result.kind ?? "counter"}
            name={metric ?? params.title}
            window={window}
            live={false}
            chart={params.chart === "bars" || params.chart === "stacked" ? params.chart : "line"}
          />
        </>
      )}
    </div>
  );
}
