import { describe, expect, test } from "bun:test";
import type { HeldGap, HeldSource } from "../shared/held";
import { groupHeadWords, hatchLabel, heldLag, pillWords, positionLines, tableRowWords } from "./held-words";

const now = Date.parse("2026-08-14T15:00:00Z");
const at = (iso: string) => Date.parse(`2026-08-14T${iso}Z`);

const caught = (name: string, filters: string[] = []): HeldSource => ({ name, filters, state: { kind: "caught-up" }, hole: null });
const behind = (name: string, readTo: number): HeldSource => ({ name, filters: [], state: { kind: "behind", readTo }, hole: null });
const quiet = (name: string, since: number, connects: "we" | "they" = "we"): HeldSource => ({
  name,
  filters: [],
  state: { kind: "quiet", since, knownTo: since, connects },
  hole: null,
});

describe("held words (#139)", () => {
  test("the group head: caught up, N short, a hole", () => {
    expect(groupHeadWords([caught("prod-eu")])).toBe("caught up");
    expect(groupHeadWords([behind("prod-eu", at("14:56:02")), quiet("site-0417", at("14:20:31")), caught("prod-us")])).toBe("2 short");
    expect(
      groupHeadWords([{ ...caught("prod-eu"), hole: { from: Date.parse("2026-08-09T18:40:00Z"), to: Date.parse("2026-08-11T00:00:00Z") } }]),
    ).toBe("1 hole");
  });

  test("position lines, as 5c, 5d, 5e and 5h draw them", () => {
    expect(positionLines(behind("prod-eu", at("14:56:02")), now)).toEqual(["4m behind · read to 14:56:02"]);
    expect(positionLines(behind("prod-eu", at("14:55:50")), at("15:00:02"), true)).toEqual(["4m 12s behind · read to 14:55:50"]);
    expect(positionLines(quiet("prod-eu", at("12:58:04")), at("15:00:04"))).toEqual(["not answering since 12:58:04 · 2h 2m"]);
    expect(positionLines(quiet("site-0417", at("14:20:31")), now)).toEqual(["not answering since 14:20:31"]);
    expect(positionLines(quiet("laptop", at("14:20:31"), "they"), now)).toEqual(["has not called since 14:20:31"]);
    expect(
      positionLines(
        { ...caught("prod-eu"), hole: { from: Date.parse("2026-08-09T18:40:00Z"), to: Date.parse("2026-08-11T00:00:00Z") } },
        now,
      ),
    ).toEqual(["hole 08-09 18:40 → 08-11 00:00"]);
  });

  test("the pill names the source on one line", () => {
    const eu = behind("prod-eu", at("14:56:02"));
    const gap: HeldGap = { source: "prod-eu", kind: "behind", from: at("14:56:02"), to: now };
    expect(pillWords([gap], [eu], now)).toBe("prod-eu 4m behind");
    const q = quiet("prod-eu", at("12:58:04"));
    expect(pillWords([{ ...gap, kind: "quiet", from: at("12:58:04") }], [q], now)).toBe("prod-eu not answering since 12:58");
    const hole: HeldGap = { source: "prod-eu", kind: "hole", from: Date.parse("2026-08-09T18:40:00Z"), to: Date.parse("2026-08-11T00:00:00Z") };
    expect(pillWords([hole], [caught("prod-eu")], now)).toBe("prod-eu hole 08-09 18:40 → 08-11");
    expect(
      pillWords([{ ...gap, source: "site-0417", kind: "quiet" }, gap], [quiet("site-0417", at("14:20:31")), eu], now),
    ).toBe("2 short · site-0417 · prod-eu");
    expect(pillWords([], [eu], now)).toBeNull();
  });

  test("hatch labels and table rows", () => {
    const gap: HeldGap = { source: "prod-eu", kind: "behind", from: at("14:56:02"), to: now };
    expect(hatchLabel(gap, [behind("prod-eu", at("14:56:02"))], 1)).toBe("not here yet");
    expect(hatchLabel(gap, [behind("prod-eu", at("14:56:02")), caught("prod-us")], 1)).toBe("prod-eu · not here yet");
    expect(hatchLabel(gap, [behind("prod-eu", at("14:56:02")), quiet("site-0417", 0)], 2)).toBe("prod-eu");
    expect(hatchLabel({ ...gap, kind: "quiet" }, [quiet("prod-eu", at("12:58:04"))], 1)).toBe(
      "no rows from prod-eu — not answering, not quiet",
    );
    expect(tableRowWords(gap, [behind("prod-eu", at("14:56:02"))], now)).toBe(
      "prod-eu read to 14:56:02 — its rows after this are not here yet",
    );
    expect(tableRowWords({ ...gap, kind: "quiet", from: at("12:58:04") }, [quiet("prod-eu", at("12:58:04"))], now)).toBe(
      "prod-eu not answering since 12:58:04 — nothing after this is known from it",
    );
  });

  test("lag", () => {
    expect(heldLag(4 * 60_000)).toBe("4m");
    expect(heldLag(20_000)).toBe("1m");
    expect(heldLag(20_000, true)).toBe("20s");
    expect(heldLag(122 * 60_000)).toBe("2h 2m");
  });
});
