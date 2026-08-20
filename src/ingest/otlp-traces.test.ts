import { describe, expect, test } from "bun:test";
import { mapOtlpTraces, toOtlpTracesJson } from "./otlp-traces";
import {
  decodeOtlpTracesProtobuf,
  encodeOtlpTracesProtobuf,
} from "./otlp-traces-protobuf";
import type { Span } from "../shared/span";

const sample: Span[] = [
  {
    trace_id: "aabbccddeeff00112233445566778899",
    span_id: "1122334455667788",
    parent_span_id: "",
    service: "nginx",
    name: "GET /wp-admin/post.php",
    ts: "2026-08-16T15:00:00.000Z",
    duration_ms: 412,
    status: "ok",
    attrs: { "http.method": "GET" },
  },
  {
    trace_id: "aabbccddeeff00112233445566778899",
    span_id: "99aabbccddeeff00",
    parent_span_id: "1122334455667788",
    service: "wordpress",
    name: "do_action(save_post)",
    ts: "2026-08-16T15:00:00.012Z",
    duration_ms: 388,
    status: "unset",
    attrs: {},
  },
  {
    trace_id: "aabbccddeeff00112233445566778899",
    span_id: "00ffeeddccbbaa99",
    parent_span_id: "99aabbccddeeff00",
    service: "mysql",
    name: "SELECT wp_options",
    ts: "2026-08-16T15:00:00.044Z",
    duration_ms: 211,
    status: "error",
    attrs: { "status.message": "timeout" },
  },
];

describe("mapOtlpTraces", () => {
  test("maps resourceSpans to spans", () => {
    const spans = mapOtlpTraces(toOtlpTracesJson(sample));
    expect(spans).toHaveLength(3);
    expect(spans[0]?.service).toBe("nginx");
    expect(spans[1]?.parent_span_id).toBe(sample[0]?.span_id);
    expect(spans[2]?.status).toBe("error");
    expect(spans[2]?.attrs["status.message"]).toBe("timeout");
    expect(spans[0]?.duration_ms).toBe(412);
  });

  test("rejects missing resourceSpans", () => {
    expect(() => mapOtlpTraces({})).toThrow("resourceSpans is required");
  });
});

describe("OTLP traces protobuf", () => {
  test("round-trips through the JSON mapper", () => {
    const payload = toOtlpTracesJson(sample);
    const decoded = decodeOtlpTracesProtobuf(encodeOtlpTracesProtobuf(payload));
    const spans = mapOtlpTraces(decoded);
    expect(spans).toHaveLength(3);
    expect(spans.map((span) => span.service).sort()).toEqual([
      "mysql",
      "nginx",
      "wordpress",
    ]);
  });
});
