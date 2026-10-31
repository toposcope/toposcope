# People and roles

Toposcope has people, not a shared password. Each person signs in as themselves, with one of three fixed roles, and every write records who made it. Machines that send logs keep ingest tokens; scripts use a personal token or a service account's, and a coding agent an [agent](#agents)'s.

## The first Owner

A new instance, or one upgraded from 0.8, has no Owner, and nobody can sign in until someone with access to the host makes one. Run this where Toposcope runs, beside its `compose.yml`:

```bash
./toposcope.sh owner-link you@example.com
```

It prints a link that works once, for an hour. It is printed there and nowhere else: not in the app's log and not on disk. Open it, choose your name and a password of 12 characters or more, then set up two-step and keep the ten backup codes. Collectors keep sending meanwhile: ingest does not need an Owner.

## Locked out

The same command, for an Owner's email, is the way back in. The link gives that Owner a new password and a new second step, and ends their sessions. With no Owner left at all, run it with a new email to make one. Reaching the host is the proof.

## Roles

| May do | Viewer | Operator | Owner |
| --- | :-: | :-: | :-: |
| Read Home, Hunt, Watch, traces, profiles | ✓ | ✓ | ✓ |
| Save their own hunts, pin them | ✓ | ✓ | ✓ |
| Export rows | ✓ | ✓ | ✓ |
| Write notes on the clock | — | ✓ | ✓ |
| Make and change monitors, webhooks | — | ✓ | ✓ |
| Change Fields roles and metric links | — | ✓ | ✓ |
| Add panels to an existing share | — | ✓ | ✓ |
| Invite people, change roles | — | — | ✓ |
| Make or revoke tokens, links, shares | — | — | ✓ |
| Retention, sign-in, instance settings | — | — | ✓ |

The server enforces this on every route; a refusal is `403` with a sentence that says who may. A Viewer's saved hunts are theirs alone; an Operator's are shared, on everyone's Home. Pins are each person's own. A Viewer sees no Access or Settings.

## Inviting someone

**Access › People › Invite someone** takes an email or a name, a role, and how long the link works (1, 7 or 30 days). The link is shown once; send it however you like, since Toposcope sends no mail. It appears under People as *invite not used yet* until it is used, and can be cancelled there. The person opens it, sees who invited them and as what, and sets a name and a password, or continues with the provider.

An Owner changes a role in the person's row, and revokes a person there. Revoking ends their sessions and tokens on their next request; what they made stays, under their name. The last Owner stays an Owner.

## Two-step sign-in

Everyone who signs in with a password sets up a second step: any authenticator app (TOTP), plus ten backup codes, each good once. **Settings › Sign-in and roles** can relax this to Owners only. Misses slow down, up to 30 seconds a try, and never lock an account. New backup codes come from the header's menu, and end the old ten. For a lost phone and lost codes, an Owner resets that person's two-step in their People row; they set it up again at their next sign-in.

After the code, **Remember this browser** lets that browser skip it for 1, 7, 14 or 30 days; the password is still asked. The cookie holds a random token, named per instance, HttpOnly and SameSite=Strict (Secure over HTTPS), and the server keeps only its hash. Your menu › Remembered browsers lists them and forgets one or all; an Owner forgets someone's from their People row. Resetting two-step, a new password and revoking a person forget them all. Settings caps the days, 30 by default; lowering the cap shortens browsers already remembered, and never forgets them all.

## Sign in with a provider

**Settings › Sign-in and roles** takes one OIDC provider: Google Workspace, Microsoft Entra, Okta, Keycloak, Authentik, or any other. Register an app there with the redirect URL the page shows, `https://<your address>/auth/callback`, then enter the issuer, client id and client secret, an allowed domain (or none), and what happens to someone with no invite: they join as a Viewer, as an Operator, or are refused.

| Provider | Issuer |
| --- | --- |
| Google Workspace | `https://accounts.google.com` |
| Microsoft Entra | `https://login.microsoftonline.com/<tenant id>/v2.0` |
| Okta | `https://<org>.okta.com` |
| Keycloak | `https://<host>/realms/<realm>` |
| Authentik | `https://<host>/application/o/<application slug>/` |

