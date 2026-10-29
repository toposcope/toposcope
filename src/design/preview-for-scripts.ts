/**
 * For tests and local scripts (#360): a token's monitor save needs a preview of the same body
 * first, so a fixture that saves one previews it the way an agent does. Any other request, or a
 * body that is not an object, is left alone.
 */
export async function previewMonitorFirst(
  fetcher: (req: Request) => Response | Promise<Response>,
  url: string,
  init: { method?: string; headers?: HeadersInit; body?: unknown },
): Promise<void> {
  const method = (init.method ?? "GET").toUpperCase();
  const at = new URL(url);
  const path = at.pathname;
  let body: unknown = init.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return;
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return;
  }
  const target =
    method === "PUT" && path.startsWith("/api/monitors/")
      ? { name: decodeURIComponent(path.slice("/api/monitors/".length)) }
      : method === "PUT" && path.startsWith("/api/alert-rules/") && path !== "/api/alert-rules/test-call"
        ? { id: decodeURIComponent(path.slice("/api/alert-rules/".length)) }
        : method === "POST" && path === "/api/alert-rules"
          ? { saves: "create" }
          : null;
  if (!target) {
    return;
  }
  await fetcher(
    new Request(new URL("/api/monitors/preview", at), {
      method: "POST",
      headers: init.headers,
      body: JSON.stringify({ ...(body as Record<string, unknown>), ...target }),
    }),
  );
}
