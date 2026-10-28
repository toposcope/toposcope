import type { Context } from "hono";

/** The address the browser opened: what the sign-in page and the tab title name when unnamed. */
export function openedAddress(c: Context): string {
  return (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").split(",")[0]!.trim() || "toposcope";
}

export function overHttps(c: Context): boolean {
  return c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https" || c.req.url.startsWith("https:");
}

/** Where the provider sends a browser back after sign-in (#310). */
export function redirectUri(c: Context): string {
  const env = process.env.TOPOSCOPE_PUBLIC_URL?.replace(/\/+$/, "");
  return `${env ?? `${overHttps(c) ? "https" : "http"}://${openedAddress(c)}`}/auth/callback`;
}
