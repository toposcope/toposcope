// Stands in for Toposcope while Prometheus remote-writes: keeps each body and its headers, numbered, in the directory given.
const out = process.argv[2]!;
let i = 0;
Bun.serve({ port: 39999, hostname: "0.0.0.0", async fetch(req) {
  const body = new Uint8Array(await req.arrayBuffer());
  const n = String(i++).padStart(3, "0");
  await Bun.write(`${out}/${n}.bin`, body);
  await Bun.write(`${out}/${n}.json`, JSON.stringify(Object.fromEntries(req.headers), null, 1));
  return new Response(null, { status: 204 });
}});
