import { readFileSync } from "node:fs";

/** The running release: `package.json`, the same string as the image tag. */
export const version = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
