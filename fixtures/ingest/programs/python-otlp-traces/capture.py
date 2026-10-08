"""Stands in for Toposcope: saves the raw OTLP trace request an exporter sends
for a span that recorded an exception, and the log request of the same run."""

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

names = {"/v1/traces": "traces", "/v1/logs": "traces.logs"}
posts = {path: 0 for path in names}


class Capture(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        if self.path in names:
            posts[self.path] += 1
            with open(f"/out/otlp-python.{names[self.path]}.bin", "wb") as out:
                out.write(body)
            with open(f"/out/otlp-python.{names[self.path]}.bin.headers", "w") as out:
                json.dump(
                    {
                        "content-type": self.headers.get("content-type"),
                        "content-encoding": self.headers.get("content-encoding"),
                        "user-agent": self.headers.get("user-agent"),
                        "posts": posts[self.path],
                    },
                    out,
                )
        self.send_response(200)
        self.send_header("content-type", self.headers.get("content-type") or "application/json")
        self.end_headers()
        self.wfile.write(b"")

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 4318), Capture)
threading.Thread(target=server.serve_forever, daemon=True).start()

# The Python exporter refuses http/json, so there is one run.
result = subprocess.run(
    ["opentelemetry-instrument", sys.executable, "app.py"],
    env={**os.environ, "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf"},
    capture_output=True,
    text=True,
)
with open("/out/otlp-python.traces.log", "w") as out:
    out.write(f"exit {result.returncode}, posts {posts}\n{result.stdout}\n{result.stderr}")

server.shutdown()
