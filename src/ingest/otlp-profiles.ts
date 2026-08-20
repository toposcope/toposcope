import { otlpIdHex } from "../shared/ids";
import type { ProfileSample } from "../shared/profile";

type Attr = {
  key?: string;
  value?: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
  };
};

export type ProfileDraft = {
  service: string;
  ts: string;
  duration_ms: number;
  sample_type?: string;
  sample_unit?: string;
  period_type?: string;
  period_unit?: string;
  profile_id?: string;
  samples: Array<{
    frames: string[];
    value: number;
    trace_id?: string;
    span_id?: string;
  }>;
};

export type MappedProfiles = {
  samples: ProfileSample[];
  profileCount: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function intAt(value: unknown): number {
  return Math.trunc(num(value));
}

function strAt(table: string[], index: unknown): string {
  const i = intAt(index);
  if (i <= 0 || i >= table.length) {
    return "";
  }
  return table[i] ?? "";
}

function attrString(attrs: Attr[] | undefined, key: string): string | undefined {
  if (!attrs) {
    return undefined;
  }
  for (const attr of attrs) {
    if (attr.key !== key || !attr.value) {
      continue;
    }
    if (typeof attr.value.stringValue === "string" && attr.value.stringValue.length > 0) {
      return attr.value.stringValue;
    }
  }
  return undefined;
}

function tsFromNano(nano: unknown): string | undefined {
  const n = num(nano);
  if (n <= 0) {
    return undefined;
  }
  return new Date(n / 1_000_000).toISOString();
}

function newProfileId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

function stringTable(dict: Record<string, unknown> | undefined): string[] {
  const raw = list(dict?.stringTable ?? dict?.string_table);
  const out: string[] = [];
  for (const item of raw) {
    out.push(typeof item === "string" ? item : "");
  }
  if (out.length === 0 || out[0] !== "") {
    out.unshift("");
  }
  return out;
}

function functionName(
  dict: Record<string, unknown> | undefined,
  strings: string[],
  functionIndex: number,
): string {
  const functions = list(dict?.functionTable ?? dict?.function_table);
  const fn = asRecord(functions[functionIndex]);
  if (!fn) {
    return "";
  }
  return (
    strAt(strings, fn.nameStrindex ?? fn.name_strindex) ||
    strAt(strings, fn.systemNameStrindex ?? fn.system_name_strindex) ||
    strAt(strings, fn.filenameStrindex ?? fn.filename_strindex)
  );
}

function locationFrames(
  dict: Record<string, unknown> | undefined,
  strings: string[],
  locationIndex: number,
): string[] {
  const locations = list(dict?.locationTable ?? dict?.location_table);
  const loc = asRecord(locations[locationIndex]);
  if (!loc) {
    return [];
  }
  const lines = list(loc.lines);
  if (lines.length === 0) {
    const mappings = list(dict?.mappingTable ?? dict?.mapping_table);
    const mapping = asRecord(mappings[intAt(loc.mappingIndex ?? loc.mapping_index)]);
    const file = mapping
      ? strAt(strings, mapping.filenameStrindex ?? mapping.filename_strindex)
      : "";
    return file ? [file] : [];
  }
  const names: string[] = [];
  for (const line of lines) {
    const rec = asRecord(line);
    if (!rec) {
      continue;
    }
    const name = functionName(dict, strings, intAt(rec.functionIndex ?? rec.function_index));
    if (name) {
      names.push(name);
    }
  }
  return names;
}

function stackFrames(
  dict: Record<string, unknown> | undefined,
  strings: string[],
  stackIndex: number,
): string[] {
  const stacks = list(dict?.stackTable ?? dict?.stack_table);
  const stack = asRecord(stacks[stackIndex]);
  if (!stack) {
    return [];
  }
  const leafFirst: string[] = [];
  for (const loc of list(stack.locationIndices ?? stack.location_indices)) {
    leafFirst.push(...locationFrames(dict, strings, intAt(loc)));
  }
  const rootFirst = leafFirst.slice().reverse();
  return rootFirst.length > 0 ? rootFirst : ["unknown"];
}

function sampleValue(row: Record<string, unknown>): number {
  const values = list(row.values);
  if (values.length > 0) {
    return values.reduce<number>((sum, item) => sum + num(item), 0);
  }
  const stamps = list(row.timestampsUnixNano ?? row.timestamps_unix_nano);
  return stamps.length;
}

function linkIds(
  dict: Record<string, unknown> | undefined,
  linkIndex: number,
): { trace_id: string; span_id: string } {
  if (linkIndex <= 0) {
    return { trace_id: "", span_id: "" };
  }
  const links = list(dict?.linkTable ?? dict?.link_table);
  const link = asRecord(links[linkIndex]);
  if (!link) {
    return { trace_id: "", span_id: "" };
  }
  return {
    trace_id: otlpIdHex(link.traceId ?? link.trace_id) ?? "",
    span_id: otlpIdHex(link.spanId ?? link.span_id) ?? "",
  };
}

function valueTypeName(
  raw: unknown,
  strings: string[],
): { type: string; unit: string } {
  const rec = asRecord(raw);
  if (!rec) {
    return { type: "", unit: "" };
  }
  return {
    type: strAt(strings, rec.typeStrindex ?? rec.type_strindex),
    unit: strAt(strings, rec.unitStrindex ?? rec.unit_strindex),
  };
}

export function mapOtlpProfiles(payload: unknown): MappedProfiles {
  if (!payload || typeof payload !== "object") {
    throw new Error("Expected an OTLP profiles object");
  }
  const root = payload as Record<string, unknown>;
  const resourceProfiles = root.resourceProfiles ?? root.resource_profiles;
  if (!Array.isArray(resourceProfiles)) {
    throw new Error("resourceProfiles is required");
  }
  const dict = asRecord(root.dictionary);
  const strings = stringTable(dict);
  const samples: ProfileSample[] = [];
  let profileCount = 0;
  for (const rp of resourceProfiles) {
    const resourceBlock = asRecord(rp);
    if (!resourceBlock) {
      continue;
    }
    const resource = asRecord(resourceBlock.resource);
    const service =
      attrString(resource?.attributes as Attr[] | undefined, "service.name") ?? "otlp";
    for (const sp of list(resourceBlock.scopeProfiles ?? resourceBlock.scope_profiles)) {
      const scope = asRecord(sp);
      if (!scope) {
        continue;
      }
      for (const rec of list(scope.profiles)) {
        const row = asRecord(rec);
        if (!row) {
          continue;
        }
        profileCount += 1;
        const sampleType = valueTypeName(row.sampleType ?? row.sample_type, strings);
        const periodType = valueTypeName(row.periodType ?? row.period_type, strings);
        const profileId = otlpIdHex(row.profileId ?? row.profile_id) ?? newProfileId();
        const ts = tsFromNano(row.timeUnixNano ?? row.time_unix_nano) ?? new Date().toISOString();
        const durationMs = num(row.durationNano ?? row.duration_nano) / 1_000_000;
        for (const sampleRec of list(row.samples)) {
          const sample = asRecord(sampleRec);
          if (!sample) {
            continue;
          }
          const link = linkIds(dict, intAt(sample.linkIndex ?? sample.link_index));
          samples.push({
            profile_id: profileId,
            service,
            ts,
            duration_ms: durationMs,
            sample_type: sampleType.type || "cpu",
            sample_unit: sampleType.unit || "nanoseconds",
            period_type: periodType.type,
            period_unit: periodType.unit,
            trace_id: link.trace_id,
            span_id: link.span_id,
            frames: stackFrames(dict, strings, intAt(sample.stackIndex ?? sample.stack_index)),
            value: sampleValue(sample),
          });
        }
      }
    }
  }
  return { samples, profileCount };
}

function intern(table: string[], value: string): number {
  const at = table.indexOf(value);
  if (at >= 0) {
    return at;
  }
  table.push(value);
  return table.length - 1;
}

function hexOrId(value: string | undefined, bytes: number): string {
  if (value && /^[0-9a-fA-F]+$/.test(value) && value.length === bytes * 2) {
    return value.toLowerCase();
  }
  return newProfileId().slice(0, bytes * 2);
}

/** Inverse of `mapOtlpProfiles` for load/e2e clients. Frames are root-first. */
export function toOtlpProfilesJson(profiles: ProfileDraft[]): object {
  const stringTable = [""];
  const functionTable: Array<{ nameStrindex: number }> = [{ nameStrindex: 0 }];
  const locationTable: Array<{ lines: Array<{ functionIndex: number }> }> = [{ lines: [] }];
  const stackTable: Array<{ locationIndices: number[] }> = [{ locationIndices: [] }];
  const linkTable: Array<{ traceId: string; spanId: string }> = [
    { traceId: "0".repeat(32), spanId: "0".repeat(16) },
  ];
  const fnIndex = new Map<string, number>();

  function functionIndex(name: string): number {
    const prev = fnIndex.get(name);
    if (prev !== undefined) {
      return prev;
    }
    const i = functionTable.length;
    functionTable.push({ nameStrindex: intern(stringTable, name) });
    locationTable.push({ lines: [{ functionIndex: i }] });
    fnIndex.set(name, i);
    return i;
  }

  const resourceProfiles = profiles.map((profile) => {
    const typeIdx = intern(stringTable, profile.sample_type ?? "cpu");
    const unitIdx = intern(stringTable, profile.sample_unit ?? "nanoseconds");
    const periodTypeIdx = intern(stringTable, profile.period_type ?? profile.sample_type ?? "cpu");
    const periodUnitIdx = intern(
      stringTable,
      profile.period_unit ?? profile.sample_unit ?? "nanoseconds",
    );
    const startMs = Date.parse(profile.ts);
    const samples = profile.samples.map((sample) => {
      const leafFirst = sample.frames.slice().reverse();
      const locationIndices = leafFirst.map((name) => functionIndex(name));
      const stackIndex = stackTable.length;
      stackTable.push({ locationIndices });
      let linkIndex = 0;
      if (sample.trace_id && sample.span_id) {
        linkIndex = linkTable.length;
        linkTable.push({
          traceId: hexOrId(sample.trace_id, 16),
          spanId: hexOrId(sample.span_id, 8),
        });
      }
      return {
        stackIndex,
        linkIndex,
        values: [sample.value],
      };
    });
    return {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: profile.service } }],
      },
      scopeProfiles: [
        {
          profiles: [
            {
              sampleType: { typeStrindex: typeIdx, unitStrindex: unitIdx },
              periodType: { typeStrindex: periodTypeIdx, unitStrindex: periodUnitIdx },
              timeUnixNano: `${BigInt(Number.isFinite(startMs) ? startMs : Date.now()) * 1_000_000n}`,
              durationNano: `${BigInt(Math.round(profile.duration_ms * 1_000_000))}`,
              profileId: hexOrId(profile.profile_id, 16),
              samples,
            },
          ],
        },
      ],
    };
  });
  return {
    resourceProfiles,
    dictionary: {
      stringTable,
      functionTable,
      locationTable,
      stackTable,
      linkTable,
      mappingTable: [{}],
      attributeTable: [{}],
    },
  };
}
