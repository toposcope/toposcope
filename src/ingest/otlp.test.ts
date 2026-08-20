import { describe, expect, test } from "bun:test";
import { mapOtlpJson, toOtlpJson } from "./otlp";
import { decodeOtlpProtobuf, encodeOtlpProtobuf } from "./otlp-protobuf";

describe("mapOtlpJson", () => {
  test("maps resourceLogs to LogEvent", () => {
    const events = mapOtlpJson({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "api" } },
              { key: "host.name", value: { stringValue: "api-1" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1692000000000000000",
                  severityText: "ERROR",
                  body: { stringValue: "timeout" },
                  attributes: [{ key: "path", value: { stringValue: "/v1" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.service).toBe("api");
    expect(events[0]?.host).toBe("api-1");
    expect(events[0]?.level).toBe("error");
    expect(events[0]?.message).toBe("timeout");
    expect(events[0]?.attrs?.path).toBe("/v1");
  });

  test("skips empty bodies and defaults service", () => {
    const events = mapOtlpJson({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { body: { stringValue: "" } },
                { severityNumber: 9, body: { stringValue: "hello" } },
              ],
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.service).toBe("otlp");
    expect(events[0]?.level).toBe("info");
    expect(events[0]?.message).toBe("hello");
  });

  test("rejects missing resourceLogs", () => {
    expect(() => mapOtlpJson({})).toThrow("resourceLogs is required");
  });

  test("copies record traceId and spanId onto attrs", () => {
    const events = mapOtlpJson({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1692000000000000000",
                  body: { stringValue: "span" },
                  traceId: "aabbccddeeff00112233445566778899",
                  spanId: "1122334455667788",
                  attributes: [{ key: "request_id", value: { stringValue: "req-1" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(events[0]?.attrs?.trace_id).toBe("aabbccddeeff00112233445566778899");
    expect(events[0]?.attrs?.span_id).toBe("1122334455667788");
    expect(events[0]?.attrs?.request_id).toBe("req-1");
  });
});

describe("OTLP protobuf", () => {
  test("round-trips through the JSON mapper", () => {
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "api" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1692000000000000000",
                  severityText: "ERROR",
                  body: { stringValue: "timeout" },
                },
              ],
            },
          ],
        },
      ],
    };
    const decoded = decodeOtlpProtobuf(encodeOtlpProtobuf(payload));
    const events = mapOtlpJson(decoded);
    expect(events).toHaveLength(1);
    expect(events[0]?.service).toBe("api");
    expect(events[0]?.message).toBe("timeout");
    expect(events[0]?.level).toBe("error");
  });
});

describe("toOtlpJson", () => {
  test("round-trips service, host, message, and attrs", () => {
    const payload = toOtlpJson([
      {
        ts: "2023-08-14T06:40:00.000Z",
        service: "api",
        host: "api-1",
        level: "error",
        message: "timeout",
        attrs: { path: "/v1", status: 500 },
      },
    ]);
    const events = mapOtlpJson(payload);
    expect(events).toHaveLength(1);
    expect(events[0]?.service).toBe("api");
    expect(events[0]?.host).toBe("api-1");
    expect(events[0]?.level).toBe("error");
    expect(events[0]?.message).toBe("timeout");
    expect(events[0]?.attrs?.path).toBe("/v1");
    expect(events[0]?.attrs?.status).toBe(500);
    expect(events[0]?.ts).toBe("2023-08-14T06:40:00.000Z");
  });
});
