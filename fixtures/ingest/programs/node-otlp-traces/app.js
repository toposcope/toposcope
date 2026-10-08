"use strict";

const { trace, SpanStatusCode } = require("@opentelemetry/api");
const pino = require("pino");

const logger = pino();

function charge(order) {
  return { receipt: order.card.token };
}

trace.getTracer("billing").startActiveSpan("POST /pay", (span) => {
  try {
    charge({});
  } catch (err) {
    // What a tracing library does with an error it sees, and the usual way to log one.
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    logger.error({ err }, "charge failed");
  } finally {
    span.end();
  }
});

// Leave the batch processors time to export before the process ends.
setTimeout(() => {}, 2000);
