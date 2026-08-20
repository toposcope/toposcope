import { describe, expect, test } from "bun:test";
import {
  activeEquals,
  analyzeQuery,
  compileQuery,
  emitQuerySql,
  omitField,
  requireCompiled,
  tokenizeQuery,
  QueryCompileError,
} from "./compile";

describe("compileQuery", () => {
  test("empty string yields no filters", () => {
    expect(compileQuery("")).toEqual({ ast: null, faults: [] });
    expect(compileQuery("   ")).toEqual({ ast: null, faults: [] });
  });

  test("field:value equality for core keys", () => {
    const { ast, faults } = compileQuery("level:error service:api host:api-1");
    expect(faults).toEqual([]);
    expect(ast).toEqual({
      op: "and",
      a: {
        op: "and",
        a: { op: "kv", key: "level", value: "error", glob: false },
        b: { op: "kv", key: "service", value: "api", glob: false },
      },
      b: { op: "kv", key: "host", value: "api-1", glob: false },
    });
  });

  test("attr fields including unknown keys", () => {
    const { ast, faults } = compileQuery(
      "path:/v1/items status:500 user_id:42 foo:bar duration_ms:84",
    );
    expect(faults).toEqual([]);
    expect(analyzeQuery({ ast, faults }).attrKeys.sort()).toEqual([
      "duration_ms",
      "foo",
      "path",
      "status",
      "user_id",
    ]);
  });

  test("dotted attr keys", () => {
    const { ast, faults } = compileQuery("http.status_code:500");
    expect(faults).toEqual([]);
    expect(ast).toEqual({
      op: "kv",
      key: "http.status_code",
      value: "500",
      glob: false,
    });
  });

  test("bare tokens are message text", () => {
    const { ast, faults } = compileQuery("timeout panic");
    expect(faults).toEqual([]);
    expect(ast).toEqual({
      op: "and",
      a: { op: "text", value: "timeout", glob: false },
      b: { op: "text", value: "panic", glob: false },
    });
  });

  test("mix of fields and bare words", () => {
    const { ast, faults } = compileQuery("level:error service:api timeout");
    expect(faults).toEqual([]);
    expect(ast).toEqual({
      op: "and",
      a: {
        op: "and",
        a: { op: "kv", key: "level", value: "error", glob: false },
        b: { op: "kv", key: "service", value: "api", glob: false },
      },
      b: { op: "text", value: "timeout", glob: false },
    });
  });

  test("invalid ident after colon is a message term", () => {
    const { ast, faults } = compileQuery("foo-bar:x level:warn");
    expect(faults).toEqual([]);
    expect(ast).toEqual({
      op: "and",
      a: { op: "text", value: "foo-bar:x", glob: false },
      b: { op: "kv", key: "level", value: "warn", glob: false },
    });
  });

  test("empty value after colon is a fault", () => {
    const { faults } = compileQuery("level:");
    expect(faults).toEqual([{ at: 0, msg: "level: has no value" }]);
  });

  test("repeated fields AND together", () => {
    const { ast, faults } = compileQuery("service:api service:worker");
    expect(faults).toEqual([]);
    expect(ast).toEqual({
      op: "and",
      a: { op: "kv", key: "service", value: "api", glob: false },
      b: { op: "kv", key: "service", value: "worker", glob: false },
    });
  });
});

