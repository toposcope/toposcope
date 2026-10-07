import { toOtlpJson } from "../src/ingest/otlp";
import { encodeOtlpProtobuf } from "../src/ingest/otlp-protobuf";
import { formatSyslog3164 } from "../src/ingest/syslog-parse";
import type { LogEvent } from "../src/shared/log-event";
import type { LoadChannel } from "./load-channel";

export type EncodedLoadBatch =
  | {
      transport: "http";
      path: "/api/ingest" | "/v1/logs";
      contentType: string;
      body: string | Uint8Array;
      /** Events in the body. A protobuf reply says what was rejected, not what was stored. */
      count: number;
    }
  | { transport: "udp"; datagrams: string[] };

export function encodeLoadBatch(
  channel: LoadChannel,
  events: LogEvent[],
): EncodedLoadBatch {
  switch (channel) {
    case "json":
      return {
        transport: "http",
        path: "/api/ingest",
        contentType: "application/json",
        body: JSON.stringify(events),
        count: events.length,
      };
    case "ndjson":
      return {
        transport: "http",
        path: "/api/ingest",
        contentType: "application/x-ndjson",
        body: events.map((event) => JSON.stringify(event)).join("\n"),
        count: events.length,
      };
    case "otlp-json":
      return {
        transport: "http",
        path: "/v1/logs",
        contentType: "application/json",
        body: JSON.stringify(toOtlpJson(events)),
        count: events.length,
      };
    case "otlp-protobuf":
      return {
        transport: "http",
        path: "/v1/logs",
        contentType: "application/x-protobuf",
        body: encodeOtlpProtobuf(toOtlpJson(events)),
        count: events.length,
      };
    case "syslog":
      return {
        transport: "udp",
        datagrams: events.map((event) => formatSyslog3164(event)),
      };
    default: {
      const _never: never = channel;
      throw new Error(`unknown load channel ${_never}`);
    }
  }
}
