import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseInsertJsonEachRow, pingClickHouse, toClickHouseDateTime } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { parseChangeMark } from "../shared/change-mark";
import { searchFingerprintCut } from "./fingerprint-cut";

describe("fingerprint cut exact boundaries ClickHouse", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for cut boundary regressions");
    await migrateStore();
  });
  test("service-only cuts keep same-minute events on their actual side and exclude outer edges", async () => {
    const minute=Math.floor((Date.now()-120_000)/60_000)*60_000;
    const markMs=minute+30_221, sideMs=20_000;
    const service=`cutclock${Date.now()}`;
    const iso=(ms:number)=>new Date(ms).toISOString();
    const mark=parseChangeMark({id:`mk_${service}`,kind:"deploy",service,title:service,ts:iso(markMs)});
    // A 20s after side is compared with the hour before the mark (#111).
    const hour=3_600_000;
    const rows=[
      [markMs-1_000,"aaaaaaaaaaaaaaaa"],
      [markMs+1_000,"bbbbbbbbbbbbbbbb"],
      [markMs,"cccccccccccccccc"],
      [markMs-hour-1,"dddddddddddddddd"],
      [markMs+2_000,"dddddddddddddddd"],
      [markMs-hour,"9999999999999999"],
      [markMs+3_000,"9999999999999999"],
      [markMs+sideMs,"eeeeeeeeeeeeeeee"],
    ] as const;
    await clickhouseInsertJsonEachRow(rows.map(([ts,hex])=>JSON.stringify({tenant_id:"default",ts:toClickHouseDateTime(iso(ts)),service,host:"billing-1",level:"error",message:service,attrs:JSON.stringify({e1:hex}),attr_map:{e1:hex},trace_id:""})).join("\n"));
    const result=await searchFingerprintCut({mark,q:`service:${service}`,from:iso(markMs-sideMs),to:iso(markMs+sideMs),opened:iso(markMs+sideMs)});
    const rowsFor=(id:string)=>result.sets.find(set=>set.id===id)?.rows.map(row=>({hex:row.hex,before:row.before,after:row.after})).sort((a,b)=>a.hex.localeCompare(b.hex));
    expect(rowsFor("first_seen")).toEqual([{hex:"bbbbbbbbbbbbbbbb",before:0,after:1},{hex:"cccccccccccccccc",before:0,after:1},{hex:"dddddddddddddddd",before:0,after:1}]);
    expect(rowsFor("still_here")).toEqual([{hex:"9999999999999999",before:1,after:1}]);
    expect(rowsFor("stopped")).toEqual([]);
    expect(result.sets.find(set=>set.id==="stopped")?.waiting).toEqual({haveMs:sideMs,needMs:hour});
  });
  test("an event exactly at the mark belongs only to after on the raw path", async () => {
    const markMs=Date.now()-120_000, service=`cutraw${Date.now()}`;
    const iso=(ms:number)=>new Date(ms).toISOString();
    const mark=parseChangeMark({id:`mk_${service}`,kind:"deploy",service,title:service,ts:iso(markMs)});
    await clickhouseInsertJsonEachRow(JSON.stringify({tenant_id:"default",ts:toClickHouseDateTime(iso(markMs)),service,host:"billing-1",level:"error",message:service,attrs:JSON.stringify({e1:"ffffffffffffffff"}),attr_map:{e1:"ffffffffffffffff"},trace_id:""}));
    const result=await searchFingerprintCut({mark,q:service,from:iso(markMs-20_000),to:iso(markMs+20_000),opened:iso(markMs+20_000)});
    expect(result.sets.find(set=>set.id==="first_seen")?.rows.map(row=>({before:row.before,after:row.after}))).toEqual([{before:0,after:1}]);
    expect(result.sets.find(set=>set.id==="still_here")?.rows).toEqual([]);
  });
});
