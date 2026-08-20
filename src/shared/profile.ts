export const PROFILE_STACK_CAP = 500;

export type ProfileSample = {
  profile_id: string;
  service: string;
  ts: string;
  duration_ms: number;
  sample_type: string;
  sample_unit: string;
  period_type: string;
  period_unit: string;
  trace_id: string;
  span_id: string;
  frames: string[];
  value: number;
};

export type ProfileStack = {
  frames: string[];
  value: number;
};

export type ProfileResponse = {
  profile_id: string;
  service: string;
  ts: string;
  duration_ms: number;
  sample_type: string;
  sample_unit: string;
  stacks: ProfileStack[];
  total_samples: number;
  total_profiles: number;
};

export const emptyProfileResponse: ProfileResponse = {
  profile_id: "",
  service: "",
  ts: "",
  duration_ms: 0,
  sample_type: "",
  sample_unit: "",
  stacks: [],
  total_samples: 0,
  total_profiles: 0,
};

export function stackKey(frames: string[]): string {
  return frames.join("\0");
}

export function foldStacks(samples: ProfileSample[]): ProfileStack[] {
  const byKey = new Map<string, ProfileStack>();
  for (const sample of samples) {
    if (sample.frames.length === 0) {
      continue;
    }
    const key = stackKey(sample.frames);
    const prev = byKey.get(key);
    if (prev) {
      prev.value += sample.value;
    } else {
      byKey.set(key, { frames: sample.frames.slice(), value: sample.value });
    }
  }
  return [...byKey.values()];
}

export function pickLatestProfile(
  samples: ProfileSample[],
): { profileId: string; totalProfiles: number } | null {
  const groups = new Map<string, { ts: string; n: number }>();
  for (const sample of samples) {
    const prev = groups.get(sample.profile_id);
    if (!prev) {
      groups.set(sample.profile_id, { ts: sample.ts, n: 1 });
      continue;
    }
    prev.n += 1;
    if (sample.ts > prev.ts) {
      prev.ts = sample.ts;
    }
  }
  if (groups.size === 0) {
    return null;
  }
  const ranked = [...groups.entries()].sort((a, b) => {
    if (a[1].ts !== b[1].ts) {
      return a[1].ts < b[1].ts ? 1 : -1;
    }
    return b[1].n - a[1].n;
  });
  const first = ranked[0];
  if (!first) {
    return null;
  }
  return { profileId: first[0], totalProfiles: groups.size };
}

export function capHeaviestStacks(
  stacks: ProfileStack[],
  cap = PROFILE_STACK_CAP,
): { stacks: ProfileStack[]; total: number } {
  const total = stacks.length;
  if (total <= cap) {
    return { stacks, total };
  }
  return {
    stacks: stacks.slice().sort((a, b) => b.value - a.value).slice(0, cap),
    total,
  };
}

export function buildProfileResponse(samples: ProfileSample[]): ProfileResponse {
  const picked = pickLatestProfile(samples);
  if (!picked) {
    return emptyProfileResponse;
  }
  const chosen = samples.filter((sample) => sample.profile_id === picked.profileId);
  const first = chosen[0];
  if (!first) {
    return emptyProfileResponse;
  }
  const folded = foldStacks(chosen);
  const capped = capHeaviestStacks(folded);
  return {
    profile_id: first.profile_id,
    service: first.service,
    ts: first.ts,
    duration_ms: first.duration_ms,
    sample_type: first.sample_type,
    sample_unit: first.sample_unit,
    stacks: capped.stacks,
    total_samples: folded.length,
    total_profiles: picked.totalProfiles,
  };
}
