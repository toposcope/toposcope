import type { LogEvent } from "./types";

export const exportFormats = ["csv", "json", "ndjson"] as const;
export type ExportFormat = (typeof exportFormats)[number];

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function eventsToCsv(events: LogEvent[]): string {
  const header = ["ts", "level", "service", "host", "message", "attrs"];
  const rows = events.map((event) =>
    [
      event.ts,
      event.level,
      event.service,
      event.host ?? "",
      event.message,
      JSON.stringify(event.attrs ?? {}),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

export function eventsToJson(events: LogEvent[]): string {
  return `${JSON.stringify(events, null, 2)}\n`;
}

export function eventsToNdjson(events: LogEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : "");
}

export function exportEvents(events: LogEvent[], format: ExportFormat): {
  filename: string;
  mime: string;
  body: string;
} {
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "");
  if (format === "csv") {
    return {
      filename: `toposcope-${stamp}.csv`,
      mime: "text/csv",
      body: eventsToCsv(events),
    };
  }
  if (format === "ndjson") {
    return {
      filename: `toposcope-${stamp}.ndjson`,
      mime: "application/x-ndjson",
      body: eventsToNdjson(events),
    };
  }
  return {
    filename: `toposcope-${stamp}.json`,
    mime: "application/json",
    body: eventsToJson(events),
  };
}

export function exportScope(q: string, range: string): string {
  return `${q.trim() || "all events"} · ${range}`;
}

export function downloadExport(events: LogEvent[], format: ExportFormat): void {
  const file = exportEvents(events, format);
  const blob = new Blob([file.body], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(url);
}
