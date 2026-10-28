import { accessRoute } from "../access/list";
import { monitorPreviewRoute } from "../alerts/preview";
import { testAlertCallRoute } from "../alerts/test-call";
import { createAlertRule, deleteAlertRule, getAlert, listAlertRules, monitorsNamed } from "../control/alerts";
import { getFields, putFields } from "../control/fields";
import { getHome, putHome } from "../control/home";
import { homeSinceRoute } from "../control/home-since";
import { sendHttpRoute } from "../control/http-monitors";
import {
  instanceRoute,
  meRoute,
  putSignInSettingsRoute,
  signInSettingsRoute,
  versionCheckRoute,
  versionRoute,
  versionUpgradeRoute,
} from "../control/instance-routes";
import { withPlace } from "../control/monitor-place";
import { deleteMonitor, getMonitor, listMonitors, putMonitor, updateMonitorRoute } from "../control/monitors";
import {
  cancelInviteRoute,
  createInviteRoute,
  createMyTokenRoute,
  createServiceAccountRoute,
  createServiceTokenRoute,
  listPeopleRoute,
  myTokensRoute,
  newBackupCodesRoute,
  putPersonRoute,
  resetTwoStepRoute,
  revokePersonRoute,
  revokeTokenRoute,
} from "../control/people-routes";
import type { Action } from "../control/roles";
import { createSavedSearch, deleteSavedSearch, listSavedSearches, runSavedSearch, testSavedSearch, updateSavedSearch } from "../control/saved-searches";
import { getSettings, putSettings } from "../control/settings";
import { createApiToken, deleteApiToken, listApiTokens } from "../control/tokens";
import { createFeedRoute, listFeedsRoute, readFeedRoute } from "../feed/feed";
import { confirmRoute, inviteRoute, listLinksRoute, offerRoute, previewRoute, removeLinkRoute, revokeKeyRoute } from "../links/operator";
import { linkPageRoute, updateLinkRoute } from "../links/page";
import {
  attrFacetsRoute,
  attrKeysRoute,
  attrValuesRoute,
  aroundTsRoute,
  facetsRoute,
  metricLabelsRoute,
  metricNamesRoute,
  numericKeysRoute,
  searchRoute,
  surroundingRoute,
} from "../query";
import { fingerprintCutRoute, fingerprintRevisionsRoute } from "../query/fingerprint-cut";
import { fingerprintSeenRoute } from "../query/fingerprint-seen";
import { followSpanRoute } from "../query/follow-span";
import { marksRoute } from "../query/marks";
import { probesRoute } from "../query/probes";
import { profilesRoute } from "../query/profiles";
import { systemRoute } from "../query/system";
import { throughputRoute } from "../query/throughput";
import { tracesRoute } from "../query/traces";
import { createShareRoute, listSharesRoute, previewTicketRoute, putShareRoute, revokeShareRoute } from "../share/operator";
import { version } from "../shared/version";
import { openApiDocument } from "./openapi";
import { routeFor, type ApiRoute } from "./registry";
import { settingsBody, signInSettingsBody } from "./schemas/settings";
import { ingestTokenBody, inviteBody, personBody, serviceAccountBody, tokenBody } from "./schemas/access";
import { fieldsBody, fieldsQuery } from "./schemas/fields";
import { homeBody, homeSinceQuery, savedCreateBody, savedUpdateBody } from "./schemas/saved";
import { upgradeBody } from "./schemas/instance";
import { monitorBody, monitorPreviewQuery, monitorsQuery, sendBody, testCallBody } from "./schemas/monitors";
import { feedCreateBody, feedReadQuery, linkConfirmBody, linkInviteBody, linkOfferBody, linkPreviewBody, linkUpdateBody } from "./schemas/links";
import { shareCreateBody, sharePutBody } from "./schemas/shares";
import { aroundQuery, attrFacetsQuery, attrKeysQuery, attrValuesQuery, contextQuery, cutQuery, facetsQuery, fingerprintSeenQuery, followSpanQuery, marksQuery, metricLabelsQuery, metricNamesQuery, numericKeysQuery, probesQuery, profilesQuery, revisionsQuery, searchQuery } from "./schemas/search";

