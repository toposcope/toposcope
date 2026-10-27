import type { Role } from "./people";

/**
 * What each role may do (#306, frame 30d): the role table as code. Every `/api/*` route the app
 * registers names the least role that may call it; a test fails on a route that is not here.
 *
 * | May do                                           | Viewer | Operator | Owner |
 * | Read Home, Hunt, Watch, traces, profiles         |   ✓    |    ✓     |   ✓   |
 * | Save their own hunts, pin them                   |   ✓    |    ✓     |   ✓   |
 * | Export rows                                      |   ✓    |    ✓     |   ✓   |
 * | Write notes on the clock                         |   —    |    ✓     |   ✓   |
 * | Make and change monitors, webhooks               |   —    |    ✓     |   ✓   |
 * | Change Fields roles and metric links             |   —    |    ✓     |   ✓   |
 * | Add panels to an existing share                  |   —    |    ✓     |   ✓   |
 * | Invite people, change roles                      |   —    |    —     |   ✓   |
 * | Make or revoke tokens, links, shares             |   —    |    —     |   ✓   |
 * | Retention, sign-in, instance settings            |   —    |    —     |   ✓   |
 */
export type Action =
  | "read"
  | "own hunts"
  | "write notes"
  | "change monitors"
  | "change fields"
  | "add share panels"
  | "see access"
  | "let people in"
  | "make tokens, links, shares"
  | "change instance settings"
  | "any signed in";

export const actionRole: Record<Action, Role> = {
  read: "viewer",
  "own hunts": "viewer",
  "write notes": "operator",
  "change monitors": "operator",
  "change fields": "operator",
  "add share panels": "operator",
  "see access": "operator",
  "let people in": "owner",
  "make tokens, links, shares": "owner",
  "change instance settings": "owner",
  "any signed in": "viewer",
};

/** The words a refusal uses: "A Viewer may not change monitors: ask an Operator". */
export const actionWords: Record<Action, string> = {
  read: "read",
  "own hunts": "save hunts",
  "write notes": "write notes on the clock",
  "change monitors": "make or change monitors and webhooks",
  "change fields": "change Fields roles and metric links",
  "add share panels": "add panels to a share",
  "see access": "see Access",
  "let people in": "invite people or change roles",
  "make tokens, links, shares": "make or revoke tokens, links and shares",
  "change instance settings": "change retention, sign-in or instance settings",
  "any signed in": "do this",
};

type Route = [method: string, pattern: string, action: Action];

