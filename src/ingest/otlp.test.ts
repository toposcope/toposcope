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

  test("keeps exception.type and lifts nested exception frames", () => {
    const dotted = mapOtlpJson({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: "boom" },
                  attributes: [
                    { key: "exception.type", value: { stringValue: "RuntimeError" } },
                    {
                      key: "exception.frames",
                      value: {
                        arrayValue: {
                          values: [
                            {
                              kvlistValue: {
                                values: [
                                  { key: "file", value: { stringValue: "app.ts" } },
                                  { key: "function", value: { stringValue: "run" } },
                                  { key: "in_app", value: { boolValue: true } },
                                ],
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(dotted[0]?.attrs?.["exception.type"]).toBe("RuntimeError");
    expect(dotted[0]?.attrs?.["exception.frames"]).toEqual([
      { file: "app.ts", function: "run", in_app: true },
    ]);

    const nested = mapOtlpJson({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: "PHP Fatal error: Uncaught Error: x in /a.php:1" },
                  attributes: [
                    {
                      key: "exception",
                      value: {
                        kvlistValue: {
                          values: [
                            { key: "type", value: { stringValue: "Error" } },
                            {
                              key: "frames",
                              value: {
                                arrayValue: {
                                  values: [
                                    {
                                      kvlistValue: {
                                        values: [
                                          { key: "file", value: { stringValue: "/a.php" } },
                                          { key: "function", value: { stringValue: "main" } },
                                        ],
                                      },
                                    },
                                  ],
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(nested[0]?.attrs?.["exception.type"]).toBe("Error");
    expect(nested[0]?.attrs?.exception).toBeUndefined();
    expect(nested[0]?.message).toContain("PHP Fatal");
  });

  test("does not grok exception fields from a fatal message", () => {
    const events = mapOtlpJson({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  severityText: "ERROR",
                  body: {
                    stringValue:
                      "PHP Fatal error: Uncaught Error: Call to undefined function foo() in /app/index.php:12",
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(events[0]?.attrs?.["exception.type"]).toBeUndefined();
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
