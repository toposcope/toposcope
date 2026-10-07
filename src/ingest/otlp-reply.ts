import type { Context } from "hono";
import protobuf from "protobufjs";
import { maxAttrKeysPerEvent } from "../shared/attrs";
import { isOtlpProtobufContentType } from "./otlp-protobuf";

export type OtlpSignal = "logs" | "traces" | "profiles" | "metrics";

/** The JSON name of the rejected count; on the wire all four are field 1. */
const rejectedField: Record<OtlpSignal, string> = {
  logs: "rejectedLogRecords",
  traces: "rejectedSpans",
  profiles: "rejectedProfiles",
  metrics: "rejectedDataPoints",
};

const MAX_MESSAGE = 500;

/**
 * What a request lost: records that were not stored, and what was cut from the
 * ones that were. It becomes the OTLP partial-success field of the reply.
 */
export class Losses {
  private readonly rejected = new Map<string, number>();
  private readonly cut = new Map<string, number>();
  private readonly noted = new Map<string, number>();

  /** A record that was not stored. */
  reject(reason: string, count = 1): void {
    if (count > 0) {
      this.rejected.set(reason, (this.rejected.get(reason) ?? 0) + count);
    }
  }

  /** A record that was stored without something it was sent with. */
  trim(reason: string, count = 1): void {
    if (count > 0) {
      this.cut.set(reason, (this.cut.get(reason) ?? 0) + count);
    }
  }

  /** Something a sender should know that is neither a rejection nor a cut. */
  note(reason: string, count = 1): void {
    if (count > 0) {
      this.noted.set(reason, (this.noted.get(reason) ?? 0) + count);
    }
  }

  /** A row that was stored without some of the attributes it was sent with. */
  attrsCut(flat: { pastCap: number; badName: number }): void {
    if (flat.pastCap > 0) {
      this.trim(`attributes past the ${maxAttrKeysPerEvent}-attribute cap`);
    }
    if (flat.badName > 0) {
      this.trim("attributes under a name that cannot be stored");
    }
  }

  get rejectedCount(): number {
    let total = 0;
    for (const count of this.rejected.values()) {
      total += count;
    }
    return total;
  }

  /** One line, what was rejected first. Empty when nothing was lost. */
  message(): string {
    const parts = [
      ...[...this.rejected].map(([reason, count]) => `${reason}: ${count} rejected`),
      ...[...this.cut].map(([reason, count]) => `${reason}: cut on ${count}`),
      ...[...this.noted].map(([reason, count]) => `${reason}: ${count}`),
    ];
    const line = parts.join("; ");
    return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line;
  }
}

/** Export*ServiceResponse. The four signals differ only in the name of field 1. */
const proto = `
syntax = "proto3";
package otlp;

message ExportResponse {
  PartialSuccess partial_success = 1;
}

message PartialSuccess {
  int64 rejected = 1;
  string error_message = 2;
}
`;

let responseType: protobuf.Type | undefined;

function exportResponseType(): protobuf.Type {
  if (!responseType) {
    responseType = protobuf.parse(proto).root.lookupType("otlp.ExportResponse");
  }
  return responseType;
}

export function encodeOtlpReply(rejected: number, errorMessage: string): Uint8Array {
  const type = exportResponseType();
  return type
    .encode(type.fromObject({ partialSuccess: { rejected, errorMessage } }))
    .finish();
}

/** What a protobuf reply says was lost. A full success is an empty message. */
export function decodeOtlpReply(buf: Uint8Array): { rejected: number; errorMessage: string } {
  const type = exportResponseType();
  const decoded = type.toObject(type.decode(new Uint8Array(buf)), { longs: Number }) as {
    partialSuccess?: { rejected?: number; errorMessage?: string };
  };
  return {
    rejected: decoded.partialSuccess?.rejected ?? 0,
    errorMessage: decoded.partialSuccess?.errorMessage ?? "",
  };
}

/**
 * The 200 for an OTLP request, in the encoding the request came in. A JSON
 * reply keeps `ingested`; `partialSuccess` appears only when something was lost.
 */
export function otlpReply(
  c: Context,
  signal: OtlpSignal,
  ingested: number,
  losses: Losses,
): Response {
  const errorMessage = losses.message();
  if (isOtlpProtobufContentType(c.req.header("content-type"))) {
    const body = errorMessage
      ? Uint8Array.from(encodeOtlpReply(losses.rejectedCount, errorMessage))
      : new Uint8Array();
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-protobuf" },
    });
  }
  if (!errorMessage) {
    return c.json({ ingested });
  }
  return c.json({
    ingested,
    // int64 is a string in protobuf's JSON.
    partialSuccess: { [rejectedField[signal]]: String(losses.rejectedCount), errorMessage },
  });
}
