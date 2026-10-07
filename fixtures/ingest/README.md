# Ingest fixtures

Bytes captured from real runtimes and real OpenTelemetry exporters on 2026-10-07. Tests read them. Nothing here is a dependency of the app, the image, or CI. [`versions.json`](versions.json) says what each one came from, down to the image digest.

## Stacks

`stacks/<runtime>.<directory>.txt` is the stack one small program printed for one thrown error with a real framework above it, run from `/app` and again from `/usr/src/app`. `programs/<runtime>/` is that program. Each catches the error where an app would log it and writes the text the runtime gives: `err.stack`, `traceback.format_exception`, `printStackTrace`, `Exception.ToString()`, `(string) $e`, and `debug.Stack()` after `recover`.

## OTLP log requests

`otlp/<language>.logs.bin` and `.json` are the request bodies an exporter posted to `/v1/logs` for one exception logged inside a span, through the language’s usual logger and the zero-code setup: `--require @opentelemetry/auto-instrumentations-node/register` with pino, and `opentelemetry-instrument` with `logging`. `programs/<language>-otlp/` has the app and the small server that stood in for Toposcope.

The Python exporter refuses `http/json`, so Python has no JSON request.

## What the captures showed

- **PHP 8.4 and later** name a closure frame `{closure:/app/public/index.php:15}`. The path and the line are in the function name, so the same error gets a different `e1` in each deploy directory. The test for it is pinned as a known failure in `src/shared/real-stacks.test.ts`.
- **V8** prints ten frames unless the app raises `Error.stackTraceLimit`.
- **.NET** frames with no source information are not read: every framework frame, and every app frame when no PDB is deployed. In a Release build a one-line handler and the method it calls are inlined into `lambda_method1(Closure, Object, HttpContext)`, which has none. The program here awaits, as ASP.NET Core code usually does.
- **pino’s `err`** arrives as `exception.type`, `exception.message`, and `exception.stacktrace`.

## Capturing again

Run each program in the official image named in `versions.json`: copy it to `/app` and to `/usr/src/app`, install its dependencies there, and run it with `OUT` set to the file to write. For Node:

```bash
docker run --rm -v "$PWD/fixtures/ingest/programs/node":/src:ro -v "$PWD/out":/out node:24-slim sh -c '
  for dir in /app /usr/src/app; do
    mkdir -p "$dir" && cp -r /src/. "$dir"/ && cd "$dir" && npm install
    OUT="/out/node.$(echo "$dir" | sed "s#^/##; s#/#-#g").txt" node src/server.js
  done'
```

The others follow the same shape with `pip install -r requirements.txt` and `python app.py`; `mvn package` and `java -jar`; `dotnet publish -c Release` and `dotnet billing.dll`; `composer install` and `php public/index.php`; `go mod tidy`, `go build`, and the binary. The two OTLP programs run `node capture.js` and `python capture.py` with the exporter pointed at `http://127.0.0.1:4318`.

Replace a fixture whole. Do not edit one by hand: a capture that fails a test is a finding, not something to trim.
