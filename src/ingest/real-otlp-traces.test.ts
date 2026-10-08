import { describe, expect, test } from "bun:test";
import { flattenAttrs } from "../shared/attrs";
import { liftException } from "../shared/exception";
import { withFingerprint } from "../shared/fingerprint";
import { liftIdentities } from "../shared/identity";
import type { Span } from "../shared/span";
import { mapOtlpJson } from "./otlp";
import { decodeOtlpProtobuf } from "./otlp-protobuf";
import { Losses } from "./otlp-reply";
import { mapOtlpTraces } from "./otlp-traces";
import { decodeOtlpTracesProtobuf } from "./otlp-traces-protobuf";

// What real exporters posted for one span that recorded an exception, and for
// the log row of that same exception. See fixtures/ingest/README.md.
const fixtures = `${import.meta.dir}/../../fixtures/ingest`;
const versions = (await Bun.file(`${fixtures}/versions.json`).json()) as {
  traces: Record<
    string,
    | string
    | {
        exporter: string;
        bridge: string;
        type: string;
        recorded: string;
        requests: Record<string, { traces: string; logs: string }>;
      }
  >;
};

async function body(file: string): Promise<{ json: boolean; bytes: Uint8Array }> {
  return {
    json: file.endsWith(".json"),
    bytes: new Uint8Array(await Bun.file(`${fixtures}/otlp/${file}`).arrayBuffer()),
  };
}

/** The one span a captured trace request maps to. */
async function span(file: string, losses = new Losses()): Promise<Span> {
  const { json, bytes } = await body(file);
  const spans = mapOtlpTraces(
    json ? (JSON.parse(new TextDecoder().decode(bytes)) as unknown) : decodeOtlpTracesProtobuf(bytes),
    losses,
  );
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

/** The attributes the log row of the same run is stored with, as `insertEvents` builds them. */
async function logged(file: string): Promise<Record<string, string>> {
  const { json, bytes } = await body(file);
  const events = mapOtlpJson(
    json ? (JSON.parse(new TextDecoder().decode(bytes)) as unknown) : decodeOtlpProtobuf(bytes),
  );
  expect(events).toHaveLength(1);
  const event = events[0]!;
  return flattenAttrs(
    withFingerprint(event.level, event.message, liftIdentities(liftException(event.attrs))),
  );
}

describe("a span that recorded an exception, as real OpenTelemetry exporters send it", () => {
  for (const [language, source] of Object.entries(versions.traces)) {
    if (typeof source === "string") {
      continue;
    }
    for (const [encoding, files] of Object.entries(source.requests)) {
      describe(`${language} ${encoding}: ${source.exporter}, recorded ${source.recorded}`, () => {
        test("the span is stored as failed, and nothing is refused", async () => {
          const losses = new Losses();
          expect(await span(files.traces, losses)).toMatchObject({
            service: "billing",
            name: "POST /pay",
            status: "error",
          });
          expect(losses.message()).toBe("");
        });

        test("it keeps the exception's type, message and stack", async () => {
          const { attrs } = await span(files.traces);
          expect(attrs["exception.type"]).toBe(source.type);
          expect(attrs["exception.message"]!.length).toBeGreaterThan(0);
          expect(attrs["exception.stacktrace"]).toContain("charge");
          expect(attrs["exception.frames"]).toBeUndefined();
          expect(attrs.version ?? attrs["service.version"]).toBe("1.4.2");
        });

        test("its id is the one on the log row for the same exception", async () => {
          const { attrs } = await span(files.traces);
          const row = await logged(files.logs);
          expect(row["exception.type"]).toBe(source.type);
          expect(attrs.e1).toMatch(/^[0-9a-f]{16}$/);
          expect(attrs.e1).toBe(row.e1!);
        });

        test("the exception comes first, where the attribute cap cannot drop it", async () => {
          const { attrs } = await span(files.traces);
          expect(Object.keys(attrs).slice(0, 4)).toEqual([
            "e1",
            "exception.type",
            "exception.message",
            "exception.stacktrace",
          ]);
        });
      });
    }
  }

  test("the Python library's own two frames head the span's stack, and are left out of the id", async () => {
    const source = versions.traces.python;
    if (typeof source !== "object") {
      throw new Error("no Python capture");
    }
    const { attrs } = await span(source.requests.protobuf!.traces);
    const row = await logged(source.requests.protobuf!.logs);
    // The library recorded it as it passed through the context managers that hold the span.
    expect(attrs["exception.stacktrace"]).toContain("opentelemetry/trace/__init__.py");
    expect(attrs["exception.stacktrace"]).toContain("in use_span");
    // The logged traceback never has them.
    expect(row["exception.stacktrace"]).not.toContain("opentelemetry");
    expect(attrs.e1).toBe(row.e1!);
  });

  test("protobuf and JSON give the same span, bar its ids and times", async () => {
    const source = versions.traces.node;
    if (typeof source !== "object") {
      throw new Error("no Node capture");
    }
    const protobuf = await span(source.requests.protobuf!.traces);
    const json = await span(source.requests.json!.traces);
    expect(Object.keys(protobuf.attrs)).toEqual(Object.keys(json.attrs));
    expect(protobuf.attrs.e1).toBe(json.attrs.e1!);
    expect(protobuf.attrs["exception.stacktrace"]).toBe(json.attrs["exception.stacktrace"]!);
  });
});
