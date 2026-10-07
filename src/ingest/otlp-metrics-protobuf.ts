import protobuf from "protobufjs";

/** OTLP ExportMetricsServiceRequest, field numbers match opentelemetry-proto. */
const proto = `
syntax = "proto3";
package otlp;

message ExportMetricsServiceRequest {
  repeated ResourceMetrics resource_metrics = 1;
}

message ResourceMetrics {
  Resource resource = 1;
  repeated ScopeMetrics scope_metrics = 2;
}

message Resource {
  repeated KeyValue attributes = 1;
}

message ScopeMetrics {
  repeated Metric metrics = 2;
}

message Metric {
  string name = 1;
  string unit = 3;
  oneof data {
    Gauge gauge = 5;
    Sum sum = 7;
    Histogram histogram = 9;
    Uncounted exponential_histogram = 10;
    Uncounted summary = 11;
  }
}

message Gauge {
  repeated NumberDataPoint data_points = 1;
}

message Sum {
  repeated NumberDataPoint data_points = 1;
  uint32 aggregation_temporality = 2;
  bool is_monotonic = 3;
}

message Histogram {
  repeated HistogramDataPoint data_points = 1;
  uint32 aggregation_temporality = 2;
}

// A kind that is not stored: only its points are counted.
message Uncounted {
  repeated Empty data_points = 1;
}

message Empty {
}

message NumberDataPoint {
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  oneof value {
    double as_double = 4;
    sfixed64 as_int = 6;
  }
  repeated KeyValue attributes = 7;
  uint32 flags = 8;
}

message HistogramDataPoint {
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  optional double sum = 5;
  repeated KeyValue attributes = 9;
  uint32 flags = 10;
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
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}

message ArrayValue {
  repeated AnyValue values = 1;
}

message KeyValueList {
  repeated KeyValue values = 1;
}
`;

let exportType: protobuf.Type | undefined;

function metricsExportType(): protobuf.Type {
  if (!exportType) {
    exportType = protobuf.parse(proto).root.lookupType("otlp.ExportMetricsServiceRequest");
  }
  return exportType;
}

export function decodeOtlpMetricsProtobuf(buf: Uint8Array): unknown {
  const type = metricsExportType();
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

export function encodeOtlpMetricsProtobuf(payload: object): Uint8Array {
  const type = metricsExportType();
  return type.encode(type.fromObject(payload)).finish();
}
