# MCP

An agent speaks MCP to Toposcope at `/mcp`, on the same address as the app. There is nothing to install and no second process: the server is the instance's own, always at its version.

It takes the same token as the [API](api.md): `Authorization: Bearer` with a personal or service account token from **Access**. Each tool stands for one API route and runs it with that token, so a tool may do what the token's role may do on that route and nothing more. A refusal is the route's own sentence. Calls are counted under the token in Access, as API calls are: its last use, and each refusal with why.

## Connect

Claude Code:

```sh
claude mcp add --transport http toposcope http://127.0.0.1:8080/mcp --header "Authorization: Bearer $TOPOSCOPE_TOKEN"
```

Any client that speaks Streamable HTTP takes the URL and the header:

```json
{ "mcpServers": { "toposcope": { "type": "http", "url": "http://127.0.0.1:8080/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

It works on any instance the token reaches, local or shared. To try it by hand, the MCP inspector lists the tools and calls them:

```sh
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8080/mcp --transport http --header "Authorization: Bearer $TOPOSCOPE_TOKEN" --method tools/list
```

## Tools

`tools/list` shows only the tools the token's role may call: a Viewer sees fewer than an Operator. Each tool's name is its route's id in [api.md](api.md), its description is the route's sentence, and its input is the route's: the path's params and the query's keys as arguments, and the JSON body, for a route that takes one, under `body`. A query value is text. The result is the route's JSON answer as text, with `isError` when the route did not answer 2xx.

Today's tools: `search`, `saved_searches`, `saved_search_run`, `saved_search_test`, `monitors`, `monitor_get`, `marks`, `attr_keys`, `attr_values` and `metric_names`.

## The protocol

MCP revision 2025-11-25 (2025-06-18 too, when the client asks for it), over Streamable HTTP, stateless. Each `POST /mcp` carries one JSON-RPC message: a request gets its answer as JSON in the reply, and a notification gets 202. There is no session, no server-sent stream, and `GET /mcp` is 405. It answers `initialize`, `ping`, `tools/list` and `tools/call`, and offers no resources, prompts, sampling or elicitation. A request from a page on another site (an `Origin` that is not this instance's) is refused.
