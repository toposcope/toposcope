import * as v from "valibot";
import { fieldRoles } from "../../shared/fields";
import { optionalChoice, optionalText, requiredText, window } from "./common";

export const fieldsQuery = v.object({
  ...window,
  wave: optionalChoice(["keys", "values", "suggest"], "wave must be keys, values, or suggest", "One slice of the catalog: keys, values or suggest; all of it when left out or empty."),
  cheap: optionalText("With wave=suggest: keys to suggest from cheaply, separated by commas."),
});

export const fieldsBody = v.object({
  roles: v.nullish(
    v.pipe(
      v.record(v.string(), v.string()),
      v.description(`Each field's role: ${fieldRoles.join(", ")}; a field left out is chart. Replaces every role.`),
    ),
  ),
  links: v.nullish(
    v.pipe(v.record(v.string(), v.string()), v.description("Each field's metric label, so Graph opens its metric; replaces every link.")),
  ),
});

const gapKeyWords = "version, host, trace_id, stack (on error rows) or marks (a deploy mark)";

export const coverageGapBody = v.object({
  service: v.pipe(v.string("service is required"), v.description("The service, as Coverage lists it.")),
  key: v.pipe(v.string("key is required"), v.description(`The gap: ${gapKeyWords}.`)),
});

export const coverageGapQuery = v.object({
  service: requiredText("The service, as Coverage lists it.", "service is required"),
  key: requiredText(`The gap: ${gapKeyWords}.`, "key is required"),
});
