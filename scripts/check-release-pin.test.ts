import { describe, expect, test } from "bun:test";
import { ghcrAppPin, releasePinsMatch } from "./check-release-pin";

describe("ghcrAppPin", () => {
  test("reads the app image tag, not ClickHouse", () => {
    expect(
      ghcrAppPin(`
services:
  clickhouse:
    image: clickhouse/clickhouse-server:26.3
  app:
    image: ghcr.io/toposcope/toposcope:0.3.10
`),
    ).toBe("0.3.10");
  });
});

describe("releasePinsMatch", () => {
  test("accepts matching v-tag, package.json, and compose pin", () => {
    expect(
      releasePinsMatch({
        tag: "v0.3.10",
        packageVersion: "0.3.10",
        composePin: "0.3.10",
      }),
    ).toBeNull();
  });

  test("refuses a mistag", () => {
    expect(
      releasePinsMatch({
        tag: "v0.4.0",
        packageVersion: "0.3.10",
        composePin: "0.3.10",
      }),
    ).toContain("0.4.0");
  });
});