describe("boolean operators", () => {
  test("or is case-insensitive and AND binds tighter", () => {
    const { ast, faults } = compileQuery("level:error or level:fatal status:5*");
    expect(faults).toEqual([]);
    expect(ast).toEqual({
      op: "or",
      a: { op: "kv", key: "level", value: "error", glob: false },
      b: {
        op: "and",
        a: { op: "kv", key: "level", value: "fatal", glob: false },
        b: { op: "kv", key: "status", value: "5", glob: true },
      },
    });
  });

  test("explicit and matches juxtaposition", () => {
    expect(compileQuery("level:error AND service:api").ast).toEqual(
      compileQuery("level:error service:api").ast,
    );
    expect(compileQuery("level:error and service:api").faults).toEqual([]);
    const juxta = compileQuery("service:worker host:worker-2");
    const written = compileQuery("service:worker AND host:worker-2");
    expect(written.ast).toEqual(juxta.ast);
    expect(written.faults).toEqual([]);
    const a: Record<string, string> = {};
    const b: Record<string, string> = {};
    expect(emitQuerySql(written, a, "logs")).toBe(emitQuerySql(juxta, b, "logs"));
    expect(a).toEqual(b);
  });

  test("quoted or is a message phrase", () => {
    const { ast, faults } = compileQuery('"or" level:error');
    expect(faults).toEqual([]);
    expect(ast).toEqual({
      op: "and",
      a: { op: "text", value: "or", glob: false },
      b: { op: "kv", key: "level", value: "error", glob: false },
    });
  });

  test("not and minus negate", () => {
    expect(compileQuery("not level:error").ast).toEqual({
      op: "not",
      a: { op: "kv", key: "level", value: "error", glob: false },
    });
    expect(compileQuery("-level:error").ast).toEqual({
      op: "not",
      a: { op: "kv", key: "level", value: "error", glob: false },
    });
  });

  test("parentheses group or under and", () => {
    const { ast, faults } = compileQuery(
      "(level:error OR level:fatal) service:api",
    );
    expect(faults).toEqual([]);
    expect(ast).toEqual({
      op: "and",
      a: {
        op: "or",
        a: { op: "kv", key: "level", value: "error", glob: false },
        b: { op: "kv", key: "level", value: "fatal", glob: false },
      },
      b: { op: "kv", key: "service", value: "api", glob: false },
    });
  });

  test("quoted phrase and quoted attr value", () => {
    expect(compileQuery('"connection reset"').ast).toEqual({
      op: "text",
      value: "connection reset",
      glob: false,
    });
    expect(compileQuery('path:"/v1/items"').ast).toEqual({
      op: "kv",
      key: "path",
      value: "/v1/items",
      glob: false,
    });
  });
});

describe("faults", () => {
  test("infix and leading stars", () => {
    expect(compileQuery("status:5*0").faults[0]?.msg).toBe(
      "only a trailing * is supported",
    );
    expect(compileQuery("*foo").faults[0]?.msg).toBe(
      "only a trailing * is supported",
    );
    expect(compileQuery("timeout*").faults[0]?.msg).toBe(
      "only a trailing * is supported",
    );
  });

  test("unmatched parens and quotes", () => {
    expect(compileQuery("(level:error").faults.some((f) => f.msg === "unmatched (")).toBe(
      true,
    );
    expect(compileQuery("level:error)").faults[0]?.msg).toBe("unmatched )");
    expect(compileQuery('"open').faults[0]?.msg).toBe("unterminated phrase");
  });

  test("dangling operators", () => {
    expect(compileQuery("level:error OR").faults[0]?.msg).toBe(
      "expected term after or",
    );
    expect(compileQuery("AND service:api").faults[0]?.msg).toBe(
      "expected term before and",
    );
    expect(compileQuery("NOT").faults[0]?.msg).toBe("expected term after not");
  });

  test("requireCompiled throws QueryCompileError", () => {
    expect(() => requireCompiled("level:")).toThrow(QueryCompileError);
  });
});

