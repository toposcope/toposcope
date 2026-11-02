/**
 * The Toposcope GitHub App (#416): one App, owned by the toposcope org, read-only on repository
 * metadata, with no webhook and no callback. Its client ID is public by design: an instance uses it
 * for GitHub's device flow, and the token GitHub hands back goes to that instance alone.
 * `TOPOSCOPE_GITHUB_CLIENT_ID` and `TOPOSCOPE_GITHUB_APP` point an instance at an App of its own.
 */

/** The shipped App's client ID (github.com/apps/toposcope); empty would hide Connect GitHub. */
const shippedClientId = "Iv23linB0NGInmOJyfG2";

const slug = process.env.TOPOSCOPE_GITHUB_APP?.trim() || "toposcope";

export const githubApp = {
  clientId: process.env.TOPOSCOPE_GITHUB_CLIENT_ID?.trim() || shippedClientId,
  slug,
  webUrl: "https://github.com",
  apiUrl: "https://api.github.com",
  /** Where someone picks the accounts and repositories the App can see. */
  installUrl: `https://github.com/apps/${slug}/installations/new`,
};
