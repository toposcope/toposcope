/**
 * The sign-in page (#102, 26o; people since #305, frames 30c and 32a): an email and a password,
 * the instance it signs in to, readable without signing in. With no Owner yet it says how to make
 * one on the host. Served by the server with no script.
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
  /** The email typed, kept after a miss. */
  email?: string;
  /** Seconds to wait after too many misses (slow down, never lock). */
  waitSeconds?: number;
  /** No Owner yet (32a left): nobody can sign in until one is made on the host. */
  noOwner?: boolean;
};

/** A path on this instance, or "/": never another host. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return "/";
  }
  return raw;
}

const shellStyle = `<style>
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

  .col { width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: 18px; }
  .cap { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #8a8a93; text-transform: uppercase; letter-spacing: .06em; }
  .lead { margin: 0; font-size: 14px; line-height: 1.55; color: #a1a1aa; }
  pre { margin: 0; padding: 12px 14px; border: 1px solid #27272a; border-radius: 8px; background: #09090b; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; color: #d4d4d8; white-space: pre-wrap; overflow-wrap: anywhere; }
  .steps { display: flex; gap: 16px; }
  .step { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: #8a8a93; }
  .step i { font-style: normal; width: 22px; height: 22px; border-radius: 50%; border: 1px solid #3f3f46; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
  .step.on { color: #fafafa; } .step.on i { border-color: #e7e1d3; color: #e7e1d3; }
  .fixed { height: 40px; padding: 0 12px; border-radius: 8px; border: 1px solid #2a2a2e; background: #141416; display: flex; align-items: center; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #d4d4d8; }
  .error.wait { color: #fbbf24; }
</style>`;

export function signInPageHtml(page: SignInPage): string {
  const label = page.name ?? page.address;
  const addr = `${esc(page.address)}${page.version ? ` · ${esc(page.version)}` : ""}`;
  const heading = page.name
    ? `<h1>${esc(page.name)}</h1><div class="addr">${addr}</div>`
    : `<h1>${esc(page.address)}</h1><div class="note">This instance has no name yet. Give it one in Settings after signing in, so it can be told from another.</div>`;
  const banner = page.signedOut
    ? `<div class="banner" role="status"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg><span>Signed out of ${esc(label)} on this browser.</span></div>`
    : "";
  const alertIcon = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5"></path><path d="M12 16.5h.01"></path></svg>`;
  const error = page.waitSeconds
    ? `<div id="pw-error" class="error wait" role="alert">${alertIcon}<span>Too many misses. Try again in ${page.waitSeconds} seconds; each miss waits a little longer, and the account is never locked.</span></div>`
    : page.wrong
      ? `<div id="pw-error" class="error" role="alert">${alertIcon}<span>That email and password do not sign in to ${esc(label)}.</span></div>`
      : "";
  if (page.noOwner) {
    return pageShell(`Sign in · ${esc(label)}`, `<div class="col">
  <div class="cap">No Owner yet</div>
  <div class="brand">${mark}<span>toposcope</span></div>
  <div class="who"><div class="to">This instance has no Owner yet</div><h1>${esc(label)}</h1>${page.name ? `<div class="addr">${addr}</div>` : ""}</div>
  <p class="lead">Nobody can sign in until someone with access to the host makes the first Owner. Run this where Toposcope runs; it prints a link that works once, for an hour.</p>
  <pre>./toposcope.sh owner-link you@example.com</pre>
  <div class="stay">Collectors keep sending while you do this: ingest does not need an Owner.</div>
</div>`);
  }
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

  .col { width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: 18px; }
  .cap { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #8a8a93; text-transform: uppercase; letter-spacing: .06em; }
  .lead { margin: 0; font-size: 14px; line-height: 1.55; color: #a1a1aa; }
  pre { margin: 0; padding: 12px 14px; border: 1px solid #27272a; border-radius: 8px; background: #09090b; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; color: #d4d4d8; white-space: pre-wrap; overflow-wrap: anywhere; }
  .steps { display: flex; gap: 16px; }
  .step { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: #8a8a93; }
  .step i { font-style: normal; width: 22px; height: 22px; border-radius: 50%; border: 1px solid #3f3f46; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
  .step.on { color: #fafafa; } .step.on i { border-color: #e7e1d3; color: #e7e1d3; }
  .fixed { height: 40px; padding: 0 12px; border-radius: 8px; border: 1px solid #2a2a2e; background: #141416; display: flex; align-items: center; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #d4d4d8; }
  .error.wait { color: #fbbf24; }
</style>
</head>
<body>
<main>
<form method="post" action="/api/sign-in">
  <div class="brand">${mark}<span>toposcope</span></div>
  ${banner}
  <div class="who"><div class="to">Signing in to</div>${heading}</div>
  <div class="pw">
    <label for="em">Email</label>
    <input id="em" name="email" type="email" autocomplete="username" required value="${esc(page.email ?? "")}"${page.email ? "" : " autofocus"}>
    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password"${page.email ? " autofocus" : ""} required${page.wrong || page.waitSeconds ? ' aria-invalid="true" aria-describedby="pw-error"' : ""}>
    ${error}
    <input type="hidden" name="next" value="${esc(safeNext(page.next))}">
    <button type="submit">Sign in</button>
  </div>
  <div class="stay">Stays signed in on this browser for 30 days.</div>
</form>
<div class="foot">forgot it? an Owner resets it, or <a href="https://github.com/toposcope/toposcope/blob/main/docs/people.md#locked-out">owner-link on the host</a></div>
</main>
</body>
</html>
`;
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="${icon}">
${shellStyle}
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

export type OwnerSetupPage = {
  name: string | null;
  address: string;
  token: string;
  /** The email the link was made for, or null when the link is used or expired. */
  email: string | null;
  /** The link resets an existing Owner rather than making the first one. */
  resets: boolean;
  minutesLeft: number;
  error?: string;
  typedName?: string;
};

