public record Card(string Token);

public record Order(Card? Card);

public static class Billing
{
    public static async Task<string> ChargeAsync(Order order)
    {
        await Task.Yield();
        return order.Card!.Token;
    }
}
