"use strict";

// Stands in for Toposcope: saves the raw OTLP log request an exporter sends.
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");

let protocol = "";
let posts = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/v1/logs") {
      posts += 1;
      const ext = protocol === "http/json" ? "json" : "bin";
      fs.writeFileSync(`/out/otlp-node.logs.${ext}`, Buffer.concat(chunks));
      fs.writeFileSync(
        `/out/otlp-node.logs.${ext}.headers`,
        JSON.stringify({
          "content-type": req.headers["content-type"],
          "content-encoding": req.headers["content-encoding"] ?? null,
          "user-agent": req.headers["user-agent"] ?? null,
          posts,
        }),
      );
    }
    res.writeHead(200, { "content-type": req.headers["content-type"] ?? "application/json" });
    res.end(protocol === "http/json" ? "{}" : "");
  });
});

server.listen(4318, "127.0.0.1", async () => {
  for (protocol of ["http/protobuf", "http/json"]) {
    posts = 0;
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
