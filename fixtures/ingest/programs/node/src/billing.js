"use strict";

function charge(order) {
  return { receipt: order.card.token };
}

module.exports = { charge };
