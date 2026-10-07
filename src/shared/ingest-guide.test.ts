import { describe, expect, test } from "bun:test";
import {
  guideExamples,
  guideSection,
  type GuideExample,
} from "../../scripts/ingest-guide-examples";
import { mapOtlpJson } from "../ingest/otlp";
import { flattenAttrs, isAttrIdent, maxAttrKeysPerEvent } from "./attrs";
import { liftException } from "./exception";
import { withFingerprint } from "./fingerprint";
import { liftIdentities } from "./identity";
import { levels, parseIngestEvent, stampEvent, type LogEvent } from "./log-event";

const guide = await Bun.file(`${import.meta.dir}/../../docs/ingest.md`).text();
const section = guideSection(guide, "What an app sends");
const examples = guideExamples(section);

/** The row ingest builds from an example, by the route it is posted to. */
function row(example: GuideExample): LogEvent {
  if (example.path === "/api/ingest") {
    return stampEvent(parseIngestEvent(example.body));
  }
  if (example.path === "/v1/logs") {
    const [event] = mapOtlpJson(example.body);
    if (!event) {
      throw new Error("the OTLP example mapped to no row");
    }
    return event;
  }
  throw new Error(`unexpected example path ${example.path}`);
}

/** The attributes that row is stored with, as `insertEvents` builds them. */
function stored(event: LogEvent, message = event.message): Record<string, string> {
  return flattenAttrs(
    withFingerprint(event.level, message, liftIdentities(liftException(event.attrs))),
  );
}

describe("ingest guide: What an app sends", () => {
  test("shows the row once as OTLP and once as a direct post", () => {
    expect(examples.map((example) => example.path).sort()).toEqual(["/api/ingest", "/v1/logs"]);
  });

  test.each(examples)("the $path example stores an error row with a stack fingerprint", (example) => {
    const event = row(example);
    const attrs = stored(event);
    expect(event.service).toBe("billing");
    expect(event.level).toBe("error");
    expect(event.ts).toBe("2026-03-01T10:15:00.000Z");
    expect(attrs.version).toBe("1.4.2");
    expect(JSON.parse(attrs["exception.frames"] ?? "[]")).toEqual([
      { file: "/app/src/billing.js", function: "charge" },
      { file: "/app/src/api.js", function: "processPayment" },
    ]);
    // From the frames, not the message: a reworded message keeps the id.
    expect(attrs.e1).toMatch(/^[0-9a-f]{16}$/);
    expect(stored(event, "something else entirely").e1).toBe(attrs.e1!);
  });

  test("both examples are the same row", () => {
    const [first, second] = examples.map((example) => stored(row(example)));
    expect(first?.e1).toBe(second?.e1!);
  });

  test("the attribute rules it states are the ones ingest applies", () => {
    expect(section).toContain(`A row keeps ${maxAttrKeysPerEvent} attributes`);
    for (const taken of ["level", "service", "host", "ts", "message", "tenant_id"]) {
      expect(isAttrIdent(taken)).toBe(false);
      expect(section).toContain(`\`${taken}\``);
    }
    expect(isAttrIdent("http.status_code")).toBe(true);
    expect(isAttrIdent("_private")).toBe(true);
    expect(isAttrIdent("9lives")).toBe(false);
    expect(isAttrIdent("user-id")).toBe(false);
  });

  test("the levels it lists are the ones ingest accepts", () => {
    for (const level of levels) {
      expect(section).toContain(`\`${level}\``);
    }
  });

  test("the exporter settings ask for HTTP, and for metrics as deltas", () => {
    expect(section).toContain("OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf");
    expect(section).toContain("OTEL_METRICS_EXPORTER=otlp");
    expect(section).toContain("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta");
  });
});