/** Every `/api/*` route that needs a signed-in person, and what it does in the table's words. */
export const routeActions: Route[] = [
  ["POST", "/api/sign-out", "any signed in"],
  ["GET", "/api/me", "any signed in"],
  ["GET", "/api/instance", "any signed in"],
  ["GET", "/api/search", "read"],
  ["GET", "/api/traces/:trace_id", "read"],
  ["GET", "/api/marks", "read"],
  ["GET", "/api/probes", "read"],
  ["GET", "/api/profiles", "read"],
  ["GET", "/api/search/context", "read"],
  ["GET", "/api/search/around", "read"],
  ["GET", "/api/search/cut", "read"],
  ["GET", "/api/search/revisions", "read"],
  ["GET", "/api/search/follow-span", "read"],
  ["GET", "/api/fingerprints/:hex", "read"],
  ["GET", "/api/facets", "read"],
  ["GET", "/api/attr-keys", "read"],
  ["GET", "/api/attr-facets", "read"],
  ["GET", "/api/attr-values", "read"],
  ["GET", "/api/numeric-keys", "read"],
  ["GET", "/api/metric-names", "read"],
  ["GET", "/api/metric-labels", "read"],
  ["GET", "/api/throughput", "read"],
  ["GET", "/api/system", "read"],
  ["GET", "/api/version", "read"],
  ["GET", "/api/home", "read"],
  ["GET", "/api/home/since", "read"],
  ["GET", "/api/saved-searches", "read"],
  ["GET", "/api/saved-searches/:id/run", "read"],
  ["GET", "/api/alert-rules", "read"],
  ["GET", "/api/monitors", "read"],
  ["GET", "/api/monitors/preview", "read"],
  ["GET", "/api/monitors/:name", "read"],
  ["GET", "/api/settings", "read"],
  ["GET", "/api/fields", "read"],
  ["GET", "/api/feeds", "see access"],
  ["GET", "/api/feeds/:id", "see access"],
  ["GET", "/api/links", "see access"],
  ["GET", "/api/links/:id", "see access"],
  ["GET", "/api/shares", "see access"],
  ["GET", "/api/access", "see access"],
  ["GET", "/api/api-tokens", "see access"],
  ["POST", "/api/saved-searches", "own hunts"],
  ["PUT", "/api/saved-searches/:id", "own hunts"],
  ["DELETE", "/api/saved-searches/:id", "own hunts"],
  ["POST", "/api/saved-searches/:id/test", "change monitors"],
  ["PUT", "/api/home", "change monitors"],
  ["POST", "/v1/marks", "write notes"],
  ["POST", "/api/alert-rules/test-call", "change monitors"],
  ["POST", "/api/alert-rules", "change monitors"],
  ["PUT", "/api/alert-rules/:id", "change monitors"],
  ["DELETE", "/api/alert-rules/:id", "change monitors"],
  ["POST", "/api/monitors/send", "change monitors"],
  ["PUT", "/api/monitors/:name", "change monitors"],
  ["DELETE", "/api/monitors/:name", "change monitors"],
  ["PUT", "/api/fields", "change fields"],
  // An Operator may add panels to a share that exists; the handler refuses anything more.
  ["PUT", "/api/shares/:name", "add share panels"],
  ["POST", "/api/shares/:name/ticket", "add share panels"],
  ["POST", "/api/shares", "make tokens, links, shares"],
  ["DELETE", "/api/shares/:name", "make tokens, links, shares"],
  ["POST", "/api/feeds", "make tokens, links, shares"],
  ["PUT", "/api/links/:id", "make tokens, links, shares"],
  ["POST", "/api/links/offer", "make tokens, links, shares"],
  ["POST", "/api/links/invite", "make tokens, links, shares"],
  ["POST", "/api/links/preview", "make tokens, links, shares"],
  ["POST", "/api/links/confirm", "make tokens, links, shares"],
  ["DELETE", "/api/links/keys/:kid", "make tokens, links, shares"],
  ["DELETE", "/api/links/:id", "make tokens, links, shares"],
  ["POST", "/api/api-tokens", "make tokens, links, shares"],
  ["DELETE", "/api/api-tokens/:id", "make tokens, links, shares"],
  ["PUT", "/api/settings", "change instance settings"],
  ["POST", "/api/version/check", "change instance settings"],
  ["POST", "/api/version/upgrade", "change instance settings"],
];

function matches(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) {
    return false;
  }
  return want.every((part, i) => part.startsWith(":") ? got[i] !== "" : part === got[i]);
}

/** The table row a request falls under, or null for a path no route serves (its 404 follows). */
export function actionFor(method: string, path: string): Action | null {
  const verb = method === "HEAD" ? "GET" : method;
  // Fixed paths win over a `:param` on the same prefix (`/api/monitors/preview` over `:name`).
  const exact = routeActions.find(([m, p]) => m === verb && p === path);
  if (exact) {
    return exact[2];
  }
  const found = routeActions.find(([m, p]) => m === verb && p.includes(":") && matches(p, path));
  return found ? found[2] : null;
}

const roleWords: Record<Role, string> = { viewer: "A Viewer", operator: "An Operator", owner: "An Owner" };
const askWords: Record<Role, string> = { viewer: "a Viewer", operator: "an Operator", owner: "an Owner" };

/** The sentence a refusal carries: "A Viewer may not make or change monitors and webhooks: ask an Operator". */
export function refusalWords(role: Role, action: Action): string {
  return `${roleWords[role]} may not ${actionWords[action]}: ask ${askWords[actionRole[action]]}`;
}
