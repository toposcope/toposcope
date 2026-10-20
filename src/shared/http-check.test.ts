import { describe, expect, test } from "bun:test";
import {
  formatCondition,
  formatConditions,
  formatJsonPath,
  judgeRun,
  parseConditionLine,
  parseConditions,
  parseHttpEvery,
  parseJsonPath,
  verdictSentence,
  type ConditionLine,
  type HttpSeen,
} from "./http-check";

const now = Date.parse("2026-10-20T11:03:12Z");
const day = 86_400_000;

function seen(over: Partial<HttpSeen> = {}): HttpSeen {
  return {
    status: 200,
    headers: [["content-type", "application/json"]],
    body: JSON.stringify({ db: "ok", queue: { depth: 3 }, version: "0.9.3", items: [{ id: "a" }] }),
    durationMs: 182,
    https: true,
    certValidTo: new Date(now + 61 * day).toISOString(),
    ...over,
  };
}

function lines(text: string): ConditionLine[] {
  const out = parseConditions(text);
  if ("error" in out) {
    throw new Error(out.error);
  }
  return out;
}

const run = (s: HttpSeen = seen()) => ({ seen: s, url: "https://api.agental.dev/health" });

describe("condition lines", () => {
  test("each kind reads, and writes back the same way", () => {
    for (const text of [
      "status == 200",
      "status in 200..299",
      "status < 500",
      "time < 300ms",
      'body contains "ok"',
      '$.db == "ok"',
      "$.queue.depth < 100",
      "$.items[0].id != null",
      '$["odd key"] == true',
      "header content-type contains json",
      "cert > 14d",
    ]) {
      const line = parseConditionLine(text);
      expect("error" in line ? line.error : formatCondition(line.cond)).toBe(text);
    }
  });

  test("a trailing warn marks a warn line; the stored text keeps it at the end", () => {
    const parsed = lines("status == 200\ntime < 300ms   warn\n\ncert > 14d");
    expect(parsed.map((l) => [l.text, l.level])).toEqual([
      ["status == 200", "fail"],
      ["time < 300ms", "warn"],
      ["cert > 14d", "fail"],
    ]);
    expect(formatConditions(parsed)).toBe("status == 200\ntime < 300ms   warn\ncert > 14d");
    // A quoted "warn" is the text, not the level.
    const quoted = parseConditionLine('body contains "warn"');
    expect("error" in quoted ? null : quoted.level).toBe("fail");
  });

  test("time takes ms or s; cert takes days or hours", () => {
    const t = parseConditionLine("time < 1.5s");
    expect("error" in t ? null : t.cond).toEqual({ what: "time", op: "<", ms: 1500 });
    const c = parseConditionLine("cert > 48h");
    expect("error" in c ? null : formatCondition(c.cond)).toBe("cert > 2d");
  });

  test("the path is restricted: no filters, wildcards, recursion or scripts", () => {
    expect(parseJsonPath("$.a.b[0]")).toEqual(["a", "b", 0]);
    expect(parseJsonPath('$["a.b"][2]')).toEqual(["a.b", 2]);
    for (const bad of ["$..a", "$.a[*]", "$.a[?(@.x)]", "$.a[(1+1)]", "a.b", "$.a[-1]", "$.a.b()"]) {
      expect(parseJsonPath(bad)).toBeNull();
    }
    expect(formatJsonPath(["queue", "depth"])).toBe("$.queue.depth");
    const bad = parseConditionLine("$..db == 1");
    expect("error" in bad && bad.error).toContain("no filters");
  });

  test("a line that does not read names its line", () => {
    const out = parseConditions('status == 200\nbody has "ok"');
    expect(out).toEqual({ error: expect.stringContaining("line 2: not a condition"), line: 2 });
    expect(parseConditions("$.n < \"x\"")).toEqual({ error: "line 1: < compares a number", line: 1 });
  });

  test("every runs 30s … 1h", () => {
    expect(parseHttpEvery("30s")).toBe(30_000);
    expect(parseHttpEvery("1h")).toBe(3_600_000);
    expect(parseHttpEvery("10s")).toBeNull();
    expect(parseHttpEvery("2h")).toBeNull();
  });
});

