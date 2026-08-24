import { describe, expect, test } from "bun:test";
import {
  changelogNotesForVersion,
  rewriteChangelogLinks,
  versionFromReleaseTag,
} from "./changelog-release-notes";

const sample = `# Changelog

## Unreleased

## 0.4.0

Fingerprints as \`e1:\`. See [ROADMAP.md](ROADMAP.md) and the [ingest](docs/ingest.md) guide.

Public [site](https://example.com/x).

## 0.3.14

Initial public release.
`;

describe("versionFromReleaseTag", () => {
  test("strips a leading v", () => {
    expect(versionFromReleaseTag("v0.4.0")).toBe("0.4.0");
  });

  test("refuses an empty tag", () => {
    expect(() => versionFromReleaseTag("v")).toThrow("missing release tag");
  });
});

describe("changelogNotesForVersion", () => {
  test("takes the section until the next heading, not Unreleased", () => {
    expect(changelogNotesForVersion(sample, "0.4.0")).toBe(
      "Fingerprints as `e1:`. See [ROADMAP.md](ROADMAP.md) and the [ingest](docs/ingest.md) guide.\n\nPublic [site](https://example.com/x).\n",
    );
    expect(changelogNotesForVersion(sample, "0.3.14")).toBe(
      "Initial public release.\n",
    );
  });

  test("does not treat 0.3.1 as 0.3.14", () => {
    expect(changelogNotesForVersion(sample, "0.3.1")).toBeNull();
  });

  test("refuses a missing or empty section", () => {
    expect(changelogNotesForVersion(sample, "0.5.0")).toBeNull();
    expect(changelogNotesForVersion(sample, "Unreleased")).toBeNull();
  });
});

describe("rewriteChangelogLinks", () => {
  test("points repo paths at the tag and leaves absolute URLs", () => {
    const notes = changelogNotesForVersion(sample, "0.4.0");
    expect(notes).toBeTruthy();
    expect(
      rewriteChangelogLinks(notes ?? "", {
        repo: "toposcope/toposcope",
        tag: "v0.4.0",
      }),
    ).toBe(
      "Fingerprints as `e1:`. See [ROADMAP.md](https://github.com/toposcope/toposcope/blob/v0.4.0/ROADMAP.md) and the [ingest](https://github.com/toposcope/toposcope/blob/v0.4.0/docs/ingest.md) guide.\n\nPublic [site](https://example.com/x).\n",
    );
  });
});
