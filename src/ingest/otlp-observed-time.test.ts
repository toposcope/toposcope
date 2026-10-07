import { describe, expect, test } from "bun:test";
import protobuf from "protobufjs";
import { mapOtlpJson } from "./otlp";
import { decodeOtlpProtobuf } from "./otlp-protobuf";

const observed = "1692000000000000000";
const observedIso = "2023-08-14T08:00:00.000Z";

/** A collector tailing a file with no time parser sets only the observed time. */
const payload = {
  resourceLogs: [
    {
      scopeLogs: [
        {
          logRecords: [
            { observedTimeUnixNano: observed, body: { stringValue: "tailed line" } },
          ],
        },
      ],
    },
  ],
};

/** Field numbers match opentelemetry-proto; LogRecord.observed_time_unix_nano is 11. */
const wire = protobuf.parse(`
syntax = "proto3";
package wire;
message Request { repeated ResourceLogs resource_logs = 1; }
message ResourceLogs { repeated ScopeLogs scope_logs = 2; }
message ScopeLogs { repeated LogRecord log_records = 2; }
message LogRecord {
  AnyValue body = 5;
  fixed64 observed_time_unix_nano = 11;
}
message AnyValue { oneof value { string string_value = 1; } }
`).root.lookupType("wire.Request");

describe("OTLP record with only an observed time", () => {
  test("JSON is stored at the observed time, not the receive time", () => {
    const [event] = mapOtlpJson(payload);
    expect(event?.ts).toBe(observedIso);
  });

  test("protobuf is stored at the observed time, not the receive time", () => {
    const bytes = wire.encode(wire.fromObject(payload)).finish();
    const [event] = mapOtlpJson(decodeOtlpProtobuf(bytes));
    expect(event?.ts).toBe(observedIso);
  });
});