describe("judgeRun", () => {
  test("with no lines, a 2xx passes and anything else fails", () => {
    expect(judgeRun([], run(), now).result).toBe("ok");
    const v = judgeRun([], run(seen({ status: 503 })), now);
    expect(v).toMatchObject({ result: "fail", why: "status is 503, not 2xx" });
  });

  test('$.db == "ok" fails on {"db":"down"}, and the verdict names that line', () => {
    const v = judgeRun(lines('status == 200\n$.db == "ok"'), run(seen({ body: '{"db":"down"}' })), now);
    expect(v.result).toBe("fail");
    expect(v.line).toBe('$.db == "ok"');
    expect(v.why).toBe('$.db is "down", not "ok"');
    expect(v.lines.map((l) => [l.pass, l.got])).toEqual([
      [true, "200"],
      [false, '"down"'],
    ]);
  });

  test("a warn line over its time warns; a fail line still fails first", () => {
    const set = lines("status == 200\ntime < 300ms   warn");
    const slow = judgeRun(set, run(seen({ durationMs: 412 })), now);
    expect(slow).toMatchObject({ result: "warn", line: "time < 300ms", why: "412ms is over 300ms" });
    expect(verdictSentence(slow)).toEqual({ word: "warn", rest: ": 412ms is over 300ms." });
    const both = judgeRun(set, run(seen({ durationMs: 412, status: 500 })), now);
    expect(both).toMatchObject({ result: "fail", line: "status == 200" });
  });

  test("cert > 30d fails on a certificate with 20 days left", () => {
    const v = judgeRun(lines("cert > 30d"), run(seen({ certValidTo: new Date(now + 20 * day + 3_600_000).toISOString() })), now);
    expect(v).toMatchObject({ result: "fail", why: "certificate expires in 20 days" });
    expect(v.lines[0]!.got).toBe("20d");
    const plain = judgeRun(lines("cert > 14d"), run(seen({ https: false, certValidTo: null })), now);
    expect(plain.why).toBe("no certificate over http");
  });

  test("a body that is not JSON fails a JSON line, and says so", () => {
    const v = judgeRun(lines('$.db == "ok"'), run(seen({ body: '{"db": "ok",' })), now);
    expect(v).toMatchObject({ result: "fail", why: "the body is not JSON" });
  });

  test("numbers compare as numbers, missing values are missing", () => {
    expect(judgeRun(lines("$.queue.depth < 100"), run(), now).result).toBe("ok");
    expect(judgeRun(lines("$.queue.depth > 100"), run(), now).why).toBe("$.queue.depth is 3, not over 100");
    expect(judgeRun(lines("$.nope == 1"), run(), now).why).toBe("$.nope is missing");
    expect(judgeRun(lines('$.version == "0.9.3"'), run(), now).result).toBe("ok");
    expect(judgeRun(lines('$.items[0].id == "a"'), run(), now).result).toBe("ok");
  });

  test("status, body and headers", () => {
    expect(judgeRun(lines("status in 200..299"), run(seen({ status: 204 })), now).result).toBe("ok");
    expect(judgeRun(lines('body contains "depth"'), run(), now).result).toBe("ok");
    expect(judgeRun(lines('body contains "nope"'), run(), now).why).toBe('the body has no "nope"');
    expect(judgeRun(lines("header content-type contains JSON"), run(), now).result).toBe("ok");
    expect(judgeRun(lines("header x-up contains yes"), run(), now).why).toBe("no x-up header");
  });

  test("a redirect fails, whatever the lines say, and is not followed", () => {
    const v = judgeRun(
      lines("status < 400"),
      run(seen({ status: 302, headers: [["location", "https://elsewhere.example/login"]], body: "" })),
      now,
    );
    expect(v).toMatchObject({ result: "fail", why: "redirects to https://elsewhere.example/login, not followed" });
  });

  test("no response is a fail with its error, and the lines cannot be read", () => {
    const v = judgeRun(lines("status == 200"), { error: "connect ECONNREFUSED" }, now);
    expect(v).toMatchObject({ result: "fail", why: "connect ECONNREFUSED", line: null });
    expect(v.lines).toEqual([{ pass: null, got: "—", why: null }]);
  });
});
