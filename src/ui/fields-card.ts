import type { FieldRole, FieldsResponse } from "../shared/fields";

/** What the Settings Fields card says (28a, #292): facts from the keys wave over the last 24 h. */
export type FieldsCardFacts = {
  keys: number;
  core: number;
  attrs: number;
  /** Chosen roles only; a key with none chosen is counted in `unchosen`, not here. */
  roles: Record<FieldRole, number>;
  /** Keys that take a role but have none chosen yet; they are summarised as chart until chosen. */
  unchosen: string[];
  links: string[];
};

export function fieldsCardFacts(body: Pick<FieldsResponse, "keys" | "roles" | "links">): FieldsCardFacts {
  const roles: Record<FieldRole, number> = { chart: 0, lookup: 0, ignore: 0 };
  const unchosen: string[] = [];
  for (const row of body.keys) {
    if (!row.roleable) {
      continue;
    }
    const role = body.roles[row.key];
    if (role) {
      roles[role] += 1;
    } else {
      unchosen.push(row.key);
    }
  }
  const core = body.keys.filter((row) => row.kind === "core").length;
  return {
    keys: body.keys.length,
    core,
    attrs: body.keys.length - core,
    roles,
    unchosen,
    links: Object.keys(body.links).sort(),
  };
}

/** `client_ip, cart_id` — the first few names, then `+N`. */
export function namesLine(names: string[], max = 3): string {
  if (names.length <= max) {
    return names.join(", ");
  }
  return `${names.slice(0, max).join(", ")} +${names.length - max}`;
}
