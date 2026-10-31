import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { outageScreen, retryNow, retryWaitMs, type OutageState } from "../outage";

const pad = (n: number) => String(n).padStart(2, "0");

function utcClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** `24s`, `1m 12s`, `2h 05m`. */
export function outageSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** Ticks while something counts down, so the seconds move. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

function waitLeft(state: Extract<OutageState, { status: "down" }>, now: number): number {
  return Math.max(0, Math.ceil((state.nextAt - now) / 1000));
}

/** 33k / 33l: a band under the header while the last paint stays, and the green one when it is back. */
export function OutageBand({ state }: { state: OutageState }) {
  const now = useNow(state.status === "down");
  if (state.status === "back") {
    return (
      <div
        role="status"
        className="flex h-9 shrink-0 items-center gap-3 border-b border-green-400/30 bg-[#07170d] px-5 text-[13px]"
      >
        <span className="size-[7px] rounded-full bg-green-400" aria-hidden />
        <span>Back after {outageSpan(state.downMs)}</span>
        <span className="text-muted-foreground">searched again</span>
      </div>
    );
  }
  if (state.status !== "down" || outageScreen(state, now)) {
    return null;
  }
  const left = waitLeft(state, now);
  return (
    <div
      role="status"
      className="flex h-9 shrink-0 items-center gap-3 border-b border-amber-400/30 bg-[#1a1405] px-5 text-[13px]"
    >
      <span className="size-[7px] rounded-full bg-amber-400" aria-hidden />
      <span>
        {state.kind === "clickhouse" ? "Lost ClickHouse" : "Lost the app"} at {utcClock(state.since)}
      </span>
      <span className="text-muted-foreground">
        {left > 0 ? `retrying in ${left} s` : "retrying…"} · showing the last paint
      </span>
      <Button type="button" size="sm" variant="outline" className="ml-auto h-6 px-2 text-xs" onClick={retryNow}>
        Retry now
      </Button>
    </div>
  );
}

type Box = { name: string; word: string; tone: "ok" | "bad" | "warn" | "unknown" };

function Node({ box }: { box: Box }) {
  return (
    <div
      className={cn(
        "flex h-[84px] w-[168px] shrink-0 flex-col items-center justify-center gap-1 rounded-[10px] border",
        box.tone === "ok" && "border-white/16 bg-card/60",
        box.tone === "bad" && "border-red-400/55 bg-[#140b0b]",
        box.tone === "warn" && "border-amber-400/55 bg-[#141005]",
        box.tone === "unknown" && "border-dashed border-white/16",
      )}
    >
      <span className={cn("text-[13px]", box.tone === "unknown" && "text-muted-foreground")}>{box.name}</span>
      <span
        className={cn(
          "font-mono text-[11.5px]",
          box.tone === "ok" && "text-green-400",
          box.tone === "bad" && "text-red-400",
          box.tone === "warn" && "text-amber-400",
          box.tone === "unknown" && "text-muted-foreground",
        )}
      >
        {box.word}
      </span>
    </div>
  );
}

function Link({ tone }: { tone: "ok" | "bad" | "warn" | "unknown" }) {
  if (tone === "bad" || tone === "warn") {
    const color = tone === "bad" ? "border-red-400 text-red-400 bg-[#1c0c0c]" : "border-amber-400 text-amber-400 bg-[#1a1405]";
    return (
      <div className="flex w-[150px] shrink-0 items-center justify-center" aria-hidden>
        <div className={cn("w-[58px] border-t-2 border-dashed", color)} />
        <div className={cn("mx-1 flex size-[26px] items-center justify-center rounded-full border text-[13px]", color)}>✕</div>
        <div className={cn("w-[58px] border-t-2 border-dashed", color)} />
      </div>
    );
  }
  return (
    <div className="flex w-[150px] shrink-0 items-center justify-center" aria-hidden>
      <div
        className={cn(
          "w-[120px] border-t-2",
          tone === "ok" ? "border-solid border-green-400/60" : "border-dotted border-white/18",
        )}
      />
    </div>
  );
}

const commands = {
  app: ["docker compose ps", "docker compose logs app --tail 50", "docker compose up -d app"],
  clickhouse: ["docker compose logs clickhouse --tail 50", "df -h", "docker compose up -d clickhouse"],
};

