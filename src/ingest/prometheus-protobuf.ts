import protobuf from "protobufjs";

/** Prometheus remote write 1.0, `prometheus.WriteRequest`; field numbers match prometheus/prompb. */
const proto = `
syntax = "proto3";
package prometheus;

message WriteRequest {
  repeated TimeSeries timeseries = 1;
  repeated MetricMetadata metadata = 3;
}

message TimeSeries {
  repeated Label labels = 1;
  repeated Sample samples = 2;
  // Native histograms are not read: kept as bytes so they can be counted.
  repeated bytes histograms = 4;
}

message Label {
  string name = 1;
  string value = 2;
}

message Sample {
  double value = 1;
  int64 timestamp = 2;
}

message MetricMetadata {
  uint32 type = 1;
  string metric_family_name = 2;
  string help = 4;
  string unit = 5;
}
`;

export type PromLabel = { name: string; value: string };
export type PromSample = { value: number; timestamp: number };
export type PromSeries = { labels: PromLabel[]; samples: PromSample[]; histograms: number };
export type PromMetadata = { type: number; family: string; help: string; unit: string };
export type WriteRequest = { timeseries: PromSeries[]; metadata: PromMetadata[] };

let writeType: protobuf.Type | undefined;

function writeRequestType(): protobuf.Type {
  if (!writeType) {
    writeType = protobuf.parse(proto).root.lookupType("prometheus.WriteRequest");
  }
  return writeType;
}

type Raw = {
  timeseries?: Array<{ labels?: Partial<PromLabel>[]; samples?: Array<{ value?: number; timestamp?: number }>; histograms?: unknown[] }>;
  metadata?: Array<{ type?: number; metricFamilyName?: string; help?: string; unit?: string }>;
};

export function decodeWriteRequest(buf: Uint8Array): WriteRequest {
  const type = writeRequestType();
  const raw = type.toObject(type.decode(buf), { longs: Number, defaults: false, arrays: true }) as Raw;
  return {
    timeseries: (raw.timeseries ?? []).map((series) => ({
      labels: (series.labels ?? []).map((label) => ({ name: label.name ?? "", value: label.value ?? "" })),
      samples: (series.samples ?? []).map((sample) => ({ value: sample.value ?? 0, timestamp: sample.timestamp ?? 0 })),
      histograms: series.histograms?.length ?? 0,
    })),
    metadata: (raw.metadata ?? []).map((meta) => ({
      type: meta.type ?? 0,
      family: meta.metricFamilyName ?? "",
      help: meta.help ?? "",
      unit: meta.unit ?? "",
    })),
  };
}

/** For tests and fixtures. */
export function encodeWriteRequest(req: {
  timeseries?: Array<{ labels: PromLabel[]; samples: PromSample[] }>;
  metadata?: Array<{ type: number; metricFamilyName: string; help?: string; unit?: string }>;
}): Uint8Array {
  const type = writeRequestType();
  return type.encode(type.fromObject(req)).finish();
}