describe("analyzeQuery / omit / sql", () => {
  test("core or stays on the minute rollup", () => {
    const compiled = compileQuery("level:error OR level:fatal");
    expect(analyzeQuery(compiled)).toEqual({
      hasMessage: false,
      attrKeys: [],
      hasAttrNot: false,
      attrOrWithOther: false,
      hasAttrCmp: false,
    });
  });

  test("single attr glob is one attr key", () => {
    const compiled = compileQuery("service:api status:5*");
    expect(analyzeQuery(compiled).attrKeys).toEqual(["status"]);
    expect(analyzeQuery(compiled).hasMessage).toBe(false);
  });

  test("core or attr is mixed", () => {
    expect(analyzeQuery(compileQuery("level:error OR status:500")).attrOrWithOther).toBe(
      true,
    );
  });

  test("same-key attr or is not mixed", () => {
    expect(
      analyzeQuery(compileQuery("status:500 OR status:502")).attrOrWithOther,
    ).toBe(false);
  });

  test("omitField drops that key and folds or to true", () => {
    const compiled = compileQuery("level:error service:api");
    expect(omitField(compiled, "level").ast).toEqual({
      op: "kv",
      key: "service",
      value: "api",
      glob: false,
    });
    expect(omitField(compileQuery("level:error OR service:api"), "level").ast).toBe(
      null,
    );
  });

  test("minute emit includes host (volume and keys rollups share this shape)", () => {
    const params: Record<string, string> = {};
    const sql = emitQuerySql(
      compileQuery("service:api host:web-1"),
      params,
      "minute",
    );
    expect(sql).toBe("(service = {qp0:String} AND host = {qp1:String})");
    expect(params.qp0).toBe("api");
    expect(params.qp1).toBe("web-1");
  });

  test("emitQuerySql parameterizes or and prefix glob", () => {
    const params: Record<string, string> = { tenant_id: "default" };
    const sql = emitQuerySql(
      compileQuery("level:error OR level:fatal"),
      params,
      "minute",
    );
    expect(sql).toBe("(level = {qp0:String} OR level = {qp1:String})");
    expect(params.qp0).toBe("error");
    expect(params.qp1).toBe("fatal");

    const attr: Record<string, string> = {};
    const glob = emitQuerySql(compileQuery("status:5*"), attr, "attr", "status");
    expect(glob).toBe("startsWith(value, {qp0:String})");
    expect(attr.qp0).toBe("5");
  });

  test("quoted value binds without quotes", () => {
    const params: Record<string, string> = {};
    emitQuerySql(compileQuery('path:"/v1/items"'), params, "logs");
    expect(Object.values(params)).toContain("path");
    expect(Object.values(params)).toContain("/v1/items");
  });

  test("message terms emit hasToken or consecutive hasSubstr", () => {
    const one: Record<string, string> = {};
    expect(emitQuerySql(compileQuery("timeout"), one, "logs")).toBe(
      "hasToken(lowerUTF8(message), {qp0:String})",
    );
    expect(one.qp0).toBe("timeout");
    const phrase: Record<string, string> = {};
    expect(emitQuerySql(compileQuery('"deadline exceeded"'), phrase, "logs")).toBe(
      "(hasToken(lowerUTF8(message), {qp0:String}) AND hasToken(lowerUTF8(message), {qp1:String}) AND hasSubstr(splitByNonAlpha(lowerUTF8(message)), [{qp0:String}, {qp1:String}]))",
    );
    expect(phrase.qp0).toBe("deadline");
    expect(phrase.qp1).toBe("exceeded");
    expect(emitQuerySql(compileQuery('"deadline exceeded"'), {}, "logs")).not.toContain(
      "hasPhrase",
    );
    expect(emitQuerySql(compileQuery('"deadline exceeded"'), {}, "logs")).not.toContain(
      "hasAllTokens",
    );
    const hyphen: Record<string, string> = {};
    expect(emitQuerySql(compileQuery("e2e-1"), hyphen, "logs")).toBe(
      "(hasToken(lowerUTF8(message), {qp0:String}) AND hasToken(lowerUTF8(message), {qp1:String}) AND hasSubstr(splitByNonAlpha(lowerUTF8(message)), [{qp0:String}, {qp1:String}]))",
    );
    expect(hyphen.qp0).toBe("e2e");
    expect(hyphen.qp1).toBe("1");
    expect(emitQuerySql(compileQuery("!!!"), {}, "logs")).toBe("0");
    expect(emitQuerySql(compileQuery("timeout"), {}, "minute")).toBe("0");
  });

  test("activeEquals lists positive equalities", () => {
    expect(activeEquals(compileQuery("level:error OR level:fatal"))).toEqual({
      level: ["error", "fatal"],
    });
    expect(activeEquals(compileQuery("not level:error"))).toEqual({});
    expect(activeEquals(compileQuery("status:5*"))).toEqual({});
    expect(activeEquals(compileQuery("duration_ms:>100"))).toEqual({});
  });

  test("highlighter keeps path: and a quoted value as two spans", () => {
    const tokens = tokenizeQuery('path:"/v1/items"');
    expect(tokens.map((t) => t.t)).toEqual(["key", "str"]);
    expect(tokens[0]?.text).toBe("path:");
    expect(tokens[1]?.text).toBe('"/v1/items"');
  });
});

