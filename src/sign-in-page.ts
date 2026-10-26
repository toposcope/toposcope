/**
 * The sign-in page (#102, frames 12a–12d and 12g): one password field, the instance it signs
 * in to, readable without the password. Served by the server with no script, so it works in a
 * browser that does not show the Basic prompt.
 */

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const mark =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2.6 5 H16.8 L14 10.4 H4.8 Z"></path><path fill="currentColor" d="M7.2 13.6 H21.4 L18.6 19 H9.4 Z"></path></svg>';

const icon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='4' fill='%231b1b1e'/%3E%3Cpath fill='%23e6e1d7' d='M2.6 5 H16.8 L14 10.4 H4.8 Z'/%3E%3Cpath fill='%23e6e1d7' d='M7.2 13.6 H21.4 L18.6 19 H9.4 Z'/%3E%3C/svg%3E";

export type SignInPage = {
  /** The instance's name, or null while it has none. */
  name: string | null;
  /** The address the browser opened, as its Host: `logs.agental.dev`, `127.0.0.1:18080`. */
  address: string;
  /** Where to go after signing in: a path on this instance. */
  next: string;
  wrong?: boolean;
  signedOut?: boolean;
  /** The release running (#270, 26o): beside the address, so two instances read apart. */
  version?: string;
};

/** A path on this instance, or "/": never another host. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return "/";
  }
  return raw;
}

export function signInPageHtml(page: SignInPage): string {
  const label = page.name ?? page.address;
  const addr = `${esc(page.address)}${page.version ? ` · ${esc(page.version)}` : ""}`;
  const heading = page.name
    ? `<h1>${esc(page.name)}</h1><div class="addr">${addr}</div>`
    : `<h1>${esc(page.address)}</h1><div class="note">This instance has no name yet. Give it one in Settings after signing in, so it can be told from another.</div>`;
  const banner = page.signedOut
    ? `<div class="banner" role="status"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg><span>Signed out of ${esc(label)} on this browser.</span></div>`
    : "";
  const error = page.wrong
    ? `<div id="pw-error" class="error" role="alert"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5"></path><path d="M12 16.5h.01"></path></svg><span>That is not the password for ${esc(label)}.</span></div>`
    : "";
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · ${esc(label)}</title>
<link rel="icon" href="${icon}">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #0d0d0f; color: #fafafa; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px; -webkit-font-smoothing: antialiased; }
  main { min-height: 100vh; padding: 48px 16px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  form { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 18px; }
  .brand { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; letter-spacing: -0.015em; }
  .brand svg { color: #e7e1d3; }
  .who { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .who .to { font-size: 12.5px; color: #8a8a93; }
  /* The instance's name is the biggest thing on the page (26o), so two instances are never confused. */
  h1 { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 30px; line-height: 36px; font-weight: 500; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  .mono, .addr, input { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .addr { font-size: 12.5px; color: #8a8a93; overflow-wrap: anywhere; }
  .note, .stay { font-size: 12px; line-height: 18px; color: #a1a1aa; }
  .pw { display: flex; flex-direction: column; gap: 8px; }
  label { font-size: 12.5px; color: #a1a1aa; }
  input { height: 40px; padding: 0 12px; border-radius: 8px; border: 1px solid #2a2a2e; background: #141416; color: #fafafa; font-size: 13px; outline: none; }
  input:focus { border-color: rgba(255,255,255,0.35); }
  input[aria-invalid="true"] { border-color: #f87171; }
  button { height: 40px; border-radius: 8px; border: 0; background: #e7e1d3; color: #0d0d0f; font-size: 13.5px; font-weight: 500; cursor: pointer; }
  button:hover { background: #f3efe6; }
  .foot { position: fixed; bottom: 20px; left: 0; right: 0; text-align: center; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #8a8a93; }
  .foot a { color: #a1a1aa; text-decoration: none; }
  .foot a:hover { color: #fff; }
  .error { display: flex; gap: 6px; align-items: flex-start; font-size: 12.5px; line-height: 18px; color: #fca5a5; }
  .error svg, .banner svg { flex: none; margin-top: 2px; }
  .banner { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: 6.4px; background: #18181b; border: 1px solid rgba(255,255,255,0.08); font-size: 12.5px; line-height: 18px; color: #e4e4e7; }
  .banner svg { color: #a1a1aa; }
  @media (max-width: 480px) {
    main { justify-content: flex-start; padding: 96px 16px 32px; }
    form { max-width: none; }
    h1 { font-size: 24px; line-height: 30px; }
    input, button { height: 44px; }
    input { font-size: 16px; }
    button { font-size: 14px; }
  }
</style>
</head>
<body>
<main>
<form method="post" action="/api/sign-in">
  <div class="brand">${mark}<span>toposcope</span></div>
  ${banner}
  <div class="who"><div class="to">Signing in to</div>${heading}</div>
  <div class="pw">
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required${page.wrong ? ' aria-invalid="true" aria-describedby="pw-error"' : ""}>
    ${error}
    <input type="hidden" name="next" value="${esc(safeNext(page.next))}">
    <button type="submit">Sign in</button>
  </div>
  <div class="stay">Stays signed in on this browser for 30 days.</div>
</form>
<div class="foot">the operator password from .env · <a href="https://github.com/toposcope/toposcope/blob/main/docs/operations.md#sign-in">forgot it?</a></div>
</main>
</body>
</html>
`;
}
