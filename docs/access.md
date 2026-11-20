# What leaves this instance

This page is for whoever runs a Toposcope instance: each way data or a call can leave it, and where to see and stop each one.

Toposcope is self-hosted, and everything it stores stays on the host unless one of the ways below lets it out. **Access** in the app lists each of them under People, Tokens, Links and Shares, one row each. A row gives its kind in plain words, what it does, its scope, when it expires, when it was last used, and today's use and refusals. This page says the same in prose.

## People

Each person signs in as themselves, with a role: Viewer, Operator or Owner ([People and roles](people.md)). There is no shared password.

- Access lists them under **People**, with how they sign in, whether two-step is on, when they were last seen and who invited them. An Owner invites, changes roles and revokes there.
- A personal token acts as its person, and a service account's as its role; both are listed with the tokens.
- An agent is a service account made for a coding agent, in **Let someone in › Agent** or with `./toposcope.sh agent <name>`. It is listed under **Agents**, with its role (Viewer or Operator, never Owner), its last call, what it saved, and Revoke ([Agents](people.md#agents)).

## Tokens

An app, a collector or a hub sends logs, metrics, traces, profiles, marks and check results with a bearer token. The token is one of:

- one made in **Access › Make a token** or **Let someone in › Token**;
- `env (imported)`, the `.env` token 0.9 took in once.

A token writes; it reads nothing out. Each is revoked in its row.

## Links

A link lets another Toposcope pull **raw rows** that match one filter, ids included, and keep its place. The other operator sees everything the filter lets through, of every kind the link carries. See [Links](links.md) for running links.

### Make a link key

1. Click **Make a link key** on the Links group, or open **Access › Let someone in › Link** (the same step).
2. Choose whether you offer rows or invite the other side's, and set the filter (see [Make a link](links.md#make-a-link)).
3. Tick the kinds the link carries. Each kind is a box on the key, and all are ticked by default.
4. Copy the key. It is shown once, and listed as *key not used yet* until the other side pastes it.
5. Once pasted, the link reads *we copy from* or *copies from us*. Access names each link's and key's kinds.

### What each kind sends

The side rows leave from decides what goes. The filter applies to each kind by the fields it has. A kind that lacks a field the filter names sends none of its rows, and the box and the link's page say so.

| Kind | What goes |
| --- | --- |
| Logs | The rows the filter matches. |
| Change marks | Every mark whose `service` the filter does not rule out. Other terms, such as `level:error` or words, do not apply to marks. |
| Traces | The spans the filter matches. |
| Metrics | The points the filter matches. |
| Profiles | They go with their spans; a profile with no span goes by `service` alone. |
| Monitors | By service and host, with their definitions and recent stretches; they show read-only at the other side. A filter naming any key but service, host and `toposcope` sends none. |

A field a kind may lack is, for example, `level` or words in the message.

**Change scope** on the link's page can untick a kind but never add one: to send another kind, make a new key.

### A link's page

Each link has a page with which way rows move, its scope, a line per kind with where it stands and its rows and bytes a day, **Pause** and **Revoke**.

Rows pulled into this instance follow its retention. They leave again through any link that copies from us, under the name of the instance they entered at.

## Shares

A share lets an app or a web page read **counts and series** within a fence. It never gives a log line, an event, a trace, a profile or a fingerprint, and never an id through a split or a narrowing the share does not list.

- A share holds named panels; the fence is derived from them. A page names one with `data-panel=`.
- With raw params off, a page can only name a panel and move its window.
- A share expires within a year and is revoked in its row.

See [shares](shares.md).

## What Toposcope itself calls out to

Toposcope makes these calls of its own:

- The release check (daily, off with `TOPOSCOPE_UPDATE_CHECK=off`): it reads GitHub's public list of releases; nothing about the instance is sent.
- Webhooks: a monitor calls its own URL or the default webhook in Settings with the monitor's name, its value and the saved search's query.
- `TOPOSCOPE_WATCHDOG_URL`, when set: a check-in after each monitor pass.
- HTTP(S), TCP and certificate monitors call the targets they check.

[Operations](operations.md#what-toposcope-calls-out-to) lists these with their settings.

## Use is a series

Every way in writes the same log rows, `service:toposcope access:<name> kind:token|link|share status:used|refused`:

- one row a minute per way in that was used;
- one row per refusal, with why.

They hold no addresses of the people or machines that called. Search them like any rows, and watch them: a monitor on `service:toposcope status:refused` pages when someone asks for more than they are allowed.
