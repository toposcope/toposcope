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
  test("level, service, host, then the loudest three e1 and how many more", () => {
    const html = render();
    expect(html.indexOf("error")).toBeLessThan(html.indexOf("billing"));
    expect(html).toContain("e1:a91f2c");
    expect(html).toContain("e1:7d20aa");
    expect(html).not.toContain("e1:3b9e10");
    expect(html).toContain("+ 1 e1");
    expect(html).toContain("facet");
  });
  test("a selected value is pressed", () => {
    expect(render()).toMatch(/aria-pressed="true"[^>]*title="level:error"/);
    expect(render()).toMatch(/aria-pressed="false"[^>]*title="service:billing"/);
  });
  test("pulled rows are a from <instance> group", () => {
    const html = render({ facets: { level: [], service: [], host: [], toposcope: [{ v: "ci-box", n: 12 }] } });
    expect(html).toContain("from ci-box");
  });
});
