// A Bun process doing what the app does on every request: an auth check
// over the Unix socket, 8 in flight, until /tmp/stop-load appears. Counted
// in the member's memory budget beside Go and the database. Prints one
// JSON line.
import { existsSync } from "node:fs";

const sock = "/run/ctl/ctl.sock";
const sid = Bun.argv[2] ?? "m-0000042";
let calls = 0, ok = 0, failed = 0, peak = 0;
const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (!existsSync("/tmp/stop-load")) {
      calls++;
      try {
        const r = await fetch(`http://localhost/auth?s=${sid}`, { unix: sock });
        await r.text();
        r.status === 200 ? ok++ : failed++;
      } catch {
        failed++;
        await Bun.sleep(20);
      }
    }
  }),
);
clearInterval(sample);
console.log(JSON.stringify({ calls, ok, failed, bun_peak_rss_kb: Math.round(peak / 1024) }));
