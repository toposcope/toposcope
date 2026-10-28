# What leaves this instance

Toposcope is self-hosted, and everything it stores stays on the host unless one of the ways below lets it out. **Access** in the app lists each of them under People, Tokens, Links and Shares, one row each, with its kind in plain words, what it does, its scope, when it expires, when it was last used, and today's use and refusals. This page says the same in prose.

## People

Each person signs in as themselves, with a role: Viewer, Operator or Owner ([People and roles](people.md)). Access lists them under **People**, with how they sign in, whether two-step is on, when they were last seen and who invited them; an Owner invites, changes roles and revokes there. A personal token acts as its person, and a service account's as its role; both are listed with the tokens. An agent, a service account made for a coding agent in **Let someone in › Agent** or with `./toposcope.sh agent <name>`, is listed under **Agents**, with its role (Viewer or Operator, never Owner), its last call, what it saved, and Revoke ([Agents](people.md#agents)). There is no shared password.

## Tokens

An app, a collector or a hub sends logs, metrics, traces, profiles, marks and check results with a bearer token: one made in **Access › Make a token** or **Let someone in › Token**, or `env (imported)`, the `.env` token 0.9 took in once. A token writes; it reads nothing out. Each is revoked in its row.

## Links

A link lets another Toposcope pull **raw rows** that match one filter, ids included, and keep its place. The other operator sees everything the filter lets through, of every kind the link carries: logs, change marks, traces, metrics, profiles and monitors, each a box on the key, all ticked by default. A key is minted with **Make a link key** on the Links group, or in **Access › Let someone in › Link** (the same step), shown once, and listed as *key not used yet* until the other side pastes it; a link then reads *we copy from* or *copies from us*. Access names each link's and key's kinds.

The side rows leave from decides what goes. The filter applies to each kind by the fields it has: a kind that lacks a field the filter names (`level`, words in the message, or for monitors any key but service, host and `toposcope`) sends none of its rows, and the box and the link's page say so. Profiles go with their spans; monitors go by service and host, with their definitions and recent stretches, and show read-only at the other side. **Change scope** on the link's page can untick a kind but never add one: to send another kind, make a new key.

Each link has a page: which way rows move, its scope, a line per kind with where it stands and its rows and bytes a day, **Pause** and **Revoke**. Rows pulled into this instance follow its retention, and leave again through any link that copies from us, under the name of the instance they entered at. See [operations](operations.md#links).

## Shares

A share lets an app or a web page read **counts and series** within a fence: never a log line, an event, a trace, a profile or a fingerprint, and never an id through a split or a narrowing the share does not list. A share holds named panels; the fence is derived from them; a page names one with `data-panel=`. With raw params off, a page can only name a panel and move its window. A share expires within a year and is revoked in its row. See [shares](shares.md).

## What Toposcope itself calls out to

- The release check (daily, off with `TOPOSCOPE_UPDATE_CHECK=off`): it reads GitHub's public list of releases; nothing about the instance is sent.
- Webhooks: a monitor calls its own URL or the default webhook in Settings with the monitor's name, its value and the saved search's query.
- `TOPOSCOPE_WATCHDOG_URL`, when set: a check-in after each monitor pass.
- HTTP(S), TCP and certificate monitors call the targets they check.

[Operations](operations.md#what-toposcope-calls-out-to) lists these with their settings.

## Use is a series

Every way in writes the same rows into `logs`, `service:toposcope access:<name> kind:token|link|share status:used|refused`: one row a minute per way in that was used, and one row per refusal with why. No addresses of the people or machines that called. Search them like any rows, and watch them: a monitor on `service:toposcope status:refused` pages when someone asks for more than they are allowed.
