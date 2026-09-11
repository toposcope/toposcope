import { describe, expect, test } from "bun:test";
import {
  InvalidProbeError,
  metricValueToUp,
  parseProbeRequest,
  parseProbeUp,
  parseProbeUrl,
  probeToMetricPoint,
  probesIngestBody,
  pullProbeUp,
  upFromHttpOk,
} from "./probe";

describe("parseProbeUp", () => {
  test("accepts only 0 and 1", () => {
    expect(parseProbeUp(0)).toBe(0);
    expect(parseProbeUp(1)).toBe(1);
    expect(() => parseProbeUp(0.5)).toThrow(InvalidProbeError);
    expect(() => parseProbeUp(true)).toThrow(InvalidProbeError);
    expect(() => parseProbeUp("0")).toThrow(InvalidProbeError);
    expect(() => parseProbeUp(undefined)).toThrow(InvalidProbeError);
  });
});

describe("parseProbeUrl", () => {
  test("accepts http(s) and rejects the rest", () => {
    expect(parseProbeUrl("https://billing.example/health")).toBe(
      "https://billing.example/health",
    );
    expect(parseProbeUrl("http://127.0.0.1:8081/ready")).toContain(
      "http://127.0.0.1:8081/ready",
    );
    expect(() => parseProbeUrl("ftp://billing/health")).toThrow(
      InvalidProbeError,
    );
    expect(() => parseProbeUrl("not-a-url")).toThrow(InvalidProbeError);
    expect(() => parseProbeUrl("")).toThrow(InvalidProbeError);
  });
});

describe("parseProbeRequest", () => {
  test("attaches explicit up=0 without fetching", () => {
    const parsed = parseProbeRequest(
      {
        service: "billing",
        up: 0,
        ts: "2026-08-31T17:30:00.000Z",
        host: "billing-1",
        check: "github",
      },
      { pullAllowed: true },
    );
    expect(parsed.mode).toBe("attach");
    expect(parsed.sample.up).toBe(0);
    expect(parsed.sample.service).toBe("billing");
    expect(parsed.sample.host).toBe("billing-1");
    expect(parsed.sample.check).toBe("github");
    expect(parsed.sample.source).toBe("attach");
  });

  test("up present with url is still attach", () => {
    const parsed = parseProbeRequest(
      {
        service: "billing",
        up: 1,
        url: "https://billing.example/health",
      },
      { pullAllowed: true },
    );
    expect(parsed.mode).toBe("attach");
    expect(parsed.sample.up).toBe(1);
    expect(parsed.sample.target).toBe("https://billing.example/health");
  });

  test("url without up is pull when allowed", () => {
    const parsed = parseProbeRequest(
      { service: "billing", url: "https://billing.example/health" },
      { pullAllowed: true },
    );
    expect(parsed.mode).toBe("pull");
    expect(parsed.sample.source).toBe("pull");
    expect(parsed.sample.target).toBe("https://billing.example/health");
    expect(parsed.sample.up).toBe(0);
  });

  test("array ingest cannot pull", () => {
    expect(() =>
      parseProbeRequest(
        { service: "billing", url: "https://billing.example/health" },
        { pullAllowed: false },
      ),
    ).toThrow(/up must be 0 or 1/);
  });

  test("rejects missing service, missing up/url, and a bad check", () => {
    expect(() =>
      parseProbeRequest({ up: 1 }, { pullAllowed: true }),
    ).toThrow(/service is required/);
    expect(() =>
      parseProbeRequest({ service: "billing" }, { pullAllowed: true }),
    ).toThrow(/up must be 0 or 1, or url to pull/);
    expect(() =>
      parseProbeRequest(
        { service: "billing", up: 1, check: "GitHub Actions" },
        { pullAllowed: true },
      ),
    ).toThrow(/check must be an ident/);
  });
});

describe("probeToMetricPoint", () => {
  test("writes name up with service labels", () => {
    expect(
      probeToMetricPoint({
        ts: "2026-08-31T17:30:00.000Z",
        service: "billing",
        host: "billing-1",
        check: "k8s",
        target: "http://billing:8080/health",
        up: 0,
        source: "pull",
      }),
    ).toEqual({
      ts: "2026-08-31T17:30:00.000Z",
      name: "up",
      value: 0,
      labels: {
        service: "billing",
        host: "billing-1",
        check: "k8s",
        target: "http://billing:8080/health",
        source: "pull",
      },
    });
  });

  test("omits empty host and check", () => {
    expect(
      probeToMetricPoint({
        ts: "2026-08-31T17:30:00.000Z",
        service: "billing",
        host: "",
        check: "",
        target: "",
        up: 1,
        source: "attach",
      }).labels,
    ).toEqual({ service: "billing", source: "attach" });
  });
});

describe("pullProbeUp", () => {
  test("2xx is up=1; anything else including throw is up=0", async () => {
    expect(upFromHttpOk(true)).toBe(1);
    expect(upFromHttpOk(false)).toBe(0);
    const ok = await pullProbeUp("https://example.invalid/health", async () =>
      new Response("ok", { status: 200 }),
    );
    expect(ok).toBe(1);
    const down = await pullProbeUp("https://example.invalid/health", async () =>
      new Response("no", { status: 503 }),
    );
    expect(down).toBe(0);
    const missing = await pullProbeUp("https://example.invalid/health", async () => {
      throw new Error("connect");
    });
    expect(missing).toBe(0);
  });
});

describe("probesIngestBody / metricValueToUp", () => {
  test("single object returns up; array does not", () => {
    const sample = {
      ts: "2026-08-31T17:30:00.000Z",
      service: "billing",
      host: "",
      check: "",
      target: "",
      up: 0 as const,
      source: "attach" as const,
    };
    expect(probesIngestBody(true, [sample], 1)).toEqual({ ingested: 1, up: 0 });
    expect(probesIngestBody(false, [sample], 1)).toEqual({ ingested: 1 });
    expect(metricValueToUp(0)).toBe(0);
    expect(metricValueToUp(1)).toBe(1);
    expect(metricValueToUp(0.4)).toBe(1);
  });
});
