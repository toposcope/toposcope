"use strict";

// Stands in for Toposcope: saves the largest OTLP metrics request an exporter
// sends in each run. A run is one protocol with or without the delta setting.
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");

const runs = [
  { file: "otlp-node.metrics.bin", protocol: "http/protobuf", delta: true },
  { file: "otlp-node.metrics.json", protocol: "http/json", delta: true },
  // A stock setup: no temporality setting, so counters and histograms are running totals.
  { file: "otlp-node.metrics.stock.json", protocol: "http/json", delta: false },
];
let run = runs[0];
let largest = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.method === "POST" && req.url === "/v1/metrics" && body.length > largest) {
      largest = body.length;
      fs.writeFileSync(`/out/${run.file}`, body);
      fs.writeFileSync(
        `/out/${run.file}.headers`,
        JSON.stringify({
          "content-type": req.headers["content-type"],
          "content-encoding": req.headers["content-encoding"] ?? null,
          "user-agent": req.headers["user-agent"] ?? null,
        }),
      );
    }
    res.writeHead(200, { "content-type": req.headers["content-type"] ?? "application/json" });
    res.end(run.protocol === "http/json" ? "{}" : "");
  });
});

server.listen(4318, "127.0.0.1", async () => {
  for (run of runs) {
    largest = 0;
    await new Promise((resolve) =>
      spawn(
        process.execPath,
        ["--require", "@opentelemetry/auto-instrumentations-node/register", "app.js"],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            OTEL_EXPORTER_OTLP_PROTOCOL: run.protocol,
            ...(run.delta ? { OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta" } : {}),
          },
        },
      ).on("exit", resolve),
    );
  }
  server.close();
});
