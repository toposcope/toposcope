import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  fingerprintCutFetchKey,
  fingerprintCutHuntWindows,
  formatCutWindowLines,
  cutRailSurface,
  cutCrumbLabel,
} from "./fingerprint-cut";
import type { ChangeMark } from "../shared/change-mark";

const mark: ChangeMark = {
  id: "mk_cut",
  ts: "2026-08-14T14:11:00.000Z",
  end_ts: null,
  kind: "deploy",
  service: "worker",
  title: "v1.4.3",
  attrs: {},
};

describe("fingerprintCutFetchKey", () => {
  test("live ignores sliding from/to and refetches when span or q changes", () => {
    const live = {
      q: "level:error",
      live: true,
      spanMs: 3_600_000,
      from: "a",
      to: "b",
    };
    expect(fingerprintCutFetchKey(live)).toBe(
      fingerprintCutFetchKey({ ...live, from: "c", to: "d" }),
    );
    expect(fingerprintCutFetchKey(live)).not.toBe(
      fingerprintCutFetchKey({ ...live, spanMs: 7_200_000 }),
    );
    expect(fingerprintCutFetchKey(live)).not.toBe(
      fingerprintCutFetchKey({ ...live, q: "" }),
    );
  });

  test("idle hunts refetch when from/to change", () => {
    const idle = {
      q: "",
      live: false,
      spanMs: 3_600_000,
      from: "a",
      to: "b",
    };
    expect(fingerprintCutFetchKey(idle)).not.toBe(
      fingerprintCutFetchKey({ ...idle, from: "c" }),
    );
  });
});

describe("formatCutWindowLines", () => {
  test("labels equal windows and uses band when the incident is closed", () => {
    const openedAt = "2026-08-14T15:00:00.000Z";
    const huntFrom = Date.parse("2026-08-14T14:00:00.000Z");
    const huntTo = Date.parse(openedAt);
    const point = fingerprintCutHuntWindows(mark, openedAt, huntFrom, huntTo);
    const lines = formatCutWindowLines(point, huntTo);
    expect(lines[0]?.k).toBe("after");
    expect(lines[0]?.v).toContain("14:11:00");
    expect(lines[1]?.k).toBe("before");
    expect(lines[1]?.v).toContain("equal 49m");
    const incident: ChangeMark = {
      ...mark,
      kind: "incident",
      ts: "2026-08-14T03:10:00.000Z",
      end_ts: "2026-08-14T04:12:00.000Z",
    };
    const band = fingerprintCutHuntWindows(
      incident,
      openedAt,
      Date.parse("2026-08-14T00:00:00.000Z"),
      huntTo,
    );
    expect(formatCutWindowLines(band, huntTo)[0]?.k).toBe("band");
  });
});

describe("cutRailSurface", () => {
  const base = {
    hasCut: true,
    detailOpen: false,
    hasSelected: false,
    inspectOpen: false,
    isSurr: false,
    boardOn: false,
  };

  test("Fingerprints lands on the cut even if a row was highlighted", () => {
    expect(
      cutRailSurface({ ...base, hasSelected: true, detailOpen: false }),
    ).toBe("cut");
  });

  test("a selected line pushes detail over the parked cut", () => {
    expect(
      cutRailSurface({
        ...base,
        detailOpen: true,
        hasSelected: true,
      }),
    ).toBe("detail");
  });

  test("a parked cut keeps the rail while a strip tab is open", () => {
    expect(
      cutRailSurface({
        ...base,
        detailOpen: true,
        hasSelected: true,
        inspectOpen: true,
      }),
    ).toBe("cut");
  });

  test("without a cut, a strip tab takes the rail as shipped", () => {
    expect(
      cutRailSurface({
        ...base,
        hasCut: false,
        detailOpen: true,
        hasSelected: true,
        inspectOpen: true,
      }),
    ).toBe("none");
  });

  test("Surroundings and boards do not take the cut rail", () => {
    expect(cutRailSurface({ ...base, isSurr: true })).toBe("none");
    expect(cutRailSurface({ ...base, boardOn: true })).toBe("none");
  });
});

describe("cutCrumbLabel", () => {
  test("names parked-set counts the way frame 2c draws", () => {
    expect(
      cutCrumbLabel(
        {
          title: "deployed: worker v1.4.3",
          windows: {
            afterFrom: "",
            afterTo: "",
            beforeFrom: "",
            beforeTo: "",
            sideMs: 0,
            banded: false,
            dead: false,
          },
          notes: [],
          empty: "",
          sets: [
            {
              id: "first_seen",
              name: "First seen",
              def: "",
              count: 1,
              more: 0,
              rows: [],
            },
            {
              id: "still_here",
              name: "Still here",
              def: "",
              count: 0,
              more: 0,
              rows: [],
            },
            {
              id: "stopped",
              name: "Stopped",
              def: "",
              count: 0,
              more: 0,
              rows: [],
            },
          ],
        },
        "deployed: worker v1.4.3",
      ),
    ).toBe("Cut — first seen 1 · still here 0 · stopped 0");
  });

  test("falls back to the mark title before sets load", () => {
    expect(cutCrumbLabel(null, "deployed: worker v1.4.3")).toBe(
      "Cut — deployed: worker v1.4.3",
    );
  });
});

describe("cut rail width", () => {
  test("398px / 36% is on the hunt-row item — nested max-w-[36%] collapses the rail to deploy…", () => {
    const app = readFileSync("src/ui/App.tsx", "utf8");
    const panel = readFileSync(
      "src/ui/components/fingerprint-cut-panel.tsx",
      "utf8",
    );
    const shell = app.slice(
      app.indexOf("{cut && !isSurr && !boardOn"),
      app.indexOf("<FingerprintCutPanel"),
    );
    expect(shell).toMatch(/w-\[398px\]/);
    expect(shell).toMatch(/max-w-\[36%\]/);
    expect(panel).not.toMatch(/max-w-\[36%\]/);
  });
});

describe("coming back from Follow", () => {
  test("the origin tab must pin the line and keep it through replace search", () => {
    const app = readFileSync("src/ui/App.tsx", "utf8");
    expect(app).toMatch(/snapPinnedEvent\(/);
    expect(app).toMatch(/selectionAfterReplace\(/);
    expect(app).toMatch(/shouldRestoreParkedCut\(/);
    expect(app).toMatch(/followChildSnap\(/);
  });
});
