import protobuf from "protobufjs";

/** OTLP traces ExportTraceServiceRequest, field numbers match opentelemetry-proto. */
const proto = `
syntax = "proto3";
package otlp;

message ExportTraceServiceRequest {
  repeated ResourceSpans resource_spans = 1;
}

message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
}

message Resource {
  repeated KeyValue attributes = 1;
}

message ScopeSpans {
  repeated Span spans = 2;
}

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  bytes parent_span_id = 4;
  string name = 5;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  Status status = 15;
}

message Status {
  string message = 2;
  int32 code = 3;
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
}

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    bytes bytes_value = 7;
  }
}
`;

let exportType: protobuf.Type | undefined;

function tracesExportType(): protobuf.Type {
  if (!exportType) {
    const parsed = protobuf.parse(proto);
    exportType = parsed.root.lookupType("otlp.ExportTraceServiceRequest");
  }
  return exportType;
}

export function decodeOtlpTracesProtobuf(buf: Uint8Array): unknown {
  const type = tracesExportType();
  return type.toObject(type.decode(new Uint8Array(buf)), {
    longs: String,
    enums: Number,
    bytes: String,
    defaults: false,
    arrays: true,
    objects: true,
    oneofs: true,
  });
}

function hexToBytes(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  if (/^[0-9a-fA-F]{16}$/.test(value) || /^[0-9a-fA-F]{32}$/.test(value)) {
    return Buffer.from(value, "hex");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** OTLP JSON uses hex ids; protobuf wants raw bytes. */
function withByteIds(payload: object): object {
  const root = payload as Record<string, unknown>;
  const groups = root.resourceSpans ?? root.resource_spans;
  if (!Array.isArray(groups)) {
    return payload;
  }
  return {
    ...root,
    resourceSpans: groups.map((rs) => {
      const block = asRecord(rs);
      if (!block) {
        return rs;
      }
      return {
        ...block,
        scopeSpans: list(block.scopeSpans ?? block.scope_spans).map((ss) => {
          const scope = asRecord(ss);
          if (!scope) {
            return ss;
          }
          return {
            ...scope,
            spans: list(scope.spans).map((span) => {
              const row = asRecord(span);
              if (!row) {
                return span;
              }
              return {
                ...row,
                traceId: hexToBytes(row.traceId ?? row.trace_id),
                spanId: hexToBytes(row.spanId ?? row.span_id),
                parentSpanId: hexToBytes(row.parentSpanId ?? row.parent_span_id),
              };
            }),
          };
        }),
      };
    }),
  };
}

export function encodeOtlpTracesProtobuf(payload: object): Uint8Array {
  const type = tracesExportType();
  return type.encode(type.fromObject(withByteIds(payload))).finish();
}
