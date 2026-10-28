import * as v from "valibot";
import { feedKinds } from "../../feed/feed";
import { linkKinds } from "../../links/kinds";
import { limit, optionalText } from "./common";

export const feedCreateBody = v.object({
  q: v.pipe(v.string("q is required (empty means every row)"), v.description("The feed's filter, in the query language; empty means every row. It never changes after.")),
});

export const feedReadQuery = v.object({
  after: optionalText("The position to read after, a whole number, 0 or more; 0 by default."),
  limit,
  kinds: optionalText(`The kinds to read, separated by commas: ${feedKinds.join(", ")}; all by default.`),
});

const kinds = v.optional(
  v.pipe(
    v.union([v.string(), v.array(v.picklist(linkKinds))]),
    v.description(`The kinds the link carries, as a list or separated by commas: ${linkKinds.join(", ")}; all by default.`),
  ),
);

const name = v.nullish(v.pipe(v.string(), v.description("This instance's name, the first time only: the other side sees it. After that it lives in Settings.")));

export const linkUpdateBody = v.object({
  paused: v.optional(v.pipe(v.boolean("paused is true or false"), v.description("Pause or resume the link."))),
  q: v.optional(v.pipe(v.string("q is a string"), v.description("A new filter, only on a link whose rows leave here."))),
  kinds: v.optional(
    v.pipe(
      v.union([v.string(), v.array(v.picklist(linkKinds))]),
      v.description("Fewer kinds, only on a link whose rows leave here: a kind is never added to a key already used."),
    ),
  ),
});

export const linkOfferBody = v.optional(
  v.object({
    name,
    q: v.nullish(v.pipe(v.string(), v.description("The filter rows that leave here must match; empty means every row."))),
    kinds,
  }),
);

export const linkInviteBody = v.optional(
  v.object({
    name,
    q: v.nullish(v.pipe(v.string(), v.description("The filter rows the other side sends must match; empty means every row."))),
    kinds,
    until: v.nullish(
      v.pipe(
        v.union([v.number(), v.string()]),
        v.description("Epoch ms until which the key works for many, at most 30 days out; left out, it works once."),
      ),
    ),
  }),
);

export const linkPreviewBody = v.optional(
  v.object({
    key: v.optional(v.pipe(v.string(), v.description("The pasted link key, tsl2_…"))),
  }),
);

export const linkConfirmBody = v.optional(
  v.object({
    key: v.optional(v.pipe(v.string(), v.description("The pasted link key, tsl2_…"))),
    name,
  }),
);
