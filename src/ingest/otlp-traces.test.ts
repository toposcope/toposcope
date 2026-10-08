import { describe, expect, test } from "bun:test";
import { flattenAttrs } from "../shared/attrs";
import { liftException } from "../shared/exception";
import { computeFingerprint, withFingerprint } from "../shared/fingerprint";
import { liftIdentities } from "../shared/identity";
import { mapOtlpJson } from "./otlp";
import { Losses } from "./otlp-reply";
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

describe("a span keeps the exception recorded on it", () => {
  const stack =
    "TypeError: Cannot read properties of undefined (reading 'token')\n" +
    "    at charge (/app/src/billing.js:41:9)\n" +
    "    at processPayment (/app/src/api.js:88:5)";
  const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const thrown = {
    name: "exception",
    timeUnixNano: "1772360100000000000",
    attributes: [
      str("exception.type", "TypeError"),
      str("exception.message", "Cannot read properties of undefined (reading 'token')"),
      str("exception.stacktrace", stack),
    ],
  };
  const request = (span: object, resource: object[] = [str("service.name", "billing")]) => ({
    resourceSpans: [
      {
        resource: { attributes: resource },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "aabbccddeeff00112233445566778899",
                spanId: "1122334455667788",
                name: "POST /pay",
                startTimeUnixNano: "1772360100000000000",
                endTimeUnixNano: "1772360100412000000",
                status: { code: 2 },
                ...span,
              },
            ],
          },
        ],
      },
    ],
  });
  const one = (span: object, resource?: object[]) => mapOtlpTraces(request(span, resource))[0]!;

  /** The `e1` the log row for the same exception is stored with, as `insertEvents` builds it. */
  function loggedE1(attributes: object[]): string {
    const [event] = mapOtlpJson({
      resourceLogs: [
        {
          resource: { attributes: [str("service.name", "billing")] },
          scopeLogs: [{ logRecords: [{ severityText: "ERROR", body: { stringValue: "charge failed" }, attributes }] }],
        },
      ],
    });
    return flattenAttrs(
      withFingerprint(event!.level, event!.message, liftIdentities(liftException(event!.attrs))),
    ).e1!;
  }

  test("its type, its message, its stack, and the id those give", () => {
    const span = one({ events: [thrown], attributes: [str("http.route", "/pay")] });
    expect(span.status).toBe("error");
    expect(span.attrs).toMatchObject({
      "exception.type": "TypeError",
      "exception.message": "Cannot read properties of undefined (reading 'token')",
      "exception.stacktrace": stack,
      "http.route": "/pay",
    });
    expect(span.attrs.e1).toMatch(/^[0-9a-f]{16}$/);
    // The frames are read from the stack; they are not stored beside it.
    expect(span.attrs["exception.frames"]).toBeUndefined();
  });

  test("the id is the one the log row for the same exception carries", () => {
    const span = one({ events: [thrown] });
    expect(span.attrs.e1).toBe(loggedE1([str("exception.type", "TypeError"), str("exception.stacktrace", stack)]));
    // It comes from the frames, so a different message does not change it.
    const reworded = one({
      events: [{ ...thrown, attributes: [thrown.attributes[0], str("exception.message", "another"), thrown.attributes[2]] }],
    });
    expect(reworded.attrs.e1).toBe(span.attrs.e1!);
  });

  test("with no stack the id comes from the type and the message", () => {
    const span = one({ events: [{ name: "exception", attributes: [str("exception.type", "TimeoutError"), str("exception.message", "upstream took 3000 ms")] }] });
    expect(span.attrs.e1).toBe(computeFingerprint("error", "upstream took 3000 ms", { "exception.type": "TimeoutError" })!);
    expect(span.attrs["exception.stacktrace"]).toBeUndefined();
  });

  test("the last exception recorded is the one kept; other events are not", () => {
    const span = one({
      events: [
        { name: "exception", attributes: [str("exception.type", "RetryableError"), str("exception.message", "first try")] },
        { name: "retry", attributes: [str("attempt", "2")] },
        thrown,
        { name: "cache.miss", attributes: [str("key", "order:41")] },
      ],
    });
    expect(span.attrs["exception.type"]).toBe("TypeError");
    expect(span.attrs.attempt).toBeUndefined();
    expect(span.attrs.key).toBeUndefined();
  });

  test("a span with no exception is stored as it was", () => {
    const span = one({ events: [{ name: "cache.miss", attributes: [str("key", "order:41")] }], attributes: [str("http.route", "/pay")] });
    expect(span.attrs).toEqual({ "http.route": "/pay" });
  });

  test("the same fields set on the span itself are read the same way, and a sender's id is replaced", () => {
    const span = one({
      attributes: [str("e1", "not-an-id"), str("exception.type", "TypeError"), str("exception.stacktrace", stack)],
    });
    expect(span.attrs.e1).toBe(one({ events: [thrown] }).attrs.e1!);
    // A message alone, on the span, is not an exception.
    expect(one({ attributes: [str("exception.message", "just a note")] }).attrs.e1).toBeUndefined();
  });

  test("the recorded exception wins over the same fields on the span, and comes first under the cap", () => {
    const wide = Array.from({ length: 60 }, (_, i) => str(`resource.attr_${i}`, "x"));
    const losses = new Losses();
    const [span] = mapOtlpTraces(
      request({ events: [thrown], attributes: [str("exception.type", "SomethingElse")] }, [str("service.name", "billing"), ...wide]),
      losses,
    );
    expect(Object.keys(span!.attrs).slice(0, 4)).toEqual(["e1", "exception.type", "exception.message", "exception.stacktrace"]);
    expect(span!.attrs["exception.type"]).toBe("TypeError");
    expect(Object.keys(span!.attrs)).toHaveLength(50);
    expect(losses.message()).toContain("cap");
  });

  test("the tracing library's own frames at the outer end of a stack are left out of the id", () => {
    const logged = [
      "Traceback (most recent call last):",
      '  File "/app/app.py", line 15, in <module>',
      "    charge({})",
      '  File "/app/app.py", line 9, in charge',
      '    return {"receipt": order["card"]["token"]}',
      "KeyError: 'card'",
    ];
    // As the Python library records it: through the two context managers that hold the span.
    const recorded = [
      logged[0],
      '  File "/usr/local/lib/python3.13/site-packages/opentelemetry/trace/__init__.py", line 602, in use_span',
      "    yield span",
      '  File "/usr/local/lib/python3.13/site-packages/opentelemetry/sdk/trace/__init__.py", line 1136, in start_as_current_span',
      "    yield span",
      ...logged.slice(1),
    ];
    const span = one({
      events: [{ name: "exception", attributes: [str("exception.type", "KeyError"), str("exception.message", "'card'"), str("exception.stacktrace", recorded.join("\n"))] }],
    });
    expect(span.attrs.e1).toBe(loggedE1([str("exception.type", "KeyError"), str("exception.stacktrace", logged.join("\n"))]));
    // The stack itself is kept as it was recorded.
    expect(span.attrs["exception.stacktrace"]).toContain("in use_span");
  });

  test("protobuf carries the event too", () => {
    const sent = request({ events: [thrown] });
    const [fromProtobuf] = mapOtlpTraces(decodeOtlpTracesProtobuf(encodeOtlpTracesProtobuf(sent)));
    expect(fromProtobuf!.attrs).toEqual(one({ events: [thrown] }).attrs);
  });
});
