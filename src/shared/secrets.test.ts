import { describe, expect, test } from "bun:test";
import {
  DEMO_INGEST_TOKEN,
  DEMO_PASSWORD,
  packagedSecretsError,
} from "./secrets";

const generated = {
  TOPOSCOPE_PASSWORD: "not-demo-password",
  TOPOSCOPE_INGEST_TOKEN: "not-demo-token",
  CLICKHOUSE_PASSWORD: "not-demo-ch",
};

describe("packagedSecretsError", () => {
  test("allows generated secrets", () => {
    expect(packagedSecretsError(generated)).toBeNull();
  });

  test("refuses missing, empty, and demo values", () => {
    expect(packagedSecretsError({})).toContain("TOPOSCOPE_PASSWORD");
    expect(
      packagedSecretsError({ ...generated, TOPOSCOPE_PASSWORD: DEMO_PASSWORD }),
    ).toContain("TOPOSCOPE_PASSWORD");
    expect(
      packagedSecretsError({
        ...generated,
        TOPOSCOPE_INGEST_TOKEN: DEMO_INGEST_TOKEN,
      }),
    ).toContain("TOPOSCOPE_INGEST_TOKEN");
    expect(
      packagedSecretsError({ ...generated, CLICKHOUSE_PASSWORD: DEMO_PASSWORD }),
    ).toContain("CLICKHOUSE_PASSWORD");
    expect(
      packagedSecretsError({ ...generated, TOPOSCOPE_PASSWORD: "" }),
    ).toContain("TOPOSCOPE_PASSWORD");
  });

  test("bun run dev may keep localhost demo values", () => {
    expect(
      packagedSecretsError({
        TOPOSCOPE_DEV: "1",
        TOPOSCOPE_PASSWORD: DEMO_PASSWORD,
        TOPOSCOPE_INGEST_TOKEN: DEMO_INGEST_TOKEN,
        CLICKHOUSE_PASSWORD: DEMO_PASSWORD,
      }),
    ).toBeNull();
  });
});
