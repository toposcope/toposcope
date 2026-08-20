import { describe, expect, test } from "bun:test";
import type { LogEvent } from "./types";
import {
  promoCellValue,
  promoMetrics,
  promoPicker,
  togglePromotedCol,
} from "./promoted-cols";

function ev(attrs?: Record<string, unknown>): LogEvent {
  return { ts: "2026-08-18T12:00:00.000Z", service: "api", level: "info", message: "m", attrs };
}

describe("promoCellValue", () => {
  test("missing and empty print as null so the table can show an em dash", () => {
    expect(promoCellValue(ev(), "status")).toBeNull();
    expect(promoCellValue(ev({ status: "" }), "status")).toBeNull();
    expect(promoCellValue(ev({ status: 503 }), "status")).toBe("503");
    expect(promoCellValue(ev({ path: "/v1/checkout" }), "path")).toBe("/v1/checkout");
  });
});

describe("promoMetrics", () => {
  test("status codes stay left; durations with mixed width go right", () => {
    expect(promoMetrics("status", ["200", "404", "503"]).num).toBe(false);
    expect(promoMetrics("duration_ms", ["8", "12", "912"]).num).toBe(true);
    expect(promoMetrics("status", ["200", "404", "503"]).w).toBeGreaterThanOrEqual(44);
    expect(promoMetrics("status", ["200", "404", "503"]).w).toBeLessThanOrEqual(96);
  });
});

describe("promoPicker", () => {
  const page = [
    ev({ path: "/v1/checkout", status: "200", user_id: "u-1" }),
    ev({ path: "/v1/checkout", status: "500" }),
    ev({ path: "/healthz", status: "200" }),
    ev({ path: "/v1/orders", status: "201" }),
  ];

  test("suggested is well covered and scannable; unique ids fall to other", () => {
    const pick = promoPicker(page, []);
    expect(pick.suggested.map((item) => item.k)).toEqual(["path", "status"]);
    expect(pick.other.map((item) => item.k)).toEqual(["user_id"]);
  });

  test("a promoted key missing from this page stays in the picker", () => {
    const pick = promoPicker(page, ["trace_id"]);
    expect(pick.other.some((item) => item.k === "trace_id" && item.meta === "not on this page")).toBe(
      true,
    );
  });

  test("cap 3 blocks a fourth add", () => {
    expect(togglePromotedCol(["path", "status", "user_id"], "duration_ms")).toEqual([
      "path",
      "status",
      "user_id",
    ]);
    expect(togglePromotedCol(["path", "status"], "user_id")).toEqual([
      "path",
      "status",
      "user_id",
    ]);
    expect(togglePromotedCol(["path", "status"], "path")).toEqual(["status"]);
  });
});