/**
 * The described API (#356), in the order the app registers it: a fixed path comes before a
 * `:param` on the same prefix. Each row's action is the role table's (control/roles.ts).
 */
export const apiRoutes: ApiRoute[] = [
  // Instance
  { id: "me", method: "GET", path: "/api/me", area: "Instance", action: "any signed in", summary: "Who the caller is: their person, role and initials, and the Owners to ask.", query: null, body: null, handler: meRoute },
  { id: "instance", method: "GET", path: "/api/instance", area: "Instance", action: "any signed in", summary: "This instance's id, name and address, and how the caller's session ends.", query: null, body: null, handler: instanceRoute },
  { id: "openapi", method: "GET", path: "/api/openapi.json", area: "Instance", action: "any signed in", summary: "This API as OpenAPI 3.1, built from the same table as the routes.", query: null, body: null, handler: (c) => c.json(openApi()) },
  { id: "system", method: "GET", path: "/api/system", area: "Instance", action: "read", summary: "The app's and ClickHouse's memory, CPU and disk now.", query: null, body: null, handler: systemRoute },
  { id: "throughput", method: "GET", path: "/api/throughput", area: "Instance", action: "read", summary: "Rows received a second now, and a histogram of the last hour.", query: null, body: null, handler: throughputRoute },
  { id: "version", method: "GET", path: "/api/version", area: "Instance", action: "read", summary: "The running version, newer releases the daily check knows, and whether upgrading from here is on.", query: null, body: null, handler: versionRoute },
  { id: "version_check", method: "POST", path: "/api/version/check", area: "Instance", action: "change instance settings", summary: "Check for newer releases now, on top of the daily check.", query: null, body: null, handler: versionCheckRoute },
  { id: "version_upgrade", method: "POST", path: "/api/version/upgrade", area: "Instance", action: "change instance settings", summary: "Ask the host to upgrade to a newer release the check knows.", query: null, body: upgradeBody, handler: versionUpgradeRoute },

  // Search
  { id: "search", method: "GET", path: "/api/search", area: "Search", action: "read", summary: "Rows that match a query in a window, newest first, with a histogram or a metric's series.", query: searchQuery, body: null, handler: searchRoute },
  { id: "traces_get", method: "GET", path: "/api/traces/:trace_id", area: "Search", action: "read", summary: "One trace's spans, the slowest branches when it is large.", query: null, body: null, handler: tracesRoute },
  { id: "marks", method: "GET", path: "/api/marks", area: "Search", action: "read", summary: "Change marks in a window: deploys, flags, incidents and notes.", query: marksQuery, body: null, handler: marksRoute },
  { id: "probes", method: "GET", path: "/api/probes", area: "Search", action: "read", summary: "Probe samples in a window.", query: probesQuery, body: null, handler: probesRoute },
  { id: "profiles", method: "GET", path: "/api/profiles", area: "Search", action: "read", summary: "The profile samples one span carries, as a flame graph.", query: profilesQuery, body: null, handler: profilesRoute },
  { id: "search_context", method: "GET", path: "/api/search/context", area: "Search", action: "read", summary: "The rows either side of one row, from the same service and host.", query: contextQuery, body: null, handler: surroundingRoute },
  { id: "search_around", method: "GET", path: "/api/search/around", area: "Search", action: "read", summary: "The rows that match a query either side of a time.", query: aroundQuery, body: null, handler: aroundTsRoute },
  { id: "search_cut", method: "GET", path: "/api/search/cut", area: "Search", action: "read", summary: "Compare a query's fingerprints before and after a change mark.", query: cutQuery, body: null, handler: fingerprintCutRoute },
  { id: "search_revisions", method: "GET", path: "/api/search/revisions", area: "Search", action: "read", summary: "Which fingerprint keys a query's rows carry before and after a point.", query: revisionsQuery, body: null, handler: fingerprintRevisionsRoute },
  { id: "search_follow_span", method: "GET", path: "/api/search/follow-span", area: "Search", action: "read", summary: "How many rows carry one key:value within a day of a time, and their first and last.", query: followSpanQuery, body: null, handler: followSpanRoute },
  { id: "fingerprint_seen", method: "GET", path: "/api/fingerprints/:hex", area: "Search", action: "read", summary: "When one fingerprint was first and last seen, and how often, in a window.", query: fingerprintSeenQuery, body: null, handler: fingerprintSeenRoute },
  { id: "facets", method: "GET", path: "/api/facets", area: "Search", action: "read", summary: "The top values of service, host, level and fingerprint among a query's rows.", query: facetsQuery, body: null, handler: facetsRoute },
  { id: "attr_keys", method: "GET", path: "/api/attr-keys", area: "Search", action: "read", summary: "The attribute keys a query's rows carry.", query: attrKeysQuery, body: null, handler: attrKeysRoute },
  { id: "attr_facets", method: "GET", path: "/api/attr-facets", area: "Search", action: "read", summary: "The top values of some attribute keys among a query's rows.", query: attrFacetsQuery, body: null, handler: attrFacetsRoute },
  { id: "attr_values", method: "GET", path: "/api/attr-values", area: "Search", action: "read", summary: "The values of one attribute key that start with a prefix.", query: attrValuesQuery, body: null, handler: attrValuesRoute },
  { id: "numeric_keys", method: "GET", path: "/api/numeric-keys", area: "Search", action: "read", summary: "The attribute keys with numbers among a query's rows, to sum or average.", query: numericKeysQuery, body: null, handler: numericKeysRoute },
  { id: "metric_names", method: "GET", path: "/api/metric-names", area: "Search", action: "read", summary: "The metric names with points in a window.", query: metricNamesQuery, body: null, handler: metricNamesRoute },
  { id: "metric_labels", method: "GET", path: "/api/metric-labels", area: "Search", action: "read", summary: "The label keys one metric's points carry in a window, with how many values each.", query: metricLabelsQuery, body: null, handler: metricLabelsRoute },

  // Home and saved searches
  { id: "home", method: "GET", path: "/api/home", area: "Saved searches", action: "read", summary: "The saved search marked Home, if any.", query: null, body: null, handler: getHome },
  { id: "home_since", method: "GET", path: "/api/home/since", area: "Saved searches", action: "read", summary: "What changed since a mark or in the last hour: new fingerprints, monitors that opened, marks.", query: homeSinceQuery, body: null, handler: homeSinceRoute },
  { id: "home_set", method: "PUT", path: "/api/home", area: "Saved searches", action: "change monitors", summary: "Mark a saved search Home, or unmark it.", query: null, body: homeBody, handler: putHome },
  { id: "saved_searches", method: "GET", path: "/api/saved-searches", area: "Saved searches", action: "read", summary: "The saved searches the caller may see, with their pins.", query: null, body: null, handler: listSavedSearches },
  { id: "saved_search_create", method: "POST", path: "/api/saved-searches", area: "Saved searches", action: "own hunts", summary: "Save a search: a Viewer's is their own, an Operator's is shared.", query: null, body: savedCreateBody, handler: createSavedSearch },
  { id: "saved_search_update", method: "PUT", path: "/api/saved-searches/:id", area: "Saved searches", action: "own hunts", summary: "Change a saved search, or pin or unpin it; a field left out keeps its value.", query: null, body: savedUpdateBody, handler: updateSavedSearch },
  { id: "saved_search_delete", method: "DELETE", path: "/api/saved-searches/:id", area: "Saved searches", action: "own hunts", summary: "Delete a saved search.", query: null, body: null, handler: deleteSavedSearch },
  { id: "saved_search_run", method: "GET", path: "/api/saved-searches/:id/run", area: "Saved searches", action: "read", summary: "Run a saved search over its own window: its rows' count and its series' value.", query: null, body: null, handler: runSavedSearch },
  { id: "saved_search_test", method: "POST", path: "/api/saved-searches/:id/test", area: "Saved searches", action: "change monitors", summary: "Read a saved search as a monitor would now: its value, a sample of rows, and when it last matched.", query: null, body: null, handler: testSavedSearch },

  // Monitors (#175); /api/alert-rules stays as their alias.
  { id: "alert_rules", method: "GET", path: "/api/alert-rules", area: "Monitors", action: "read", summary: "Every monitor as a rule, and whether a call can link back here.", query: null, body: null, handler: listAlertRules },
  { id: "alert_rule_test_call", method: "POST", path: "/api/alert-rules/test-call", area: "Monitors", action: "change monitors", summary: "Send a test call for a monitor as drafted, filled in from its last evaluation.", query: null, body: testCallBody, handler: testAlertCallRoute },
  { id: "alert_rule_create", method: "POST", path: "/api/alert-rules", area: "Monitors", action: "change monitors", summary: "Make a monitor on a saved search.", query: null, body: monitorBody, handler: withPlace(createAlertRule, () => null) },
  { id: "alert_rule_update", method: "PUT", path: "/api/alert-rules/:id", area: "Monitors", action: "change monitors", summary: "Change a monitor by id; a field left out keeps its value.", query: null, body: monitorBody, handler: withPlace(updateMonitorRoute, (c) => getAlert(c.req.param("id") ?? "")) },
  { id: "alert_rule_delete", method: "DELETE", path: "/api/alert-rules/:id", area: "Monitors", action: "change monitors", summary: "Delete a monitor by id, and its record.", query: null, body: null, handler: deleteAlertRule },
  { id: "monitors", method: "GET", path: "/api/monitors", area: "Monitors", action: "read", summary: "Every monitor with its state and the stretches, calls and results in a window.", query: monitorsQuery, body: null, handler: listMonitors },
  // Watch this (#264): where a saved-search monitor would have opened over the last 24 h.
  { id: "monitor_preview", method: "GET", path: "/api/monitors/preview", area: "Monitors", action: "read", summary: "Where a monitor on a query would have opened over the last 24 hours.", query: monitorPreviewQuery, body: null, handler: monitorPreviewRoute },
  { id: "monitor_send", method: "POST", path: "/api/monitors/send", area: "Monitors", action: "change monitors", summary: "Run an HTTP(S), TCP or certificate check once from here and say what came back; nothing is stored.", query: null, body: sendBody, handler: sendHttpRoute },
  { id: "monitor_get", method: "GET", path: "/api/monitors/:name", area: "Monitors", action: "read", summary: "One monitor by name, with its last 200 stretches and their calls.", query: null, body: null, handler: getMonitor },
  {
    id: "monitor_put",
    method: "PUT",
    path: "/api/monitors/:name",
    area: "Monitors",
    action: "change monitors",
    summary: "Make or replace the monitor of that name; what is left out takes its default.",
    query: null, body: monitorBody, handler: withPlace(putMonitor, (c) => monitorsNamed([(c.req.param("name") ?? "").trim()])[0] ?? null),
  },
  { id: "monitor_delete", method: "DELETE", path: "/api/monitors/:name", area: "Monitors", action: "change monitors", summary: "Delete a monitor by name, and its record.", query: null, body: null, handler: deleteMonitor },

  // Fields
  { id: "fields", method: "GET", path: "/api/fields", area: "Fields", action: "read", summary: "The fields rows carry, their roles, and the metric links.", query: fieldsQuery, body: null, handler: getFields },
  { id: "fields_set", method: "PUT", path: "/api/fields", area: "Fields", action: "change fields", summary: "Set fields' roles and the metric links.", query: null, body: fieldsBody, handler: putFields },

  // Shares
  { id: "shares", method: "GET", path: "/api/shares", area: "Shares", action: "see access", summary: "Every share, live ones first, with its panels and use.", query: null, body: null, handler: listSharesRoute },
  { id: "share_create", method: "POST", path: "/api/shares", area: "Shares", action: "make tokens, links, shares", summary: "Make a share; its secret is in this answer and never again.", query: null, body: shareCreateBody, handler: createShareRoute },
  { id: "share_put", method: "PUT", path: "/api/shares/:name", area: "Shares", action: "add share panels", summary: "Make or change a share in place; an Operator may only add panels to one that exists.", query: null, body: sharePutBody, handler: putShareRoute },
  { id: "share_revoke", method: "DELETE", path: "/api/shares/:name", area: "Shares", action: "make tokens, links, shares", summary: "Revoke a share now: its secret and every read made with it stop.", query: null, body: null, handler: revokeShareRoute },
  { id: "share_ticket", method: "POST", path: "/api/shares/:name/ticket", area: "Shares", action: "add share panels", summary: "A five-minute ticket to preview a share as the other site will see it.", query: null, body: null, handler: previewTicketRoute },

  // Links and feeds
  { id: "feeds", method: "GET", path: "/api/feeds", area: "Links and feeds", action: "see access", summary: "Every feed: a fixed filter whose rows are read in order.", query: null, body: null, handler: listFeedsRoute },
  { id: "feed_create", method: "POST", path: "/api/feeds", area: "Links and feeds", action: "make tokens, links, shares", summary: "Make a feed on a filter; the filter never changes after.", query: null, body: feedCreateBody, handler: createFeedRoute },
  { id: "feed_read", method: "GET", path: "/api/feeds/:id", area: "Links and feeds", action: "see access", summary: "A feed's rows after a position, in order.", query: feedReadQuery, body: null, handler: readFeedRoute },
  { id: "links", method: "GET", path: "/api/links", area: "Links and feeds", action: "see access", summary: "This instance, its links and its link keys.", query: null, body: null, handler: listLinksRoute },
  { id: "link_get", method: "GET", path: "/api/links/:id", area: "Links and feeds", action: "see access", summary: "One link's page: which way rows move, its scope, and each kind's state.", query: null, body: null, handler: linkPageRoute },
  { id: "link_update", method: "PUT", path: "/api/links/:id", area: "Links and feeds", action: "make tokens, links, shares", summary: "Pause or resume a link, or narrow its scope where rows leave here.", query: null, body: linkUpdateBody, handler: updateLinkRoute },
  { id: "link_offer", method: "POST", path: "/api/links/offer", area: "Links and feeds", action: "make tokens, links, shares", summary: "Mint a key that lets another instance copy rows from here.", query: null, body: linkOfferBody, handler: offerRoute },
  { id: "link_invite", method: "POST", path: "/api/links/invite", area: "Links and feeds", action: "make tokens, links, shares", summary: "Mint a key that lets another instance send rows here.", query: null, body: linkInviteBody, handler: inviteRoute },
  { id: "link_preview", method: "POST", path: "/api/links/preview", area: "Links and feeds", action: "make tokens, links, shares", summary: "Read a pasted key: who minted it, which way rows move, its filter, and whether it is unused.", query: null, body: linkPreviewBody, handler: previewRoute },
  { id: "link_confirm", method: "POST", path: "/api/links/confirm", area: "Links and feeds", action: "make tokens, links, shares", summary: "Claim a pasted key at its minter and start the link.", query: null, body: linkConfirmBody, handler: confirmRoute },
  { id: "link_key_revoke", method: "DELETE", path: "/api/links/keys/:kid", area: "Links and feeds", action: "make tokens, links, shares", summary: "Revoke a link key that has not been used.", query: null, body: null, handler: revokeKeyRoute },
  { id: "link_remove", method: "DELETE", path: "/api/links/:id", area: "Links and feeds", action: "make tokens, links, shares", summary: "Stop a link; rows already moved age out under retention.", query: null, body: null, handler: removeLinkRoute },

  // Access and people
  { id: "access", method: "GET", path: "/api/access", area: "Access", action: "see access", summary: "Every way in: people, tokens, links and shares, with today's use and refusals.", query: null, body: null, handler: accessRoute },
  { id: "api_tokens", method: "GET", path: "/api/api-tokens", area: "Access", action: "see access", summary: "The ingest tokens.", query: null, body: null, handler: listApiTokens },
  { id: "api_token_create", method: "POST", path: "/api/api-tokens", area: "Access", action: "make tokens, links, shares", summary: "Make an ingest token; it is in this answer and never again.", query: null, body: ingestTokenBody, handler: createApiToken },
  { id: "api_token_delete", method: "DELETE", path: "/api/api-tokens/:id", area: "Access", action: "make tokens, links, shares", summary: "Revoke an ingest token.", query: null, body: null, handler: deleteApiToken },
  { id: "people", method: "GET", path: "/api/people", area: "Access", action: "see access", summary: "People, service accounts and invites, with their roles and tokens.", query: null, body: null, handler: listPeopleRoute },
  { id: "invite_create", method: "POST", path: "/api/people/invites", area: "Access", action: "let people in", summary: "Invite someone with a role; the link is in this answer and never again.", query: null, body: inviteBody, handler: createInviteRoute },
  { id: "invite_cancel", method: "DELETE", path: "/api/people/invites/:id", area: "Access", action: "let people in", summary: "Cancel an invite.", query: null, body: null, handler: cancelInviteRoute },
  { id: "service_account_create", method: "POST", path: "/api/people/service-accounts", area: "Access", action: "let people in", summary: "Make a service account with a role.", query: null, body: serviceAccountBody, handler: createServiceAccountRoute },
  { id: "person_update", method: "PUT", path: "/api/people/:id", area: "Access", action: "let people in", summary: "Change a person's or a service account's role.", query: null, body: personBody, handler: putPersonRoute },
  { id: "person_revoke", method: "DELETE", path: "/api/people/:id", area: "Access", action: "let people in", summary: "Revoke a person or a service account; their sessions and tokens end.", query: null, body: null, handler: revokePersonRoute },
  { id: "service_token_create", method: "POST", path: "/api/people/:id/tokens", area: "Access", action: "make tokens, links, shares", summary: "Make a service account's token; it is in this answer and never again.", query: null, body: tokenBody, handler: createServiceTokenRoute },
  { id: "service_token_revoke", method: "DELETE", path: "/api/people/:id/tokens/:tid", area: "Access", action: "make tokens, links, shares", summary: "Revoke one of a person's or a service account's tokens.", query: null, body: null, handler: revokeTokenRoute },
  { id: "two_step_reset", method: "DELETE", path: "/api/people/:id/two-step", area: "Access", action: "let people in", summary: "Reset a person's two-step; they set it up again at their next sign-in.", query: null, body: null, handler: resetTwoStepRoute },
  { id: "my_backup_codes", method: "POST", path: "/api/me/two-step/backup-codes", area: "Access", action: "any signed in", summary: "Ten new backup codes for the caller; the old ten stop working.", query: null, body: null, handler: newBackupCodesRoute },
  { id: "my_tokens", method: "GET", path: "/api/me/tokens", area: "Access", action: "any signed in", summary: "The caller's own personal tokens.", query: null, body: null, handler: myTokensRoute },
  { id: "my_token_create", method: "POST", path: "/api/me/tokens", area: "Access", action: "any signed in", summary: "Make a personal token for the caller's own scripts; it is in this answer and never again.", query: null, body: tokenBody, handler: createMyTokenRoute },
  { id: "my_token_revoke", method: "DELETE", path: "/api/me/tokens/:id", area: "Access", action: "any signed in", summary: "Revoke one of the caller's own tokens.", query: null, body: null, handler: revokeTokenRoute },

  // Settings
  { id: "sign_in_settings", method: "GET", path: "/api/sign-in-settings", area: "Settings", action: "change instance settings", summary: "How people sign in here: passwords, the provider, and who must have two-step.", query: null, body: null, handler: signInSettingsRoute },
  { id: "sign_in_settings_set", method: "PUT", path: "/api/sign-in-settings", area: "Settings", action: "change instance settings", summary: "Change how people sign in here; a field left out keeps its value.", query: null, body: signInSettingsBody, handler: putSignInSettingsRoute },
  { id: "settings", method: "GET", path: "/api/settings", area: "Settings", action: "read", summary: "Retention, metrics retention, the instance's name, the default webhook and who must have two-step.", query: null, body: null, handler: getSettings },
  { id: "settings_set", method: "PUT", path: "/api/settings", area: "Settings", action: "change instance settings", summary: "Change retention, metrics retention, the instance's name, the default webhook or who must have two-step; a field left out keeps its value.", query: null, body: settingsBody, handler: putSettings },
];

/** Not under /api, but the gate checks a role on it: a note mark is the one write a person makes from the app (#259). */
const otherActions: Array<{ method: string; path: string; action: Action }> = [{ method: "POST", path: "/v1/marks", action: "write notes" }];

/** The role table's row a request falls under, or null for a path no route serves (its 404 follows). */
export function actionFor(method: string, path: string): Action | null {
  return routeFor<{ method: string; path: string; action: Action }>([...apiRoutes, ...otherActions], method, path)?.action ?? null;
}

let built: object | null = null;

/** Built at start, from the table above. */
export function openApi(): object {
  built ??= openApiDocument(apiRoutes, version);
  return built;
}