/** 32a right: make the first Owner (or reset one) from the link `owner-link` printed on the host. */
export function ownerSetupPageHtml(page: OwnerSetupPage): string {
  const label = page.name ?? page.address;
  if (!page.email) {
    return pageShell(`Setup link · ${esc(label)}`, `<div class="col">
  <div class="brand">${mark}<span>toposcope</span></div>
  <div class="who"><div class="to">This link no longer works for</div><h1>${esc(label)}</h1></div>
  <p class="lead">It has been used, or it is more than an hour old. Run this on the host again for a new one.</p>
  <pre>./toposcope.sh owner-link you@example.com</pre>
</div>`);
  }
  const error = page.error ? `<div id="pw-error" class="error" role="alert"><span>${esc(page.error)}</span></div>` : "";
  return pageShell(`Setup link · ${esc(label)}`, `<form class="col" method="post" action="/api/setup">
  <div class="cap">From the setup link</div>
  <div class="brand">${mark}<span>toposcope</span></div>
  <div class="who"><div class="to">${page.resets ? "A new password for an Owner of" : "Make the first Owner of"}</div><h1>${esc(label)}</h1></div>
  <div class="steps"><span class="step on"><i>1</i>You</span><span class="step"><i>2</i>Two-step</span><span class="step"><i>3</i>Backup codes</span></div>
  <div class="pw">
    <span class="to">Email</span>
    <div class="fixed">${esc(page.email)}</div>
    ${page.resets ? "" : `<label for="nm">Your name</label>
    <input id="nm" name="name" autocomplete="name" required value="${esc(page.typedName ?? "")}" autofocus>`}
    <label for="pw">Password · 12 characters or more</label>
    <input id="pw" name="password" type="password" autocomplete="new-password" minlength="12" required${page.resets ? " autofocus" : ""}${page.error ? ' aria-invalid="true" aria-describedby="pw-error"' : ""}>
    ${error}
    <input type="hidden" name="token" value="${esc(page.token)}">
    <button type="submit">Continue</button>
  </div>
  <div class="stay">The link dies when you finish or in ${page.minutesLeft} minute${page.minutesLeft === 1 ? "" : "s"}.</div>
</form>`);
}

export type JoinPage = {
  name: string | null;
  address: string;
  token: string;
  /** The invite the link holds, or null when it is used, cancelled or expired. */
  invite: { who: string; role: string; inviter: string | null; daysLeft: number } | null;
  error?: string;
  typedName?: string;
  typedEmail?: string;
};

const roleSentence: Record<string, string> = {
  viewer: "you can read everything and save your own hunts.",
  operator: "you can read everything, and make monitors, notes and shared hunts.",
  owner: "you can do everything, including letting people in.",
};

/** 30c right: joining from an invite link, with the inviter, the instance and the role said first. */
export function joinPageHtml(page: JoinPage): string {
  const label = page.name ?? page.address;
  if (!page.invite) {
    return pageShell(`Invite · ${esc(label)}`, `<div class="col">
  <div class="brand">${mark}<span>toposcope</span></div>
  <div class="who"><div class="to">This invite no longer works for</div><h1>${esc(label)}</h1></div>
  <p class="lead">It has been used, cancelled, or has expired. Ask whoever invited you for a new one.</p>
</div>`);
  }
  const invite = page.invite;
  const byEmail = /@/.test(invite.who);
  const roleName = invite.role.charAt(0).toUpperCase() + invite.role.slice(1);
  const error = page.error ? `<div id="pw-error" class="error" role="alert"><span>${esc(page.error)}</span></div>` : "";
  return pageShell(`Invite · ${esc(label)}`, `<form class="col" method="post" action="/api/join">
  <div class="cap">From an invite link</div>
  <div class="brand">${mark}<span>toposcope</span></div>
  <div class="who"><div class="to">${invite.inviter ? `${esc(invite.inviter)} invited you to` : "You are invited to"}</div><h1>${esc(label)}</h1><div class="to">as ${roleName === "Operator" || roleName === "Owner" ? "an" : "a"} <b style="color:#fafafa;font-weight:500">${esc(roleName)}</b>: ${roleSentence[invite.role] ?? ""}</div></div>
  <div class="pw">
    ${byEmail ? `<span class="to">Email</span><div class="fixed">${esc(invite.who)}</div>` : `<label for="em">Your email</label>
    <input id="em" name="email" type="email" autocomplete="username" required value="${esc(page.typedEmail ?? "")}">`}
    <label for="nm">Your name</label>
    <input id="nm" name="name" autocomplete="name" required value="${esc(page.typedName ?? (byEmail ? "" : invite.who))}" autofocus>
    <label for="np">Password · 12 characters or more</label>
    <input id="np" name="password" type="password" autocomplete="new-password" minlength="12" required${page.error ? ' aria-invalid="true" aria-describedby="pw-error"' : ""}>
    ${error}
    <input type="hidden" name="token" value="${esc(page.token)}">
    <button type="submit">Join ${esc(label)}</button>
  </div>
  <div class="stay">The link works once and expires in ${invite.daysLeft} day${invite.daysLeft === 1 ? "" : "s"}.</div>
</form>`);
}
