import { describe, expect, test } from "bun:test";
import { andList, bytesDay, kindsOf, kindsWithScope, leavesWords } from "./link-kinds";

const byKind = (q: string) => Object.fromEntries(kindsWithScope(q).map((l) => [l.kind, l]));

describe("which kinds a scope sends (#329, 33a), as the server decides it", () => {
  test("an empty scope sends all six, whole", () => {
    const lines = kindsWithScope("  ");
    expect(lines.map((l) => l.kind)).toEqual(["logs", "marks", "traces", "metrics", "profiles", "monitors"]);
    expect(lines.every((l) => l.sends)).toBe(true);
    expect(byKind("").logs).toEqual({ kind: "logs", sends: true, words: "every row, message text included" });
  });

  test("level sends logs and marks only, each other box saying why", () => {
    const k = byKind("host:edge-2* level:error");
    expect(k.logs!.sends).toBe(true);
    expect(k.marks).toEqual({ kind: "marks", sends: true, words: "every mark the scope does not rule out by service" });
    expect(k.traces).toEqual({ kind: "traces", sends: false, reason: "the scope names level, which spans do not have", field: "level", cause: "level" });
    expect(k.metrics).toMatchObject({ sends: false, reason: "the scope names level, which points do not have", field: "level" });
    expect(k.profiles).toMatchObject({ sends: false, reason: "they go with their spans, and no spans go", field: null, cause: "level" });
    expect(k.monitors).toMatchObject({ sends: false, reason: "the scope names level; a monitor has a service and a host", field: "level" });
  });

  test("host alone sends all six", () => {
    expect(kindsWithScope("host:edge-2*").every((l) => l.sends)).toBe(true);
    expect(kindsWithScope("service:api OR toposcope:edge-1").every((l) => l.sends)).toBe(true);
  });

  test("bare words send no spans, points, profiles or monitors", () => {
    const k = byKind("timeout service:api");
    expect(k.logs!.sends && k.marks!.sends).toBe(true);
    expect(k.traces).toMatchObject({ sends: false, reason: "the scope names words in the message, which spans do not have", field: null });
    expect(k.profiles!.sends).toBe(false);
    expect(k.monitors!.sends).toBe(false);
  });

  test("another key goes by the map spans and points have; a monitor has none", () => {
    const k = byKind("region:eu duration_ms:>100");
    expect(k.traces!.sends && k.metrics!.sends && k.profiles!.sends).toBe(true);
    expect(k.monitors).toMatchObject({ sends: false, reason: "the scope names region; a monitor has a service and a host" });
    // A number comparison alone still needs a map.
    expect(byKind("duration_ms:>100").monitors).toMatchObject({ sends: false, field: "duration_ms" });
  });

  test("a field under NOT or OR still rules the kind out", () => {
    expect(byKind("-level:debug").traces!.sends).toBe(false);
    expect(byKind("service:api OR level:error").metrics!.sends).toBe(false);
  });
});

describe("kinds in words", () => {
  test("parsed in the one order, a list or a comma string", () => {
    expect(kindsOf("traces,logs,marks")).toEqual(["logs", "marks", "traces"]);
    expect(kindsOf(["monitors", "logs", "nope"])).toEqual(["logs", "monitors"]);
    expect(kindsOf(null)).toEqual(["logs", "marks"]);
  });

  test("andList", () => {
    expect(andList([])).toBe("");
    expect(andList(["logs"])).toBe("logs");
    expect(andList(["logs", "marks"])).toBe("logs and marks");
    expect(andList(["spans", "points", "monitors"], "or")).toBe("spans, points or monitors");
  });

  test("What leaves this instance names exactly the ticked kinds that go", () => {
    expect(leavesWords({ peer: "ian-laptop", q: "level:error OR level:fatal", kinds: ["logs", "marks", "traces", "metrics"], pending: false })).toBe(
      "ian-laptop copies logs and marks matching level:error OR level:fatal from us; no spans or points, because its scope names level; no profiles or monitors, unticked.",
    );
    expect(leavesWords({ peer: "key k-2d18", q: "service:api*", kinds: ["logs", "marks", "traces", "metrics", "profiles", "monitors"], pending: true })).toBe(
      "Once key k-2d18 is pasted, whoever pasted it will copy logs, marks, spans, points, profiles and monitors matching service:api* from us.",
    );
    expect(leavesWords({ peer: "edge-1", q: "", kinds: ["logs", "traces"], pending: false })).toBe("edge-1 copies logs and spans from us; no marks, points, profiles or monitors, unticked.");
  });

  test("bytes a day", () => {
    expect(bytesDay(0)).toBe("0 B");
    expect(bytesDay(900)).toBe("900 B");
    expect(bytesDay(2048)).toBe("2 KiB");
    expect(bytesDay(1.1 * 1024 * 1024)).toBe("1.1 MiB");
    expect(bytesDay(11.3 * 1024 ** 3)).toBe("11.3 GiB");
    expect(bytesDay(250 * 1024 ** 3)).toBe("250 GiB");
  });
});
