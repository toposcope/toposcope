/** GitHub release notes are the matching CHANGELOG.md section, not the tagged commit. */

export function versionFromReleaseTag(tag: string): string {
  const version = tag.trim().replace(/^v/, "");
  if (!version) {
    throw new Error("missing release tag");
  }
  return version;
}

export function changelogNotesForVersion(
  changelog: string,
  version: string,
): string | null {
  const heading = `## ${version}`;
  const lines = changelog.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) {
    return null;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.startsWith("## ")) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  if (!body) {
    return null;
  }
  return `${body}\n`;
}

export function rewriteChangelogLinks(
  notes: string,
  opts: { repo: string; tag: string },
): string {
  const tag = opts.tag.startsWith("v") ? opts.tag : `v${opts.tag}`;
  return notes.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, text: string, href: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) {
      return full;
    }
    const hash = href.indexOf("#");
    const path = hash === -1 ? href : href.slice(0, hash);
    const fragment = hash === -1 ? "" : href.slice(hash);
    return `[${text}](https://github.com/${opts.repo}/blob/${tag}/${path}${fragment})`;
  });
}

const isMain = import.meta.main === true;
if (isMain) {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
  try {
    const version = versionFromReleaseTag(tag);
    const changelog = await Bun.file("CHANGELOG.md").text();
    const notes = changelogNotesForVersion(changelog, version);
    if (!notes) {
      throw new Error(`CHANGELOG.md has no ${version} section`);
    }
    const repo = process.env.GITHUB_REPOSITORY ?? "toposcope/toposcope";
    process.stdout.write(rewriteChangelogLinks(notes, { repo, tag }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
