# Query language

This page is the reference for what you type in the search bar: words, `key:value` fields, operators, wildcards, numbers and quoting. It is for anyone writing a query by hand or in a script. What the hunt screen does with a query (the chart, panels, Live, the page URL) is in [Hunting](hunt.md).

A query is text. The server turns it into filters; the UI never sends SQL. The same query works in the bar, in a saved hunt, in a panel and as `q=` on the API.

## Examples

| Query | What it matches |
| --- | --- |
| `level:error` | Rows whose level is `error` |
| `service:api timeout` | Rows from `api` whose message has the word `timeout` |
| `level:error service:api timeout` | Errors from `api` with the word `timeout` |
| `level:error OR level:fatal service:api` | Every `error` row, plus `fatal` rows from `api` (AND binds first) |
| `(level:error OR level:fatal) service:api` | `error` or `fatal` rows, both from `api` |
| `status:5*` | Rows whose `status` attribute starts with `5` |
| `status:>=500` | Rows whose `status` is a number of 500 or more |
| `"connection reset"` | Messages with the word `connection` followed by `reset` |
| `path:"/v1/items"` | Rows whose `path` attribute is exactly `/v1/items` |
| `host:api-1` | Rows from host `api-1` |
| `user_id:42` | Rows whose `user_id` attribute is the text `42` |
| `duration_ms:84` | Rows whose `duration_ms` attribute is the text `84` |
| `duration_ms:>100` | Rows whose `duration_ms` is a number above 100 |
| `duration_ms:>100 duration_ms:<500` | Rows whose `duration_ms` is between 100 and 500, both excluded |
| `version:v0.9` | Rows whose `version` attribute is `v0.9` |
| `customer:acme` | Rows whose `customer` attribute is `acme` |
| `flag:new-checkout` | Rows whose `flag` attribute is `new-checkout` |
| `http.status_code:500` | Rows whose `http.status_code` attribute is `500` |

## Words

A bare word searches the message. It matches a whole word, ignoring case: the message is lowercased and split at every character that is not a letter or a digit, and the word must be one of the pieces.

- `timeout` matches `connection timeout` but not `timeouts`.
- `"connection reset"` matches the two words next to each other, in that order.
- `"or"`, `"and"` and `"not"` in quotes search for those words instead of acting as operators.
- A word made only of punctuation matches nothing.

## Fields

`key:value` matches a field exactly. The key is case-insensitive.

| Key | What it matches |
| --- | --- |
| `level`, `service`, `host` | The row's own level, service and host |
| `toposcope` | The instance the row entered at: this one, or the source a [link](links.md) pulled it from |
| Any other key | An attribute of that name, such as `path`, `status`, `user_id` or `http.status_code` |

An attribute key starts with a letter or `_` and goes on with letters, digits, `_` and `.`. `ts`, `message` and `tenant_id` are not attribute keys. A word with a colon whose key does not fit, such as `foo-bar:x`, is searched as message text.

