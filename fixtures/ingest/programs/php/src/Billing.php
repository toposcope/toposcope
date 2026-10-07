<?php

declare(strict_types=1);

namespace Billing;

final class Billing
{
    public function charge(array $order): string
    {
        if (!isset($order['card'])) {
            throw new \DomainException('order has no card');
        }
        return $order['card']['token'];
    }
}
