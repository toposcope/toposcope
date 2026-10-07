package com.example.billing;

public final class Billing {
  private Billing() {}

  public static String charge(Order order) {
    if (order.card() == null) {
      throw new IllegalStateException("order has no card");
    }
    return order.card();
  }
}
