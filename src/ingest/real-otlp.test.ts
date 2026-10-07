import { describe, expect, test } from "bun:test";
import { flattenAttrs } from "../shared/attrs";
import { liftException, type ExceptionFrame } from "../shared/exception";
import { withFingerprint } from "../shared/fingerprint";
import { liftIdentities } from "../shared/identity";
import type { LogEvent } from "../shared/log-event";
import { mapOtlpJson } from "./otlp";
import { decodeOtlpProtobuf } from "./otlp-protobuf";

const fixtures = `${import.meta.dir}/../../fixtures/ingest`;
const guide = await Bun.file(`${import.meta.dir}/../../docs/ingest.md`).text();
const versions = (await Bun.file(`${fixtures}/versions.json`).json()) as {
  otlp: Record<
    string,
    { exporter: string; bridge: string; type: string; requests: Record<string, string> }
  >;
};

/** The one row a captured request maps to. */
async function row(file: string): Promise<LogEvent> {
  const bytes = new Uint8Array(await Bun.file(`${fixtures}/otlp/${file}`).arrayBuffer());
  const events = mapOtlpJson(
    file.endsWith(".json")
      ? (JSON.parse(new TextDecoder().decode(bytes)) as unknown)
      : decodeOtlpProtobuf(bytes),
  );
  expect(events).toHaveLength(1);
  return events[0]!;
}

/** The attributes that row is stored with, as `insertEvents` builds them. */
function stored(event: LogEvent, message = event.message): Record<string, string> {
  return flattenAttrs(
    withFingerprint(event.level, message, liftIdentities(liftException(event.attrs))),
  );
}

describe("log requests real OpenTelemetry exporters send", () => {
  for (const [language, source] of Object.entries(versions.otlp)) {
    for (const [encoding, file] of Object.entries(source.requests)) {
      describe(`${language} ${encoding}: ${source.exporter} with ${source.bridge}`, () => {
        test("the row is stored", async () => {
          expect(await row(file)).toMatchObject({
            service: "billing",
            level: "error",
            message: "charge failed",
          });
        });

        test("the exception's type and stack are on it", async () => {
          const attrs = stored(await row(file));
          expect(attrs["exception.type"]).toBe(source.type);
          expect(attrs["exception.stacktrace"]).toContain("charge");
          expect(attrs.version).toBe("1.4.2");
        });

        test("the trace id survives", async () => {
          const attrs = stored(await row(file));
          expect(attrs.trace_id).toMatch(/^[0-9a-f]{32}$/);
          expect(attrs.trace_id).not.toBe("0".repeat(32));
          expect(attrs.span_id).toMatch(/^[0-9a-f]{16}$/);
        });

        test("the fingerprint is the frames one", async () => {
          const event = await row(file);
          const attrs = stored(event);
          const frames = JSON.parse(attrs["exception.frames"] ?? "[]") as ExceptionFrame[];
          expect(frames.map((frame) => frame.function)).toContain("charge");
          expect(attrs.e1).toMatch(/^[0-9a-f]{16}$/);
          expect(stored(event, "a reworded message").e1).toBe(attrs.e1!);
        });
      });
    }
  }

  test("Node's protobuf and JSON requests for the same exception get one e1", async () => {
    const { protobuf, json } = versions.otlp.node!.requests;
    expect(stored(await row(protobuf!)).e1).toBe(stored(await row(json!)).e1!);
  });

  test("the JSON request keeps the trace id it was sent with", async () => {
    const file = versions.otlp.node!.requests.json!;
    const sent = (await Bun.file(`${fixtures}/otlp/${file}`).json()) as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ traceId: string }> }> }>;
    };
    expect(stored(await row(file)).trace_id).toBe(
      sent.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.traceId,
    );
  });

  test("the Python exporter has no JSON request to capture", () => {
    expect(Object.keys(versions.otlp.python!.requests)).toEqual(["protobuf"]);
  });

  test("the ingest guide names the exporters they came from", () => {
    for (const source of Object.values(versions.otlp)) {
      expect(guide).toContain(source.exporter);
      expect(guide).toContain(source.bridge);
    }
  });
});
