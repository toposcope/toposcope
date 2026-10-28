// Writes docs/api.md from the described API's table (#356). A test fails when the two drift.
import { join } from "node:path";
import { apiMarkdown } from "../src/api/docs";
import { apiRoutes } from "../src/api/routes";

await Bun.write(join(import.meta.dir, "../docs/api.md"), apiMarkdown(apiRoutes));
console.log(`docs/api.md: ${apiRoutes.length} routes`);
