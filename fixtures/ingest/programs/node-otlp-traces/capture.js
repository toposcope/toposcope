"use strict";

// Stands in for Toposcope: saves the raw OTLP trace request an exporter sends
// for a span that recorded an exception, and the log request of the same run.
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");

let protocol = "";
const posts = { "/v1/traces": 0, "/v1/logs": 0 };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    if (req.method === "POST" && req.url in posts) {
      posts[req.url] += 1;
      const ext = protocol === "http/json" ? "json" : "bin";
      const name = req.url === "/v1/traces" ? "traces" : "traces.logs";
      fs.writeFileSync(`/out/otlp-node.${name}.${ext}`, Buffer.concat(chunks));
      fs.writeFileSync(
        `/out/otlp-node.${name}.${ext}.headers`,
        JSON.stringify({
          "content-type": req.headers["content-type"],
          "content-encoding": req.headers["content-encoding"] ?? null,
          "user-agent": req.headers["user-agent"] ?? null,
          posts: posts[req.url],
        }),
      );
    }
    res.writeHead(200, { "content-type": req.headers["content-type"] ?? "application/json" });
    res.end(protocol === "http/json" ? "{}" : "");
  });
});

server.listen(4318, "127.0.0.1", async () => {
  for (protocol of ["http/protobuf", "http/json"]) {
    posts["/v1/traces"] = 0;
    posts["/v1/logs"] = 0;
    await new Promise((resolve) =>
      spawn(
        process.execPath,
        ["--require", "@opentelemetry/auto-instrumentations-node/register", "app.js"],
        { stdio: "inherit", env: { ...process.env, OTEL_EXPORTER_OTLP_PROTOCOL: protocol } },
      ).on("exit", resolve),
    );
  }
  server.close();
});
