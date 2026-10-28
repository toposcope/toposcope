import * as v from "valibot";
import { fieldRoles } from "../../shared/fields";
import { optionalText, window } from "./common";

export const fieldsQuery = v.object({
  ...window,
  wave: v.optional(v.pipe(v.picklist(["keys", "values", "suggest"], "wave must be keys, values, or suggest"), v.description("One slice of the catalog: keys, values or suggest; all of it when left out."))),
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
