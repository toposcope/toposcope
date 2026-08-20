import { describe, expect, test } from "bun:test";
import {
  assignLoadChannels,
  countChannels,
  MAX_SYSLOG_BATCHES,
} from "./load-channel";

describe("assignLoadChannels", () => {
  test("is empty for no batches", () => {
    expect(assignLoadChannels(0, 1)).toEqual([]);
  });

  test("uses every ingest path evenly on a 10k-sized run", () => {
    const assigned = assignLoadChannels(20, 1);
    expect(countChannels(assigned)).toEqual({
      json: 4,
      ndjson: 4,
      "otlp-json": 4,
      "otlp-protobuf": 4,
      syslog: 4,
    });
  });

  test("seed only shuffles order", () => {
    const a = assignLoadChannels(20, 1);
    const b = assignLoadChannels(20, 99);
    expect(a).not.toEqual(b);
    expect(countChannels(a)).toEqual(countChannels(b));
  });

  test("caps syslog so large profiles stay HTTP-heavy", () => {
    const counts = countChannels(assignLoadChannels(1000, 7));
    expect(counts.syslog).toBe(MAX_SYSLOG_BATCHES);
    expect(
      counts.json +
        counts.ndjson +
        counts["otlp-json"] +
        counts["otlp-protobuf"],
    ).toBe(996);
    expect(counts.json).toBeGreaterThan(0);
    expect(counts.ndjson).toBeGreaterThan(0);
    expect(counts["otlp-json"]).toBeGreaterThan(0);
    expect(counts["otlp-protobuf"]).toBeGreaterThan(0);
  });
});
