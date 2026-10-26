import { describe, expect, test } from "bun:test";
import { accessLit, headerTabs, settingsLit } from "./components/operator-header";
import { fieldsCardFacts, namesLine } from "./fields-card";
import type { FieldCatalogRow } from "../shared/fields";

const row = (key: string, kind: "core" | "attr", roleable = kind === "attr"): FieldCatalogRow => ({
  key,
  kind,
  events: 1,
  values: { kind: "pending" } as unknown as FieldCatalogRow["values"],
  roleable,
  linkable: true,
});

describe("Fields under Settings (28a, 28b, #292)", () => {
  test("the header has no Fields tab", () => {
    expect(headerTabs.map((t) => t.label)).toEqual(["Home", "Hunt", "Watch"]);
  });

  test("Access is lit on Access and on view=links (29a, #295)", () => {
    expect(accessLit("access")).toBe(true);
    expect(accessLit("links")).toBe(true);
    expect(accessLit("settings")).toBe(false);
  });

  test("Settings is lit on Settings and on Fields only", () => {
    expect(settingsLit("settings")).toBe(true);
    expect(settingsLit("fields")).toBe(true);
    expect(settingsLit("search")).toBe(false);
    expect(settingsLit("access")).toBe(false);
  });

  test("the card counts keys, chosen roles, unchosen keys and links", () => {
    const facts = fieldsCardFacts({
      keys: [row("level", "core"), row("message", "core"), row("status", "attr"), row("req_id", "attr"), row("debug", "attr"), row("client_ip", "attr"), row("cart_id", "attr")],
      roles: { status: "chart", req_id: "lookup", debug: "ignore", gone: "lookup" },
      links: { service: "service", host: "instance" },
    });
    expect(facts).toEqual({
      keys: 7,
      core: 2,
      attrs: 5,
      roles: { chart: 1, lookup: 1, ignore: 1 },
      unchosen: ["client_ip", "cart_id"],
      links: ["host", "service"],
    });
  });

  test("names past three fold into +N", () => {
    expect(namesLine(["a", "b"])).toBe("a, b");
    expect(namesLine(["a", "b", "c", "d", "e"])).toBe("a, b, c +2");
  });
});
