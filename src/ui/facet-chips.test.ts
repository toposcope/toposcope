import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FacetChips } from "./components/facet-chips";

const noop = () => {};
const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(FacetChips, {
      facets: {
        level: [{ v: "error", n: 1600 }, { v: "fatal", n: 293 }],
        service: [{ v: "billing", n: 1890 }],
        host: [{ v: "billing-1", n: 1890 }],
        e1: [{ v: "a91f2c", n: 412 }, { v: "0c77be", n: 96 }, { v: "7d20aa", n: 61 }, { v: "3b9e10", n: 9 }],
      },
      activeFacets: { level: ["error", "fatal"] },
      loading: false,
      attrPins: [],
      attrFacetValues: {},
      attrKeys: [],
      attrKeysLoading: false,
      onToggle: noop,
      onAddAttrFacet: noop,
      onRemoveAttrFacet: noop,
      onOpenAddFacet: noop,
      ...over,
    } as never),
  );

describe("the slice as one row of chips (#260, 26d)", () => {
  test("one labelled line: level, service, host, then the loudest e1 and how many more (47b)", () => {
    const html = render();
    expect(html.indexOf("error")).toBeLessThan(html.indexOf("billing"));
    expect(html).toContain("flex-nowrap");
    expect(html).toMatch(/text-faint">service</);
    expect(html).toContain("e1:a91f2c");
    expect(html).not.toContain("e1:7d20aa");
    expect(html).toContain("+3");
    expect(html).toContain("facet");
  });
  test("a selected value is pressed", () => {
    expect(render()).toMatch(/aria-pressed="true"[^>]*title="level:error"/);
    expect(render()).toMatch(/aria-pressed="false"[^>]*title="service:billing"/);
  });
  test("48b: the query's value is filled; the field's other values read as add, with their counts", () => {
    const html = render({
      facets: { level: [{ v: "warn", n: 945 }, { v: "info", n: 2220 }], service: [{ v: "api", n: 812 }], host: [] },
      activeFacets: { level: ["warn"] },
    });
    expect(html).toMatch(/bg-plate\/15[^"]*" aria-pressed="true"[^>]*><span[^>]*>warn</);
    expect(html).toMatch(/border-dashed[^"]*" aria-pressed="false"[^>]*data-facet-add=""[^>]*><span[^>]*>\+<\/span><span[^>]*>info</);
    // A field the query does not name stays as it was.
    expect(html.match(/data-facet-add/g)).toHaveLength(1);
  });
  test("pulled rows are a from <instance> group", () => {
    const html = render({ facets: { level: [], service: [], host: [], toposcope: [{ v: "ci-box", n: 12 }] } });
    expect(html).toContain("from ci-box");
  });
});
