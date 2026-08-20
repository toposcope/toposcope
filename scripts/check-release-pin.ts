export function ghcrAppPin(compose: string): string | null {
  const match = compose.match(/^\s+image:\s+ghcr\.io\/[^:\s]+:(\S+)/m);
  return match?.[1] ?? null;
}

export function releasePinsMatch(args: {
  tag: string;
  packageVersion: string;
  composePin: string | null;
}): string | null {
  const tag = args.tag.replace(/^v/, "");
  if (!tag) {
    return "missing release tag";
  }
  if (tag !== args.packageVersion || tag !== args.composePin) {
    return `tag ${tag} package.json ${args.packageVersion} compose ${args.composePin}`;
  }
  return null;
}

const isMain = import.meta.main === true;
if (isMain) {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
  const pkg = (await Bun.file("package.json").json()) as { version: string };
  const compose = await Bun.file("compose.yml").text();
  const error = releasePinsMatch({
    tag,
    packageVersion: pkg.version,
    composePin: ghcrAppPin(compose),
  });
  if (error) {
    console.error(error);
    process.exit(1);
  }
}
