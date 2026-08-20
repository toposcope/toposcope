import protobuf from "protobufjs";

/** OTLP logs ExportLogsServiceRequest, field numbers match opentelemetry-proto. */
const proto = `
syntax = "proto3";
package otlp;

message ExportLogsServiceRequest {
  repeated ResourceLogs resource_logs = 1;
}

message ResourceLogs {
  Resource resource = 1;
  repeated ScopeLogs scope_logs = 2;
}

message Resource {
  repeated KeyValue attributes = 1;
}

message ScopeLogs {
  repeated LogRecord log_records = 2;
}

message LogRecord {
  fixed64 time_unix_nano = 1;
  uint32 severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  bytes trace_id = 9;
  bytes span_id = 10;
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

function logsExportType(): protobuf.Type {
  if (!exportType) {
    const parsed = protobuf.parse(proto);
    exportType = parsed.root.lookupType("otlp.ExportLogsServiceRequest");
  }
  return exportType;
}

export function isOtlpProtobufContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const ct = contentType.toLowerCase();
  return ct.includes("protobuf") || ct.includes("application/grpc");
}

export function decodeOtlpProtobuf(buf: Uint8Array): unknown {
  const type = logsExportType();
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

export function encodeOtlpProtobuf(payload: object): Uint8Array {
  const type = logsExportType();
  return type.encode(type.fromObject(payload)).finish();
}
