"use strict";

const { trace } = require("@opentelemetry/api");
const pino = require("pino");

const logger = pino();

function charge(order) {
  return { receipt: order.card.token };
}

trace.getTracer("billing").startActiveSpan("POST /pay", (span) => {
  try {
    charge({});
  } catch (err) {
    // The usual way to log an exception with pino.
    logger.error({ err }, "charge failed");
  } finally {
    span.end();
  }
});

// Leave the batch processors time to export before the process ends.
setTimeout(() => {}, 2000);
