import type { Context } from "hono";
import { embedFrameHeaders, ticketShareId } from "./embed";
import { shareById } from "./store";

const distDir = "./src/ui/dist-embed";

/**
 * `GET /embed` (#227): one panel and nothing else. The page itself carries no data; it reads with
 * the ticket in its own URL. The frame rules are the share's: the origins it lists, or none.
 */
export async function embedPageRoute(c: Context): Promise<Response> {
  const ticket = c.req.query("ticket") ?? "";
  const id = ticketShareId(ticket);
  // An expired or revoked ticket still names its share: its own frame rules, so "expired" shows.
  const share = id ? shareById(id) : null;
  const headers = embedFrameHeaders(share?.embed.frame_ancestors ?? []);
  const file = Bun.file(`${distDir}/index.html`);
  if (!(await file.exists())) {
    return c.text("Embed not built. Run bun run build:ui", 500, headers);
  }
  return c.html(await file.text(), 200, headers);
}

/** `GET /embed/assets/*`: the embed's own hashed files, without a sign-in, cached for good. */
export async function embedAssetRoute(c: Context): Promise<Response> {
  const name = c.req.path.slice("/embed/assets/".length);
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    return c.json({ error: "Not found" }, 404);
  }
  const file = Bun.file(`${distDir}/assets/${name}`);
  if (!(await file.exists())) {
    return c.json({ error: "Not found" }, 404);
  }
  return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable" } });
}

/**
 * `GET /embed.js` (#227): a loader, not a renderer. A `<script data-ticket=… data-metric=…>` tag is
 * replaced by the same `/embed` iframe, sized from `data-width` / `data-height`; when the frame says
 * nothing in 5 seconds, one plain line in class `toposcope-fallback` takes its place, for the host's
 * CSS. It draws nothing and reads no data itself. It is the same file for every share, so a host
 * can serve its own copy, with `data-origin` naming Toposcope: then the fallback shows even when
 * Toposcope is down.
 */
export async function embedJsRoute(_c: Context): Promise<Response> {
  return new Response(embedLoader(), {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}

/** The panel params a tag may carry, each a `data-` attribute of the same name. */
export const embedParams = ["ticket", "metric", "reading", "ml", "split", "agg", "range", "step", "title", "theme"] as const;

export function embedLoader(): string {
  return `(() => {
  "use strict";
  const params = ${JSON.stringify(embedParams)};
  if (!document.getElementById("toposcope-fallback-style")) {
    // Zero specificity: any rule the host writes for .toposcope-fallback wins.
    const style = document.createElement("style");
    style.id = "toposcope-fallback-style";
    style.textContent = ":where(.toposcope-fallback){display:flex;align-items:center;justify-content:center;box-sizing:border-box;border:1px solid rgba(127,127,127,.35);border-radius:6.4px;font:13px system-ui,sans-serif}";
    document.head.appendChild(style);
  }
  const tags = document.querySelectorAll("script[data-ticket]:not([data-toposcope-placed])");
  for (const tag of tags) {
    tag.setAttribute("data-toposcope-placed", "");
    // data-origin when the host serves its own copy; else wherever the tag loaded this from.
    const origin = new URL(tag.getAttribute("data-origin") || tag.src).origin;
    const query = new URLSearchParams();
    for (const p of params) {
      const v = tag.getAttribute("data-" + p);
      if (v !== null && v !== "") query.set(p, v);
    }
    const frame = document.createElement("iframe");
    frame.src = origin + "/embed?" + query.toString();
    frame.title = tag.getAttribute("data-title") || "toposcope panel";
    frame.referrerPolicy = "no-referrer";
    frame.style.border = "0";
    frame.style.display = "block";
    frame.style.width = tag.getAttribute("data-width") || "100%";
    frame.style.height = tag.getAttribute("data-height") || "240px";
    tag.after(frame);
    let ready = false;
    let line = null;
    window.addEventListener("message", (e) => {
      if (e.source !== frame.contentWindow || e.origin !== origin) return;
      // Any word from the frame means Toposcope answered: expired and stale paint in the frame.
      if (!e.data || typeof e.data.type !== "string" || !e.data.type.startsWith("toposcope:")) return;
      ready = true;
      if (line) {
        line.remove();
        line = null;
        frame.style.display = "block";
      }
    });
    setTimeout(() => {
      if (ready) return;
      // The frame stays, hidden: when Toposcope answers later, the panel takes its place back.
      line = document.createElement("div");
      line.className = "toposcope-fallback";
      line.textContent = "Toposcope unreachable";
      line.style.width = frame.style.width;
      line.style.height = frame.style.height;
      frame.style.display = "none";
      frame.before(line);
    }, 5000);
  }
})();
`;
}
