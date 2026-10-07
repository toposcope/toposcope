"""Stands in for Toposcope: saves the raw OTLP log request an exporter sends."""

import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

state = {"protocol": "", "posts": 0}


class Capture(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        if self.path == "/v1/logs":
            state["posts"] += 1
            ext = "json" if state["protocol"] == "http/json" else "bin"
            with open(f"/out/otlp-python.logs.{ext}", "wb") as out:
                out.write(body)
            with open(f"/out/otlp-python.logs.{ext}.headers", "w") as out:
                json.dump(
                    {
                        "content-type": self.headers.get("content-type"),
                        "content-encoding": self.headers.get("content-encoding"),
                        "user-agent": self.headers.get("user-agent"),
                        "posts": state["posts"],
                    },
                    out,
                )
        self.send_response(200)
        self.send_header("content-type", self.headers.get("content-type") or "application/json")
        self.end_headers()
        self.wfile.write(b"{}" if state["protocol"] == "http/json" else b"")

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 4318), Capture)
threading.Thread(target=server.serve_forever, daemon=True).start()

for protocol in ("http/protobuf", "http/json"):
    state["protocol"] = protocol
    state["posts"] = 0
    result = subprocess.run(
        ["opentelemetry-instrument", sys.executable, "app.py"],
        env={**os.environ, "OTEL_EXPORTER_OTLP_PROTOCOL": protocol},
        capture_output=True,
        text=True,
    )
    with open(f"/out/otlp-python.{protocol.replace('/', '-')}.log", "w") as out:
        out.write(f"exit {result.returncode}, posts {state['posts']}\n{result.stdout}\n{result.stderr}")

server.shutdown()
