"use strict";

// A small service that serves SERVED requests and counts its own work, so the
// exporter has one of each kind to send: the HTTP instrumentation's
// request-duration histogram, a counter, an up-down counter and a gauge.
const http = require("node:http");
const { metrics } = require("@opentelemetry/api");

const SERVED = Number(process.env.SERVED ?? 20);
const meter = metrics.getMeter("billing");
const jobs = meter.createCounter("app.jobs.processed");
const inFlight = meter.createUpDownCounter("app.requests.in_flight");
meter
  .createObservableGauge("app.memory.heap_used", { unit: "By" })
  .addCallback((result) => result.observe(process.memoryUsage().heapUsed));

const server = http.createServer((req, res) => {
  inFlight.add(1);
  jobs.add(1, { queue: "charges" });
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
  inFlight.add(-1);
});

server.listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  for (let i = 0; i < SERVED; i++) {
    await new Promise((resolve) =>
      http.get(`http://127.0.0.1:${port}/pay`, (res) => res.resume().on("end", resolve)),
    );
  }
  // Two export intervals, so everything served is on the wire before the process ends.
  setTimeout(() => server.close(), Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 1000) * 2 + 500);
});
