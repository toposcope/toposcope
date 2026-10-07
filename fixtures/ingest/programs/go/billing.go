package main

type Card struct{ Token string }

type Order struct{ Card *Card }

func charge(order *Order) string {
	return order.Card.Token
}
