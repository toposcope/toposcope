import { useEffect, useId, useState } from "react";
import { box } from "@/components/check-editor-parts";
import { MonitorField, monitorBox } from "@/components/monitor-field";
import { cn } from "@/lib/utils";

/**
 * Frame 33h (#335): every monitor names the service it is about, required, and the host it
 * checks. The service is picked from those this instance has seen, or typed.
 */

/** Which editor it sits in: what the host defaults to, and what the line under it says. */
export type PlaceKind = "http" | "net" | "push" | "search";

const hostHelp: Record<PlaceKind, string> = {
  http: "From the URL. Change it when the name you search by differs, such as api-1.",
  net: "From the address.",
  push: "Each result carries the host that pushes it.",
  search: "Optional: the host this search is about.",
};

const hostPlaceholder: Record<PlaceKind, string> = {
  http: "api.example.com",
  net: "db.internal",
  push: "optional",
  search: "optional",
};

/** Why Save is off without a service, beside it. */
export const serviceMissing = "Save stays off until a service is chosen or typed.";

/** True once a service is given: Save stays off without one. */
export function serviceOk(service: string): boolean {
  return service.trim() !== "";
}

/** The services seen in the last 24 hours, read once each time an editor opens; none on a failure. */
export function useSeenServices(open: boolean): string[] {
  const [services, setServices] = useState<string[]>([]);
  useEffect(() => {
    if (!open) {
      return;
    }
    const ac = new AbortController();
    void fetch("/api/facets?range=24h", { signal: ac.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ service?: Array<{ value: string; count: number }> }>) : null))
      .then((json) => {
        if (!ac.signal.aborted) {
          setServices((json?.service ?? []).map((v) => v.value).filter((v) => typeof v === "string" && v !== ""));
        }
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, [open]);
  return services;
}

/**
 * A monitor's host: its default (a URL's or address's host) until the operator types one, then
 * what was typed. Editing a monitor starts from the host it has, as typed.
 */
export function useMonitorHost(defaultHost: string): {
  host: string;
  setHost: (value: string) => void;
  reset: (stored: string | null) => void;
} {
  const [typed, setTyped] = useState<string | null>(null);
  return {
    host: typed ?? defaultHost,
    setHost: (value) => setTyped(value),
    reset: (stored) => setTyped(stored),
  };
}

type Props = {
  kind: PlaceKind;
  service: string;
  onService: (value: string) => void;
  host: string;
  onHost: (value: string) => void;
  /** Services seen on this instance, offered as the service is typed. */
  seen: readonly string[];
  /**
   * "field": 18j's labelled rows (a saved-search or push editor); "row": 18r's compact rows
   * under the lines (an HTTP(S) or TCP · certificate editor).
   */
  layout: "field" | "row";
  /** The label column's width, where an editor's rows are wider than 18j's 96px. */
  labelClassName?: string;
};

/** The Service and Host · what is checked rows. */
export function MonitorPlaceFields({ kind, service, onService, host, onHost, seen, layout, labelClassName }: Props) {
  const id = useId();
  const listId = `${id}-services`;
  const serviceId = `${id}-service`;
  const hostId = `${id}-host`;
  const list = (
    <datalist id={listId}>
      {seen.map((s) => (
        <option key={s} value={s} />
      ))}
    </datalist>
  );

  if (layout === "row") {
    return (
      <>
        <span className="flex items-center gap-2 text-[12px]">
          <label htmlFor={serviceId} className="w-14 shrink-0 text-muted-foreground">
            service<span aria-hidden className="text-[#e7e1d3]"> *</span>
          </label>
          <input
            id={serviceId}
            aria-required
            list={listId}
            value={service}
            placeholder={seen[0] ?? "api"}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onService(e.target.value)}
            className={cn(box, "min-h-7 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground")}
          />
          {list}
        </span>
        <span className="flex items-center gap-2 text-[12px]">
          <label htmlFor={hostId} className="w-14 shrink-0 text-muted-foreground">
            host
          </label>
          <input
            id={hostId}
            aria-describedby={`${hostId}-help`}
            value={host}
            placeholder={hostPlaceholder[kind]}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onHost(e.target.value)}
            className={cn(box, "min-h-7 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground")}
          />
        </span>
        <span id={`${hostId}-help`} className="pl-16 text-[11px] text-muted-foreground">
          what is checked · {hostHelp[kind]}
        </span>
      </>
    );
  }

  return (
    <>
      <MonitorField label="Service *" htmlFor={serviceId} className={labelClassName}>
        <input
          id={serviceId}
          aria-required
          list={listId}
          value={service}
          placeholder={seen[0] ?? "api"}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onService(e.target.value)}
          className={cn(monitorBox, "bg-transparent font-mono outline-none placeholder:text-muted-foreground")}
        />
        {list}
        <span className="text-[11.5px] text-muted-foreground">
          {seen.length > 0 ? "Pick one seen here, or type one." : "Type the service it is about."}
        </span>
      </MonitorField>
      <MonitorField label="Host · what is checked" htmlFor={hostId} className={labelClassName}>
        <input
          id={hostId}
          value={host}
          placeholder={hostPlaceholder[kind]}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onHost(e.target.value)}
          className={cn(monitorBox, "bg-transparent font-mono outline-none placeholder:text-muted-foreground")}
        />
        <span className="text-[11.5px] text-muted-foreground">{hostHelp[kind]}</span>
      </MonitorField>
    </>
  );
}
