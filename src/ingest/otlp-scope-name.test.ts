import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { flattenAttrs, maxAttrKeysPerEvent } from "../shared/attrs";
import { compileQuery } from "../query/compile";
import { mapOtlpJson } from "./otlp";
import { decodeOtlpProtobuf, encodeOtlpProtobuf } from "./otlp-protobuf";

type Attr = { key: string; value: { stringValue: string } };
const attr = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });

function request(opts: { scope?: object; record?: Attr[]; resource?: Attr[] }) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr("service.name", "billing"), ...(opts.resource ?? [])] },
        scopeLogs: [
          {
            ...(opts.scope ? { scope: opts.scope } : {}),
            logRecords: [
              {
                severityText: "ERROR",
                body: { stringValue: "charge failed" },
                traceId: "aabbccddeeff00112233445566778899",
                attributes: opts.record ?? [],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** The attributes a stored row has, in the order the cap counts them. */
function stored(payload: object): Record<string, string> {
  return flattenAttrs(mapOtlpJson(payload)[0]!.attrs);
}

describe("the logger's name on an OTLP log row", () => {
  test("a JSON request's scope name is kept as otel.scope.name", () => {
    expect(stored(request({ scope: { name: "app.billing.Charges" } }))["otel.scope.name"]).toBe(
      "app.billing.Charges",
    );
  });

  test("a protobuf request's scope name is kept too", () => {
    const sent = request({ scope: { name: "app.billing.Charges", version: "1.2.0" } });
    const decoded = decodeOtlpProtobuf(encodeOtlpProtobuf(sent));
    const attrs = stored(decoded as object);
    expect(attrs["otel.scope.name"]).toBe("app.billing.Charges");
    // Not the scope's version or attributes.
    expect(Object.keys(attrs).filter((key) => key.startsWith("otel.scope."))).toEqual([
      "otel.scope.name",
    ]);
  });

  test("a row from an unnamed scope has no such attribute", () => {
    expect("otel.scope.name" in stored(request({}))).toBe(false);
    expect("otel.scope.name" in stored(request({ scope: { name: "" } }))).toBe(false);
  });

  test("a record that sets the attribute itself keeps its own value", () => {
    const attrs = stored(
      request({ scope: { name: "from.scope" }, record: [attr("otel.scope.name", "from.record")] }),
    );
    expect(attrs["otel.scope.name"]).toBe("from.record");
  });

  test("it counts after the record's attributes and trace id, before the resource's", () => {
    const own = Array.from({ length: 10 }, (_, i) => attr(`app_${i}`, "x"));
    const resource = Array.from({ length: 60 }, (_, i) => attr(`process.detail_${i}`, "x"));
    const keys = Object.keys(stored(request({ scope: { name: "app.billing" }, record: own, resource })));
    expect(keys).toHaveLength(maxAttrKeysPerEvent);
    expect(keys.indexOf("otel.scope.name")).toBe(keys.indexOf("trace_id") + 1);
    expect(keys.indexOf("otel.scope.name")).toBeLessThan(keys.indexOf("process.detail_0"));
  });

  test("a record that fills the cap on its own leaves no room for it", () => {
    const own = Array.from({ length: maxAttrKeysPerEvent }, (_, i) => attr(`app_${i}`, "x"));
    expect("otel.scope.name" in stored(request({ scope: { name: "app.billing" }, record: own }))).toBe(
      false,
    );
  });

  test("real exporters: Python sends the logger, Node's pino bridge sends the bridge", async () => {
    const dir = join(import.meta.dir, "../../fixtures/ingest/otlp");
    const python = decodeOtlpProtobuf(new Uint8Array(await Bun.file(join(dir, "python.logs.bin")).arrayBuffer()));
    expect(stored(python as object)["otel.scope.name"]).toBe("billing");
    const node = await Bun.file(join(dir, "node.logs.json")).json();
    expect(stored(node as object)["otel.scope.name"]).toBe("@opentelemetry/instrumentation-pino");
  });

  test("the bar finds it as one key", () => {
    const { ast, faults } = compileQuery("otel.scope.name:app.billing.Charges");
    expect(faults).toEqual([]);
    expect(JSON.stringify(ast)).toContain('"key":"otel.scope.name"');
    expect(JSON.stringify(ast)).toContain("app.billing.Charges");
  });
});
