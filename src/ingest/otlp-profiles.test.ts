import { describe, expect, test } from "bun:test";
import { mapOtlpProfiles, toOtlpProfilesJson, type ProfileDraft } from "./otlp-profiles";
import {
  decodeOtlpProfilesProtobuf,
  encodeOtlpProfilesProtobuf,
} from "./otlp-profiles-protobuf";

const draft: ProfileDraft = {
  service: "wordpress",
  ts: "2026-08-16T14:59:51.408Z",
  duration_ms: 10_000,
  profile_id: "aa".repeat(16),
  samples: [
    {
      frames: ["{main}", "edit_post", "do_action(save_post)"],
      value: 47_000_000,
      trace_id: "aabbccddeeff00112233445566778899",
      span_id: "99aabbccddeeff00",
    },
    {
      frames: ["{main}", "wp_mail"],
      value: 12_000_000,
    },
  ],
};

describe("mapOtlpProfiles", () => {
  test("maps one Profile to sample rows and keeps unlinked samples", () => {
    const mapped = mapOtlpProfiles(toOtlpProfilesJson([draft]));
    expect(mapped.profileCount).toBe(1);
    expect(mapped.samples).toHaveLength(2);
    expect(mapped.samples[0]?.service).toBe("wordpress");
    expect(mapped.samples[0]?.frames).toEqual([
      "{main}",
      "edit_post",
      "do_action(save_post)",
    ]);
    expect(mapped.samples[0]?.trace_id).toBe("aabbccddeeff00112233445566778899");
    expect(mapped.samples[0]?.span_id).toBe("99aabbccddeeff00");
    expect(mapped.samples[0]?.value).toBe(47_000_000);
    expect(mapped.samples[1]?.trace_id).toBe("");
    expect(mapped.samples[1]?.span_id).toBe("");
    expect(mapped.samples[0]?.sample_type).toBe("cpu");
    expect(mapped.samples[0]?.sample_unit).toBe("nanoseconds");
  });

  test("counts two Profiles without merging them", () => {
    const mapped = mapOtlpProfiles(
      toOtlpProfilesJson([
        draft,
        { ...draft, profile_id: "bb".repeat(16), ts: "2026-08-16T15:00:01.000Z" },
      ]),
    );
    expect(mapped.profileCount).toBe(2);
    expect(new Set(mapped.samples.map((row) => row.profile_id)).size).toBe(2);
  });

  test("rejects missing resourceProfiles", () => {
    expect(() => mapOtlpProfiles({})).toThrow("resourceProfiles is required");
  });
});

describe("OTLP profiles protobuf", () => {
  test("round-trips through the JSON mapper", () => {
    const payload = toOtlpProfilesJson([draft]);
    const decoded = decodeOtlpProfilesProtobuf(encodeOtlpProfilesProtobuf(payload));
    const mapped = mapOtlpProfiles(decoded);
    expect(mapped.profileCount).toBe(1);
    expect(mapped.samples[0]?.frames).toEqual(draft.samples[0]?.frames);
    expect(mapped.samples[0]?.span_id).toBe("99aabbccddeeff00");
    expect(mapped.samples[1]?.span_id).toBe("");
  });
});