Attribute values are stored as text, so `duration_ms:84` is a match on the text `84`, and `user_id:42` does not match `042`. Exception fingerprints are the attribute `e1`; hunt with `e1:<hex>` like any other. An OpenTelemetry `service.version` is stored as `version`. What makes an attribute appear is in [Ingest](ingest.md#attributes). A key you derive (an alias, a combined or bucketed value, a local lookup) is only searchable once the collector writes it as an attribute of its own; rows sent straight to Toposcope do not grow it. See [Enrich at the collector](collectors.md#enrich-at-the-collector).

## Combining

| You write | It means |
| --- | --- |
| `a b` (a space) | Both |
| `a and b` | Both, same as a space |
| `a or b` | Either |
| `not a` or `-a` | Not `a` |
| `( … )` | Group |

`and`, `or` and `not` are operators in any case (`OR`, `Or`). AND, written or implied by a space, binds tighter than OR: `level:error OR level:fatal service:api` is `level:error OR (level:fatal service:api)`. Use parentheses to say otherwise.

Repeating a key with a space between ANDs the values, so `level:error level:fatal` matches nothing: a row has one level. Use `(level:error OR level:fatal)` for either.

## Wildcards

Only a trailing `*` on a field value is a wildcard: `status:5*` matches values that start with `5`. A `*` anywhere else is a mistake the bar refuses: `*foo`, `status:5*0`, and a `*` at the end of a bare word.

## Numbers

`>`, `>=`, `<` and `<=` compare an attribute as a number: `duration_ms:>100`, `status:>=500`. Two comparisons on one key make a range: `duration_ms:>100 duration_ms:<500`.

- The number is a plain decimal: `100`, `0.5`, `-1`. `1e3` is not.
- A comparison is true only when the attribute is a number and the comparison holds. Rows where it is missing or not a number never match.
- `not` and `-` turn that round: `-duration_ms:>100` matches rows at 100 or below, and rows with no number at all.
- Only attributes compare. `level:>error` is a mistake, and so is a comparison on `service`, `host` or `toposcope`.
- Without an operator a value is text: `duration_ms:84` is the text `84`.

## Quoting

Double quotes make a value or a phrase literal.

| Query | Why quote |
| --- | --- |
| `path:"/v1/items"` | The value has characters that would otherwise split it |
| `"connection reset"` | A phrase: the words next to each other |
| `duration_ms:">100"` | The text `>100`, not a comparison |
| `"not"` | The word, not the operator |

A quoted value is never a wildcard: `status:"5*"` is the text `5*`.

## Mistakes the bar refuses

A query with a mistake is not run. The bar marks it after you press Enter, with the position and what is wrong; typing again clears the marks. Through the API the answer is `400` with `{ error, faults }`.

| Mistake | Example | What the bar says |
| --- | --- | --- |
| A field with no value | `level:` | `level: has no value` |
| A `(` or `)` without its pair | `(level:error`, `level:error)` | `unmatched (`, `unmatched )` |
| A `(` with nothing after it | `level:error (` | `expected term after (` |
| A quote that is not closed | `"connection reset` | `unterminated phrase` |
| An operator with nothing after it | `level:error or`, `level:error and`, `not` | `expected term after or` (or `and`, `not`) |
| An operator with nothing before it | `or level:error` | `expected term before or` |
| A `*` that is not at the end of a value | `*foo`, `status:5*0` | `only a trailing * is supported` |
| A comparison on `level`, `service`, `host` or `toposcope` | `level:>error` | `level: comparisons are for attrs` |
| A comparison with nothing after it | `duration_ms:>` | `duration_ms: comparison needs a number` |
| A comparison on something other than a plain decimal | `duration_ms:>fast`, `size:>1e3` | `not a finite decimal` |
| A comparison and a wildcard together | `status:>5*` | `cannot mix comparison and glob` |
| Anything else the bar cannot read | | `unexpected token` |

While Live is on, a query with a mistake is skipped and the hunt keeps showing the last results that worked.

The bar has no regular expressions, no `*` inside a value, no `100..500` ranges, no `1e3` numbers, and no Lucene or SQL syntax. Nothing in the URL is passed through as SQL.

## Time window

A query is always read over a window. `range=` picks a window that ends now:

| Value | Window |
| --- | --- |
| `15m`, `1h`, `4h`, `24h`, `7d` | The quick choices |
| A number and a unit: `ms`, `s`, `m`, `h`, `d`, `w` | Any length, such as `90m`, `30d`, `2w` |

`1ms` is a millisecond and `1m` a minute. `1w` is 7 days. A window is at most 730 days. A custom window sets **From** and **To** (`from=` and `to=` in the URL); it too is at most 730 days, and a longer one keeps **To** and moves **From** up. When `range=` is given it wins over `from` and `to`. More on the window and Live is in [Hunting](hunt.md#the-window-and-live).

## Limits

- A query reads the window you set, up to 730 days.
- Some queries read every matching row rather than a per-minute summary: a message word, a comparison, two or more attribute keys, an attribute under `not`, a mix such as `level:error OR status:500`, and a bar narrower than a minute. Over a long or busy window such a read can be too large. The chart then refuses and says so, rather than drawing part of the window.
- An attribute value longer than 64 characters, a JSON value, a UUID-like id, or a key whose role is lookup or ignore still matches, but is read from the rows, not a summary, so the same limit applies.
