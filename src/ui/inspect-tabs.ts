import { maxContextTabs } from "./context-tabs";
import { traceTabLabel } from "./waterfall";

export type InspectTab =
  | { kind: "trace"; key: string; value: string; ts: string; service: string }
  | {
      kind: "profile";
      trace_id: string;
      span_id: string;
      service: string;
      name: string;
      ts: string;
    };

function profileTabLabel(spanId: string): string {
  return `profile ${spanId.slice(0, 12)}`;
}

export function inspectTabKey(tab: InspectTab): string {
  switch (tab.kind) {
    case "trace":
      return `trace:${tab.value}`;
    case "profile":
      return `profile:${tab.trace_id}:${tab.span_id}`;
    default: {
      const _n: never = tab;
      return _n;
    }
  }
}

export function inspectTabLabel(tab: InspectTab): string {
  switch (tab.kind) {
    case "trace":
      return traceTabLabel(tab.value);
    case "profile":
      return profileTabLabel(tab.span_id);
    default: {
      const _n: never = tab;
      return _n;
    }
  }
}

export function inspectTabTitle(tab: InspectTab): string {
  switch (tab.kind) {
    case "trace":
      return `Waterfall for ${tab.key}:${tab.value}`;
    case "profile":
      return `Flamegraph for ${tab.service} ${tab.name} · span_id:${tab.span_id}`;
    default: {
      const _n: never = tab;
      return _n;
    }
  }
}

export function inspectTabCloseTitle(tab: InspectTab): string {
  switch (tab.kind) {
    case "trace":
      return "Close trace";
    case "profile":
      return "Close profile";
    default: {
      const _n: never = tab;
      return _n;
    }
  }
}

export function upsertInspectTab(tabs: InspectTab[], tab: InspectTab): InspectTab[] {
  const key = inspectTabKey(tab);
  return [...tabs.filter((item) => inspectTabKey(item) !== key), tab].slice(
    -maxContextTabs,
  );
}

export function sameInspectTab(a: InspectTab | null, b: InspectTab | null): boolean {
  return !!a && !!b && inspectTabKey(a) === inspectTabKey(b);
}
