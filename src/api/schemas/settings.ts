import * as v from "valibot";
import { providerPresets } from "../../control/oidc";

function described<T extends v.GenericSchema>(schema: T, description: string) {
  return v.pipe(schema, v.description(description));
}

const twoStepFor = v.optional(described(v.picklist(["everyone", "owners"], "two_step_for is everyone or owners"), "Who must have a second step: everyone with a password, or Owners only."));

export const settingsBody = v.object({
  retention_days: v.optional(described(v.number(), "How many days rows are kept, 1 to 365.")),
  metrics_retention_days: v.nullish(described(v.union([v.number(), v.literal("")]), "How many days metric points are kept; null or empty follows retention_days.")),
  instance_name: v.nullish(described(v.string("instance_name must be text"), "This instance's name, as links and the tab title show it; null or empty unnames it.")),
  default_webhook_url: v.nullish(described(v.string(), "Where monitors call when they name no URL of their own, http(s); null or empty for none.")),
  two_step_for: twoStepFor,
});

export const signInSettingsBody = v.object({
  passwords: v.optional(described(v.boolean("passwords is true or false"), "Whether people may sign in with a password.")),
  oidc: v.nullish(
    described(
      v.object({
        preset: v.nullish(described(v.string(), `The provider: ${providerPresets.join(", ")}; other when it is none of these.`)),
        label: v.nullish(described(v.string(), "The sign-in button's name, up to 40 characters; the preset's by default.")),
        issuer: v.nullish(described(v.string(), "The provider's https URL, as its discovery document names it.")),
        client_id: v.nullish(described(v.string(), "From the provider's app registration.")),
        client_secret: v.nullish(described(v.string(), "From the provider's app registration; left out or empty keeps the one stored.")),
        allowed_domain: v.nullish(described(v.string(), "Only emails at this domain, like example.com; empty for any.")),
        without_invite: v.nullish(described(v.string(), "The role someone gets who signs in with no invite: viewer (the default), operator, or none to refuse them.")),
      }, "oidc is an object, or null to remove it"),
      "The sign-in provider; null removes it.",
    ),
  ),
  two_step_for: twoStepFor,
});