The sign-in page then leads with **Continue with <provider>**. Toposcope asks for a verified email, matches a person by the provider's id or their email, and does not ask the provider's people for a second step: the provider's own applies. Passwords can then be turned off, once every Owner has signed in with the provider. Set `TOPOSCOPE_PUBLIC_URL` when Toposcope sits behind a proxy, so the redirect URL is the address people open.

## Tokens

| | Ingest token | Personal token | Service account |
| --- | --- | --- | --- |
| For | a machine that sends | your own scripts | a script that is not a person |
| May | write in only: `/v1/*`, `/api/ingest`, `/ping/<key>` | `/api/*` as your role, or read only | `/api/*` as its role |
| Made in | Access › Make a token · Sending logs in | Access › Make a token · Me | Access › Make a token · A service account |
| Ends | revoked | revoked, or with you | revoked, or the account revoked |

Every token is shown once. A script sends it as `Authorization: Bearer …`; HTTP Basic is not accepted. A service account cannot sign in, holds only tokens, and shows under its own name wherever it writes. On the host, `./toposcope.sh service-token <account> <viewer|operator|owner>` makes a service account's token without a browser.

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" http://127.0.0.1:8080/api/saved-searches
```

## Agents

An agent is a service account made for a coding agent, such as Claude Code: it is named `agent: <name>`, is a Viewer or an Operator and never an Owner, and holds tokens like any service account. What it saves (monitors, saved hunts, Home panels) wears a small **✦ agent: <name>** badge wherever its maker shows: in Watch, on Home and in its saved hunts. An Operator agent may do what the table above lets an Operator do: search, trace and compare around a deploy, make monitors, add panels to Home, set Fields roles, and write notes on the clock. It may never invite people, change roles, make tokens, links or shares, or change retention or sign-in.

**Access › Let someone in › Agent** takes a name and a role (Operator ticked), and on **Make the agent** shows its token once, inside the setup for Claude Code:

```bash
claude mcp add --transport http toposcope https://<your address>/mcp \
  --header "Authorization: Bearer <its token>"
```

with tabs for any other MCP client (the same address and header, as JSON) and for the host. Making an agent of a name that exists, in the same role, gives it another token, and says its earlier tokens still work; in another role it is refused.

On the host, beside `compose.yml`:

```bash
./toposcope.sh agent claude
```

makes the Operator `agent: claude`, or keeps the one there is, makes a new token for it, and writes the token to `agent-claude.token` beside `.env`, a file only you can read. It prints that file's path and a `claude mcp add` line that reads the token from the file; it never prints the token. It will not write through a link or onto anything but a plain file, and a token it made but could not write it revokes. Each run adds a token, and the earlier ones work until they are revoked.

Access lists agents in a group of their own, with their role, their tokens and last call, and what each saved. **Revoke** there ends its tokens on the next call; what it saved stays, under its name, for a person to keep or delete. Its tokens expire as any token does, within a year; revoke is the way to stop one sooner.

## Upgrading from 0.8

1. Upgrade as usual. Every browser is signed out.
2. Run `./toposcope.sh owner-link <email>` on the host (`upgrade.sh` says so at the end), open the link within the hour, and make the first Owner with an authenticator app. Everything made before 0.9 becomes theirs; saved hunts stay shared.
3. Delete `TOPOSCOPE_PASSWORD` from `.env`; it is ignored.
4. Collectors need nothing: `TOPOSCOPE_INGEST_TOKEN` is imported once as the ingest token `env (imported)` and keeps working, and made ingest tokens are unchanged. The `.env` line is not read again and may be deleted once nothing else on the host reads it.
5. Give every script that used `-u :$TOPOSCOPE_PASSWORD` a personal token, or a service account's if it is not a person's.
6. Invite the others.

To go back to 0.8.0, put `TOPOSCOPE_PASSWORD` back in `.env`; 0.8.0 ignores the new tables, and people cannot sign in there.
