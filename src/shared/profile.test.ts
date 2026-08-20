import { describe, expect, test } from "bun:test";
import {
  buildProfileResponse,
  capHeaviestStacks,
  foldStacks,
  pickLatestProfile,
  type ProfileSample,
} from "./profile";

function sample(
  partial: Partial<ProfileSample> & Pick<ProfileSample, "profile_id" | "frames">,
): ProfileSample {
  return {
    service: "wordpress",
    ts: "2026-08-16T14:59:51.408Z",
    duration_ms: 10_000,
    sample_type: "cpu",
    sample_unit: "nanoseconds",
    period_type: "cpu",
    period_unit: "nanoseconds",
    trace_id: "t",
    span_id: "s",
    value: 1,
    ...partial,
  };
}

describe("foldStacks", () => {
  test("sums identical frames inside one profile", () => {
    const frames = ["{main}", "edit_post"];
    expect(
      foldStacks([
        sample({ profile_id: "a", frames, value: 10 }),
        sample({ profile_id: "a", frames, value: 5 }),
      ]),
    ).toEqual([{ frames, value: 15 }]);
  });
});

describe("pickLatestProfile", () => {
  test("picks the latest ts and does not merge", () => {
    const picked = pickLatestProfile([
      sample({ profile_id: "old", ts: "2026-08-16T14:00:00.000Z", frames: ["a"] }),
      sample({ profile_id: "new", ts: "2026-08-16T15:00:00.000Z", frames: ["b"] }),
      sample({ profile_id: "new", ts: "2026-08-16T15:00:00.000Z", frames: ["c"] }),
    ]);
    expect(picked).toEqual({ profileId: "new", totalProfiles: 2 });
  });

  test("ties on ts go to the profile with more samples", () => {
    const ts = "2026-08-16T15:00:00.000Z";
    const picked = pickLatestProfile([
      sample({ profile_id: "thin", ts, frames: ["a"] }),
      sample({ profile_id: "fat", ts, frames: ["b"] }),
      sample({ profile_id: "fat", ts, frames: ["c"] }),
    ]);
    expect(picked?.profileId).toBe("fat");
  });
});

describe("capHeaviestStacks", () => {
  test("keeps the largest values", () => {
    const capped = capHeaviestStacks(
      [
        { frames: ["a"], value: 1 },
        { frames: ["b"], value: 9 },
        { frames: ["c"], value: 3 },
      ],
      2,
    );
    expect(capped.total).toBe(3);
    expect(capped.stacks.map((row) => row.frames[0])).toEqual(["b", "c"]);
  });
});

describe("buildProfileResponse", () => {
  test("folds only the chosen profile", () => {
    const result = buildProfileResponse([
      sample({
        profile_id: "old",
        ts: "2026-08-16T14:00:00.000Z",
        frames: ["{main}"],
        value: 100,
      }),
      sample({
        profile_id: "new",
        ts: "2026-08-16T15:00:00.000Z",
        frames: ["{main}", "edit_post"],
        value: 10,
      }),
      sample({
        profile_id: "new",
        ts: "2026-08-16T15:00:00.000Z",
        frames: ["{main}", "edit_post"],
        value: 4,
      }),
    ]);
    expect(result.profile_id).toBe("new");
    expect(result.total_profiles).toBe(2);
    expect(result.total_samples).toBe(1);
    expect(result.stacks).toEqual([{ frames: ["{main}", "edit_post"], value: 14 }]);
  });
});