/** 33i / 33j: what is down, how it is being retried, and what to run on the host. */
export function OutageScreen({ state, instance }: { state: OutageState; instance: string }) {
  const now = useNow(state.status === "down");
  if (!outageScreen(state, now) || state.status !== "down") {
    return null;
  }
  const ch = state.kind === "clickhouse";
  const starting = !ch && state.phase !== null;
  const left = waitLeft(state, now);
  const total = retryWaitMs(state.attempt) / 1000;
  const ring = 150.8;
  const offset = ring * (1 - Math.min(1, left / total));
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-9 overflow-auto bg-background p-10">
      <div className="flex items-center" role="img" aria-label={ch ? "This browser and the app answer; ClickHouse does not" : "This browser is online; the app does not answer"}>
        <Node box={{ name: "This browser", word: "online", tone: "ok" }} />
        <Link tone={ch ? "ok" : "bad"} />
        <Node
          box={{
            name: "toposcope app",
            word: ch ? "answering" : starting ? `starting · ${state.phase}` : "no answer",
            tone: ch ? "ok" : "bad",
          }}
        />
        <Link tone={ch ? "warn" : "unknown"} />
        <Node
          box={
            ch
              ? { name: "ClickHouse", word: "not answering", tone: "warn" }
              : { name: "ClickHouse", word: "unknown from here", tone: "unknown" }
          }
        />
      </div>

      <div className="flex max-w-[660px] flex-col items-center gap-2.5 text-center">
        <h1 className="m-0 text-[26px] font-semibold tracking-[-0.01em]">
          {ch
            ? "ClickHouse isn’t answering the app"
            : starting
              ? "The toposcope app is still starting"
              : "Can’t reach the toposcope app"}
        </h1>
        <p className="m-0 text-sm leading-[1.55] text-muted-foreground">
          {ch
            ? "The app is up, but it can’t read or store events. Searches, panels and monitors wait for it. Ingest answers 503, so collectors hold their buffer and resend; nothing they buffered is lost."
            : starting
              ? `${instance} answers but isn’t ready yet (${state.phase}). Your hunt is kept — query, window and panels come back as they were.`
              : `This browser is online but ${instance} isn’t answering. The app process is stopped, restarting, or the network to it is down. Your hunt is kept — query, window and panels come back as they were.`}
        </p>
      </div>

      <div className="flex items-center gap-[22px] rounded-[10px] border bg-card/60 px-[22px] py-[18px]">
        <div className="relative size-14">
          <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden>
            <circle cx="28" cy="28" r="24" fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="3" />
            <circle
              cx="28"
              cy="28"
              r="24"
              fill="none"
              stroke="var(--plate)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={ring}
              strokeDashoffset={offset}
              transform="rotate(-90 28 28)"
              className="transition-[stroke-dashoffset] duration-200"
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center font-mono text-[15px] font-semibold">
            {left}s
          </span>
        </div>
        <div className="flex min-w-[300px] flex-col gap-[5px]">
          <span className="text-sm">
            {left > 0 ? `${ch ? "Checking again" : "Retrying"} in ${left} s` : "Checking…"}{" "}
            <span className="text-muted-foreground">· attempt {state.attempt}</span>
          </span>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {ch && state.detail ? `last error: ${state.detail}` : "waits 2 → 4 → 8 → 15 → 30 s, then every 30 s"}
          </span>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            down since {utcClock(state.since)} UTC · {outageSpan(now - state.since)}
          </span>
        </div>
        <Button type="button" className="h-8 bg-plate font-medium text-[#18181b] hover:bg-plate/90" onClick={retryNow}>
          Retry now
        </Button>
      </div>

      <div className="flex w-[660px] max-w-full flex-col gap-2">
        <span className="text-xs text-muted-foreground">
          {ch ? "On the host, check ClickHouse — a full disk is the usual cause" : "On the host, check the app"}
        </span>
        <div className="rounded-[6.4px] border bg-[#0d0d0f] px-3.5 py-3 font-mono text-[12.5px] leading-[1.85] select-text">
          {commands[state.kind].map((line) => (
            <div key={line}>
              <span className="text-muted-foreground select-none">$ </span>
              {line}
            </div>
          ))}
        </div>
        {ch ? null : (
          <span className="text-xs text-muted-foreground">
            Collectors keep their own buffer while the app is gone and resend when it’s back.
          </span>
        )}
      </div>
    </div>
  );
}

/** The footer's word for it (33i, 33j): `● app unreachable` / `● clickhouse down`. */
export function OutageChip({ state }: { state: OutageState }) {
  if (state.status !== "down") {
    return null;
  }
  return (
    <span className={cn("flex items-center gap-1.5 font-mono", state.kind === "clickhouse" ? "text-amber-400" : "text-red-400")}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {state.kind === "clickhouse" ? "clickhouse down" : state.phase ? "app starting" : "app unreachable"}
    </span>
  );
}
