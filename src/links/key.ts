/**
 * A link key (#136): one long line the reachable side mints and the other pastes. Its prefix
 * says the direction before anything else is read: `tsl1_o` an offer (rows leave the minter),
 * `tsl1_i` an invite (rows arrive at the minter). Then the minter's name and address, a short
 * id, the filter, when it stops working (`-` for a single-use key), and the secret.
 */
export type LinkKeyKind = "offer" | "invite";

export type LinkKey = {
  kind: LinkKeyKind;
  name: string;
  url: string;
  kid: string;
  q: string;
  /** Epoch ms after which the key does not work; null for a single-use key. */
  until: number | null;
  secret: string;
};

export const linkKeyNotAKey = "Not a link key.";
/** A reusable key works this long at most. */
export const linkKeyMaxDays = 30;

function b64u(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function unb64u(text: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    return null;
  }
  return Buffer.from(text, "base64url").toString("utf8");
}

/** A pasted key minted before 0.10. */
export const linkKeyOlder = "This key is from an older Toposcope; mint a new one there";

export function encodeLinkKey(key: LinkKey): string {
  return [
    key.kind === "offer" ? "tsl2_o" : "tsl2_i",
    b64u(key.name),
    b64u(key.url),
    key.kid,
    b64u(key.q),
    key.until === null ? "-" : String(key.until),
    key.secret,
  ].join(".");
}

export function decodeLinkKey(text: string): LinkKey | { error: string } {
  // A key from before 0.10 (#328): its rows would not fit this release's tables.
  if (text.trim().startsWith("tsl1_")) {
    return { error: linkKeyOlder };
  }
  const parts = text.trim().split(".");
  if (parts.length !== 7) {
    return { error: linkKeyNotAKey };
  }
  const [prefix, name, url, kid, q, until, secret] = parts as [string, string, string, string, string, string, string];
  const kind = prefix === "tsl2_o" ? "offer" : prefix === "tsl2_i" ? "invite" : null;
  const decodedName = unb64u(name);
  const decodedUrl = unb64u(url);
  const decodedQ = unb64u(q);
  const untilMs = until === "-" ? null : Number(until);
  if (
    !kind ||
    !decodedName ||
    !decodedUrl ||
    decodedQ === null ||
    !/^k[0-9a-f]{4}$/.test(kid) ||
    (untilMs !== null && !Number.isSafeInteger(untilMs)) ||
    !/^[A-Za-z0-9_-]{32,}$/.test(secret)
  ) {
    return { error: linkKeyNotAKey };
  }
  try {
    const parsed = new URL(decodedUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: linkKeyNotAKey };
    }
  } catch {
    return { error: linkKeyNotAKey };
  }
  return { kind, name: decodedName, url: decodedUrl, kid, q: decodedQ, until: untilMs, secret };
}

export function newKid(): string {
  return `k${Buffer.from(crypto.getRandomValues(new Uint8Array(2))).toString("hex")}`;
}

export function newSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export function hashSecret(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}

/** What the list shows for a key: `k-7f3a`. */
export function kidLabel(kid: string): string {
  return `k-${kid.slice(1)}`;
}
