/** The runnable examples in the ingest guide's "What an app sends" section. */
export type GuideExample = {
  /** `/v1/logs` or `/api/ingest`. */
  path: string;
  body: unknown;
};

/** One `## ` section of the guide, heading included, up to the next `## `. */
export function guideSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start < 0) {
    throw new Error(`ingest guide has no "${heading}" section`);
  }
  const next = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start + 1, next < 0 ? undefined : next + 1);
}

/** Every `curl -X POST … -d '<json>'` block in a section. */
export function guideExamples(section: string): GuideExample[] {
  const examples: GuideExample[] = [];
  for (const block of section.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const curl = block[1] ?? "";
    const path = curl.match(/curl -X POST http:\/\/127\.0\.0\.1:8080(\/\S+)/)?.[1];
    const body = curl.match(/-d '([^']+)'/)?.[1];
    if (path && body) {
      examples.push({ path, body: JSON.parse(body) as unknown });
    }
  }
  return examples;
}
