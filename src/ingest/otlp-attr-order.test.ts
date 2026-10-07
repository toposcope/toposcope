import { describe, expect, test } from "bun:test";
import { flattenAttrs, maxAttrKeysPerEvent } from "../shared/attrs";
import { liftException } from "../shared/exception";
import { withFingerprint } from "../shared/fingerprint";
import { liftIdentities } from "../shared/identity";
import { mapOtlpJson } from "./otlp";

type Attr = { key: string; value: { stringValue: string } };

const attr = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });
const numbered = (count: number, name: (n: string) => string): string[] =>
  Array.from({ length: count }, (_, i) => name(String(i).padStart(2, "0")));

const traceId = "aabbccddeeff00112233445566778899";
const spanId = "1122334455667788";
const appKeys = numbered(10, (n) => `app_${n}`);

/** A stock OpenTelemetry resource: process, runtime, OS and host details. */
function resource(details: number): Attr[] {
  return [
    attr("service.name", "billing"),
    attr("service.version", "0.9.0"),
    ...numbered(details, (n) => `process.detail_${n}`).map((key) => attr(key, "resource")),
  ];
}

function record(extra: Attr[] = []) {
  return {
    severityText: "ERROR",
    body: { stringValue: "charge failed" },
    traceId,
    spanId,
    attributes: [...appKeys.map((key) => attr(key, "record")), ...extra],
  };
}

/** The attributes a row is stored with, as `insertEvents` builds them. */
function stored(resourceAttrs: Attr[], logRecord: object): Record<string, string> {
  const [event] = mapOtlpJson({
    resourceLogs: [
      { resource: { attributes: resourceAttrs }, scopeLogs: [{ logRecords: [logRecord] }] },
    ],
  });
  if (!event) {
    throw new Error("record was not mapped");
  }
  return flattenAttrs(
    withFingerprint(event.level, event.message, liftIdentities(liftException(event.attrs))),
  );
}

describe("OTLP attributes under the 50-key cap", () => {
  test("a record under a resource with 60 attributes keeps its own 10 and its trace id", () => {
    const row = stored(resource(60), record());
    for (const key of appKeys) {
      expect(row[key]).toBe("record");
    }
    expect(row.trace_id).toBe(traceId);
    expect(row.span_id).toBe(spanId);
    expect(Object.keys(row)).toHaveLength(maxAttrKeysPerEvent);
  });

  test("e1 and version stay in front, and the cut falls on the end of the resource", () => {
    expect(Object.keys(stored(resource(60), record()))).toEqual([
      "e1",
      "version",
      ...appKeys,
      "trace_id",
      "span_id",
      ...numbered(36, (n) => `process.detail_${n}`),
    ]);
  });

  test("the record's value wins when the resource uses the same key", () => {
    const row = stored([...resource(0), attr("region", "resource")], record([attr("region", "record")]));
    expect(row.region).toBe("record");
  });

  test("frames read from the record's stack stay with the record, and e1 does not depend on the resource", () => {
    const thrown = [
      attr("exception.type", "TypeError"),
      attr("exception.stacktrace", "TypeError: charge failed\n    at charge (/app/billing.ts:41:9)"),
    ];
    const crowded = stored(resource(60), record(thrown));
    const alone = stored(resource(0), record(thrown));
    expect(crowded["exception.frames"]).toBe('[{"file":"/app/billing.ts","function":"charge"}]');
    expect(crowded["exception.stacktrace"]).toBe(alone["exception.stacktrace"]!);
    expect(crowded.e1).toBe(alone.e1!);
  });
});
