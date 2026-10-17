import { describe, expect, test } from "bun:test";
import type { Span } from "../shared/span";
import {
  foldStack,
  isResourceKey,
  resourcePreview,
  spanFieldGroups,
  spanJson,
  spanOffsetLabel,
  stackFoldOver,
} from "./span-fields";

const stack = [
  "TimeoutError: No answer within 2 seconds.",
  "    at deliver (/app/dist/webhooks/deliver.js:41:13)",
  "    at async retryPass (/app/dist/webhooks/retry.js:88:7)",
].join("\n");

function span(attrs: Record<string, string>): Span {
  return {
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "00f067aa0ba902b8",
    parent_span_id: "00f067aa0ba902b7",
    service: "api",
    name: "POST",
    ts: "2026-10-16T13:26:46.100Z",
    duration_ms: 2000,
    status: "error",
    attrs,
  };
}

describe("spanFieldGroups", () => {
  test("the exception first, then the span's own, then the resource", () => {
    const groups = spanFieldGroups(
      span({
        "service.version": "3f2a9c1",
        "host.name": "control-1",
        "process.runtime.name": "nodejs",
        "telemetry.sdk.version": "2.12.0",
        "exception.stacktrace": stack,
        e1: "d43d518d4fb6f22a",
        "http.request.method": "POST",
        "url.full": "https://hooks.example.com/sandbox/events/receive",
        "exception.type": "TimeoutError",
        "exception.message": "No answer within 2 seconds.",
        "status.message": "No answer within 2 seconds.",
        "webhook.id": "wh_8f2c",
      }),
    );
    expect(groups.exception?.map((field) => field.k)).toEqual(["type", "message", "stacktrace", "e1"]);
    expect(groups.exception?.[2]?.v).toBe(stack);
    expect(groups.span.map((field) => field.k)).toEqual([
      "http.request.method",
      "url.full",
      "status.message",
      "webhook.id",
    ]);
    expect(groups.resource.map((field) => field.k)).toEqual([
      "service.version",
      "host.name",
      "process.runtime.name",
      "telemetry.sdk.version",
    ]);
  });

  test("no exception: no group, and an e1 stays with the span", () => {
    const groups = spanFieldGroups(span({ "zfs.dataset": "tank/sb-amber", e1: "aaaaaaaaaaaaaaaa", empty: "" }));
    expect(groups.exception).toBeNull();
    expect(groups.span).toEqual([
      { k: "zfs.dataset", v: "tank/sb-amber" },
      { k: "e1", v: "aaaaaaaaaaaaaaaa" },
    ]);
  });

  test("resource keys are OpenTelemetry's resource namespaces", () => {
    expect(isResourceKey("service.version")).toBe(true);
    expect(isResourceKey("k8s.pod.name")).toBe(true);
    expect(isResourceKey("http.request.method")).toBe(false);
    expect(isResourceKey("server.address")).toBe(false);
    expect(isResourceKey("hostname")).toBe(false);
  });
});

describe("foldStack", () => {
  test("a short stack is whole, line breaks kept", () => {
    const fold = foldStack(`${stack}\n`);
    expect(fold).toEqual({ lines: 3, head: stack, hidden: null, tail: "" });
  });

  test("past 20 lines both ends stay and the middle folds", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const fold = foldStack(lines.join("\r\n"));
    expect(fold.lines).toBe(40);
    expect(fold.head.split("\n")).toEqual(lines.slice(0, 8));
    expect(fold.hidden?.count).toBe(26);
    expect(fold.hidden?.text.split("\n")).toEqual(lines.slice(8, 34));
    expect(fold.tail.split("\n")).toEqual(lines.slice(34));
  });

  test(`${stackFoldOver} lines is still whole`, () => {
    const lines = Array.from({ length: stackFoldOver }, (_, i) => `l${i}`);
    expect(foldStack(lines.join("\n")).hidden).toBeNull();
  });
});

describe("the span's chrome", () => {
  test("the closed resource names its first two pairs", () => {
    expect(
      resourcePreview([
        { k: "service.version", v: "3f2a9c1" },
        { k: "host.name", v: "control-1" },
        { k: "os.type", v: "linux" },
      ]),
    ).toBe("service.version 3f2a9c1 · host.name control-1");
  });

  test("JSON is the span as the trace route gives it", () => {
    const s = span({ "exception.type": "TimeoutError" });
    expect(JSON.parse(spanJson(s))).toEqual(s);
  });

  test("an offset only past the trace's start", () => {
    const ms = (n: number) => `${n}ms`;
    expect(spanOffsetLabel(100, ms)).toBe("+100ms");
    expect(spanOffsetLabel(0, ms)).toBe("");
  });
});
