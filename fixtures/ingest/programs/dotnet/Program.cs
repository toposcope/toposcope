var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Logging.ClearProviders();
var app = builder.Build();

// The uncaught-error path: the exception as the runtime prints it.
app.Use(async (context, next) =>
{
    try
    {
        await next(context);
    }
    catch (Exception error)
    {
        var path = Environment.GetEnvironmentVariable("OUT")!;
        File.WriteAllText(path, error.ToString());
        File.WriteAllText(path + ".type", error.GetType().FullName);
        context.Response.StatusCode = 500;
    }
});

app.MapPost("/pay", async () => await Billing.ChargeAsync(new Order(null)));

await app.StartAsync();
using var client = new HttpClient();
await client.PostAsync(app.Urls.First() + "/pay", null);
await app.StopAsync();
