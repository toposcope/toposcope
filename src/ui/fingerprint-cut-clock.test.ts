import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import * as cutHelpers from "./fingerprint-cut";
import { toLocalInput } from "./search-url";
import type { ChangeMark } from "../shared/change-mark";
import type { FingerprintCutResult, FingerprintCutWindows } from "../shared/fingerprint-cut";

// Execute the real pure render expressions. Helper-only tests would miss a
// correct helper wired to rounded plot bounds in either caller.
function renderWindows(target: "wash" | "rail", input: Record<string, unknown>): FingerprintCutWindows {
  const file = target === "wash" ? "src/ui/App.tsx" : "src/ui/components/fingerprint-cut-panel.tsx";
  const source = readFileSync(file, "utf8");
  const expression = target === "wash"
    ? source.match(/const cutWindows\s*=([\s\S]*?);\s*const compareWindows/)
    : source.match(/const windows\s*=([\s\S]*?);\s*const nowMs/);
  if (!expression?.[1]) throw new Error(`Cut window expression not found in ${file}`);
  const bindings = { ...cutHelpers, ...input };
  return new Function(...Object.keys(bindings), `return (${expression[1]});`)(...Object.values(bindings));
}

function scenario(from: string, to: string, markTs: string, plotFrom: string, plotTo: string, live = false) {
  const mark: ChangeMark = {id:"mk_clock",kind:"deploy",service:"billing",title:"v0.9",ts:markTs,end_ts:null,attrs:{}};
  const spanMs = Date.parse(to) - Date.parse(from);
  const sideMs = Date.parse(to) - Date.parse(markTs);
  const result: FingerprintCutResult = {
    title:"deployed: billing v0.9", notes:[], sets:[], empty:"",
    windows:{afterFrom:markTs,afterTo:to,beforeFrom:new Date(Date.parse(markTs)-sideMs).toISOString(),beforeTo:markTs,sideMs,banded:false,dead:false},
  };
  const fromMs=Date.parse(plotFrom), toMs=Date.parse(plotTo);
  return { mark, openedAt:to, from:toLocalInput(new Date(from)), to:toLocalInput(new Date(to)), range:"custom",live,spanMs,fromMs,toMs,huntToMs:toMs,windowFromMs:fromMs,windowToMs:toMs,result,cut:{mark,openedAt:to,result} };
}

for (const target of ["wash", "rail"] as const) {
  describe(`fingerprint cut ${target} clock`, () => {
    test("uses the exact returned millisecond window rather than painted buckets", () => {
      const input=scenario("2026-08-14T13:23:34.478Z","2026-08-14T14:23:34.478Z","2026-08-14T13:53:34.478Z","2026-08-14T13:23:00.000Z","2026-08-14T14:23:00.000Z");
      const windows=renderWindows(target,input);
      expect(windows.afterTo).toBe(Date.parse(input.result.windows.afterTo));
      expect(windows.beforeFrom).toBe(Date.parse(input.result.windows.beforeFrom));
      expect(windows.sideMs).toBe(30*60_000);
    });
    test("a mark in the last coarse bucket still has an after side", () => {
      const input=scenario("2026-08-14T08:50:00.000Z","2026-08-14T12:50:00.000Z","2026-08-14T12:20:00.000Z","2026-08-14T08:00:00.000Z","2026-08-14T12:00:00.000Z");
      const windows=renderWindows(target,input);
      expect(windows.dead).toBe(false);
      expect(windows.sideMs).toBe(30*60_000);
    });
    test("Live retains the returned open-time windows despite lagging plot bounds", () => {
      const input=scenario("2026-08-14T13:23:34.478Z","2026-08-14T14:23:34.478Z","2026-08-14T13:53:34.478Z","2026-08-14T13:23:00.000Z","2026-08-14T14:23:00.000Z",true);
      expect(renderWindows(target,input).afterTo).toBe(Date.parse(input.openedAt));
      const shifted={...input,fromMs:input.fromMs+60_000,toMs:input.toMs+60_000,huntToMs:input.toMs+60_000,windowFromMs:input.windowFromMs+60_000,windowToMs:input.windowToMs+60_000};
      expect(renderWindows(target,shifted).afterTo).toBe(Date.parse(input.openedAt));
    });
  });
}
