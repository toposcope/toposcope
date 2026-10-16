type Env = Record<string, string | undefined>;

/**
 * The address operators open Toposcope at, as `TOPOSCOPE_PUBLIC_URL` says it
 * (`https://logs.example.com`, or with a path behind a proxy). Toposcope cannot
 * learn it from a request: an alert is sent from a timer, and behind a proxy or
 * a tunnel the address it listens on is not the one people open. Null when it
 * is unset or not an http or https address.
 */
export function publicUrl(env: Env = process.env): string | null {
  const raw = (env.TOPOSCOPE_PUBLIC_URL ?? "").trim();
  if (raw.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.search || url.hash) {
    return null;
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Why `TOPOSCOPE_PUBLIC_URL` cannot be used, or null when it is unset or fine. */
export function publicUrlError(env: Env = process.env): string | null {
  const raw = (env.TOPOSCOPE_PUBLIC_URL ?? "").trim();
  if (raw.length === 0 || publicUrl(env) !== null) {
    return null;
  }
  return "TOPOSCOPE_PUBLIC_URL must be the http or https address Toposcope is opened at, with no query or #fragment";
}

export function requirePublicUrl(): void {
  const error = publicUrlError();
  if (error) {
    console.error(error);
    process.exit(1);
  }
}
