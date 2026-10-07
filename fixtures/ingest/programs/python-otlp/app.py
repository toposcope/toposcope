import logging

from opentelemetry import trace

logger = logging.getLogger("billing")


def charge(order):
    return {"receipt": order["card"]["token"]}


with trace.get_tracer("billing").start_as_current_span("POST /pay"):
    try:
        charge({})
    except KeyError:
        # The usual way to log an exception with the standard library.
        logger.exception("charge failed")
