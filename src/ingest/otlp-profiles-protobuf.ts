import protobuf from "protobufjs";

/** Pinned OTLP profiles v1development ExportProfilesServiceRequest (field numbers only). */
const proto = `
syntax = "proto3";
package otlp;

message ExportProfilesServiceRequest {
  repeated ResourceProfiles resource_profiles = 1;
  ProfilesDictionary dictionary = 2;
}

message ResourceProfiles {
  Resource resource = 1;
  repeated ScopeProfiles scope_profiles = 2;
}

message Resource {
  repeated KeyValue attributes = 1;
}

message ScopeProfiles {
  repeated Profile profiles = 2;
}

message Profile {
  ValueType sample_type = 1;
  repeated Sample samples = 2;
  fixed64 time_unix_nano = 3;
  uint64 duration_nano = 4;
  ValueType period_type = 5;
  bytes profile_id = 7;
}

message Sample {
  int32 stack_index = 1;
  int32 link_index = 3;
  repeated int64 values = 4;
  repeated fixed64 timestamps_unix_nano = 5;
}

message ValueType {
  int32 type_strindex = 1;
  int32 unit_strindex = 2;
}

message ProfilesDictionary {
  repeated Mapping mapping_table = 1;
  repeated Location location_table = 2;
  repeated Function function_table = 3;
  repeated Link link_table = 4;
  repeated string string_table = 5;
  repeated Stack stack_table = 7;
}

message Mapping {
  int32 filename_strindex = 4;
}

message Location {
  int32 mapping_index = 1;
  repeated Line lines = 3;
}

message Line {
  int32 function_index = 1;
}

message Function {
  int32 name_strindex = 1;
  int32 system_name_strindex = 2;
  int32 filename_strindex = 3;
}

message Stack {
  repeated int32 location_indices = 1;
}

message Link {
  bytes trace_id = 1;
  bytes span_id = 2;
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
}

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    bytes bytes_value = 7;
  }
}
`;

let exportType: protobuf.Type | undefined;

function profilesExportType(): protobuf.Type {
  if (!exportType) {
    const parsed = protobuf.parse(proto);
    exportType = parsed.root.lookupType("otlp.ExportProfilesServiceRequest");
  }
  return exportType;
}

export function decodeOtlpProfilesProtobuf(buf: Uint8Array): unknown {
  const type = profilesExportType();
  return type.toObject(type.decode(new Uint8Array(buf)), {
    longs: String,
    enums: Number,
    bytes: String,
    defaults: false,
    arrays: true,
    objects: true,
    oneofs: true,
  });
}

function hexToBytes(value: unknown, size: number): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }
  if (new RegExp(`^[0-9a-fA-F]{${size * 2}}$`).test(value)) {
    return Buffer.from(value, "hex");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function withByteIds(payload: object): object {
  const root = payload as Record<string, unknown>;
  const dict = asRecord(root.dictionary);
  const links = dict ? list(dict.linkTable ?? dict.link_table) : [];
  const groups = root.resourceProfiles ?? root.resource_profiles;
  return {
    ...root,
    resourceProfiles: list(groups).map((rp) => {
      const block = asRecord(rp);
      if (!block) {
        return rp;
      }
      return {
        ...block,
        scopeProfiles: list(block.scopeProfiles ?? block.scope_profiles).map((sp) => {
          const scope = asRecord(sp);
          if (!scope) {
            return sp;
          }
          return {
            ...scope,
            profiles: list(scope.profiles).map((profile) => {
              const row = asRecord(profile);
              if (!row) {
                return profile;
              }
              return {
                ...row,
                profileId: hexToBytes(row.profileId ?? row.profile_id, 16),
              };
            }),
          };
        }),
      };
    }),
    dictionary: dict
      ? {
          ...dict,
          linkTable: links.map((link) => {
            const row = asRecord(link);
            if (!row) {
              return link;
            }
            return {
              ...row,
              traceId: hexToBytes(row.traceId ?? row.trace_id, 16),
              spanId: hexToBytes(row.spanId ?? row.span_id, 8),
            };
          }),
        }
      : undefined,
  };
}

export function encodeOtlpProfilesProtobuf(payload: object): Uint8Array {
  const type = profilesExportType();
  return type.encode(type.fromObject(withByteIds(payload))).finish();
}