describe("numeric comparisons", () => {
  test("parses each operator on attr keys", () => {
    expect(compileQuery("duration_ms:>100")).toEqual({
      ast: { op: "cmp", key: "duration_ms", cmp: ">", n: 100 },
      faults: [],
    });
    expect(compileQuery("status:>=500").ast).toEqual({
      op: "cmp",
      key: "status",
      cmp: ">=",
      n: 500,
    });
    expect(compileQuery("duration_ms:<0.5").ast).toEqual({
      op: "cmp",
      key: "duration_ms",
      cmp: "<",
      n: 0.5,
    });
    expect(compileQuery("duration_ms:<=-1").ast).toEqual({
      op: "cmp",
      key: "duration_ms",
      cmp: "<=",
      n: -1,
    });
  });

  test("repeating a key ANDs into a range", () => {
    const { ast, faults } = compileQuery("duration_ms:>100 duration_ms:<500");
    expect(faults).toEqual([]);
    expect(ast).toEqual({
      op: "and",
      a: { op: "cmp", key: "duration_ms", cmp: ">", n: 100 },
      b: { op: "cmp", key: "duration_ms", cmp: "<", n: 500 },
    });
  });

  test("quotes escape the operator; equality stays a string", () => {
    expect(compileQuery('duration_ms:">100"').ast).toEqual({
      op: "kv",
      key: "duration_ms",
      value: ">100",
      glob: false,
    });
    expect(compileQuery("duration_ms:84").ast).toEqual({
      op: "kv",
      key: "duration_ms",
      value: "84",
      glob: false,
    });
    expect(compileQuery("status:5*").ast).toEqual({
      op: "kv",
      key: "status",
      value: "5",
      glob: true,
    });
  });

  test("core fields, empty, junk, glob mix, and scientific notation are faults", () => {
    expect(compileQuery("level:>error").faults[0]?.msg).toBe(
      "level: comparisons are for attrs",
    );
    expect(compileQuery("duration_ms:>").faults[0]?.msg).toBe(
      "duration_ms: comparison needs a number",
    );
    expect(compileQuery("duration_ms:>abc").faults[0]?.msg).toBe(
      "not a finite decimal",
    );
    expect(compileQuery("duration_ms:>10*").faults[0]?.msg).toBe(
      "cannot mix comparison and glob",
    );
    expect(compileQuery("duration_ms:>1e3").faults[0]?.msg).toBe(
      "not a finite decimal",
    );
  });

  test("highlighter splits the operator from the number", () => {
    expect(tokenizeQuery("duration_ms:>=100").map((t) => [t.t, t.text])).toEqual([
      ["key", "duration_ms:"],
      ["op", ">="],
      ["val", "100"],
    ]);
  });

  test("analyzeQuery marks comparisons; omit drops them; they are not equalities", () => {
    const compiled = compileQuery("duration_ms:>100 service:api");
    expect(analyzeQuery(compiled)).toEqual({
      hasMessage: false,
      attrKeys: ["duration_ms"],
      hasAttrNot: false,
      attrOrWithOther: false,
      hasAttrCmp: true,
    });
    expect(omitField(compiled, "duration_ms").ast).toEqual({
      op: "kv",
      key: "service",
      value: "api",
      glob: false,
    });
    expect(activeEquals(compiled)).toEqual({ service: ["api"] });
  });

  test("emitQuerySql parses attr_map as a float on logs and is 0 on rollups", () => {
    const params: Record<string, string> = {};
    const sql = emitQuerySql(compileQuery("duration_ms:>100"), params, "logs");
    expect(sql).toBe(
      "ifNull(toFloat64OrNull(attr_map[{qp0:String}]) > {qp1:Float64}, 0)",
    );
    expect(params.qp0).toBe("duration_ms");
    expect(params.qp1).toBe("100");
    expect(emitQuerySql(compileQuery("duration_ms:>100"), {}, "attr", "duration_ms")).toBe(
      "0",
    );
    expect(emitQuerySql(compileQuery("duration_ms:>100"), {}, "minute")).toBe("0");
  });
});
