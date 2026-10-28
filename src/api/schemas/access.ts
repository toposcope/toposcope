import * as v from "valibot";

function described<T extends v.GenericSchema>(schema: T, description: string) {
  return v.pipe(schema, v.description(description));
}

const roles = ["viewer", "operator", "owner"] as const;

export const ingestTokenBody = v.object({
  name: described(v.string("name is required"), "What sends with it, so Access can name it."),
});

export const inviteBody = v.object({
  who: v.nullish(described(v.string(), "Who it is for: an email, or a name.")),
  role: described(v.picklist(roles, "role is viewer, operator or owner"), "The role they join with."),
  days: v.nullish(described(v.number(), "How many days the link works.")),
});

export const personBody = v.object({
  role: described(v.picklist(roles, "role is viewer, operator or owner"), "The new role."),
});

export const serviceAccountBody = v.object({
  name: described(v.string("A service account needs a name and a role"), "Its name."),
  role: described(v.picklist(roles, "A service account needs a name and a role"), "What its tokens may do."),
});

/** Owner is in the list so the handler can say why it is refused (#357). */
export const agentBody = v.object({
  name: described(v.string("An agent needs a name and a role: viewer or operator"), "The name after `agent: `: 1 to 57 letters, digits, . _ or -, starting with a letter or digit."),
  role: described(v.picklist(roles, "An agent needs a name and a role: viewer or operator"), "viewer or operator; an agent is never an Owner."),
});

export const tokenBody = v.object({
  name: described(v.string("A token needs a name"), "What uses it, so Access can name it."),
  expires_in_days: v.nullish(described(v.number(), "Days until it stops working, 1 to 365; 365 by default.")),
  read_only: v.nullish(described(v.boolean(), "true: it reads and writes nothing.")),
});
