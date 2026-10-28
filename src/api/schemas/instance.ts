import * as v from "valibot";

export const upgradeBody = v.nullish(
  v.object({
    version: v.optional(
      v.pipe(
        v.string("version must be a release newer than this one that the release check knows"),
        v.description("The release to upgrade to, one GET /api/version lists."),
      ),
    ),
  }),
);
