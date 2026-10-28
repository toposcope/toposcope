import type { Role } from "./people";

/**
 * What each role may do (#306, frame 30d): the role table as code. Every
 * `/api` route names its row in the described API's table (api/routes.ts), and the gate checks it.
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

const roleWords: Record<Role, string> = { viewer: "A Viewer", operator: "An Operator", owner: "An Owner" };
const askWords: Record<Role, string> = { viewer: "a Viewer", operator: "an Operator", owner: "an Owner" };

/** The sentence a refusal carries: "A Viewer may not make or change monitors and webhooks: ask an Operator". */
export function refusalWords(role: Role, action: Action): string {
  return `${roleWords[role]} may not ${actionWords[action]}: ask ${askWords[actionRole[action]]}`;
}
