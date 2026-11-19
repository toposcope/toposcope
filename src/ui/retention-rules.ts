/** Services kept longer than logs (#477, sheet 46): the Settings card's rows and checks. */
export type RetentionRule = { service: string; days: number };

/** A row as the card edits it: days stay text until Save. */
export type RuleDraft = { service: string; days: string };

export const maxRules = 8;
export const maxRuleDays = 730;

/** The longest any row is kept: how far back a window may pan. */
export function longestKeptDays(body: { retention_days: number; retention_rules?: { days: number }[] | null }): number {
  return Math.max(body.retention_days, ...(body.retention_rules ?? []).map((r) => r.days));
}

export function draftsOf(rules: readonly RetentionRule[] | null | undefined): RuleDraft[] {
  return (rules ?? []).map((r) => ({ service: r.service, days: String(r.days) }));
}

/** The first draft whose days are out of range, with the line 46f shows under the rows. */
export function ruleFault(drafts: readonly RuleDraft[], logsDays: number): { service: string; message: string } | null {
  for (const d of drafts) {
    const n = Number(d.days.trim());
    if (d.days.trim() === "" || !Number.isInteger(n) || n < 1 || n > maxRuleDays || n < logsDays) {
      return { service: d.service, message: `1–${maxRuleDays} days, and not shorter than logs (${logsDays})` };
    }
  }
  return null;
}

export function rulesOf(drafts: readonly RuleDraft[]): RetentionRule[] {
  return drafts.map((d) => ({ service: d.service, days: Number(d.days.trim()) }));
}

/**
 * What a save would delete (46e): each service that was kept longer and now keeps fewer days,
 * with the days it goes back to. A service removed goes back to logs' days.
 */
export function shortened(
  before: readonly RetentionRule[],
  after: readonly RetentionRule[],
  logsDays: number,
): { service: string; days: number }[] {
  const next = new Map(after.map((r) => [r.service, r.days]));
  const out: { service: string; days: number }[] = [];
  for (const r of before) {
    const days = next.get(r.service) ?? logsDays;
    if (days < r.days) {
      out.push({ service: r.service, days });
    }
  }
  return out;
}

/** 46e's line: "billing goes back to 30 days. Its rows older than 30 days are deleted at the next sweep." */
export function shortenedLine(cut: readonly { service: string; days: number }[]): string {
  if (cut.length === 1) {
    const [only] = cut;
    return `goes back to ${only!.days} days. Its rows older than ${only!.days} days are deleted at the next sweep.`;
  }
  return "keep fewer days. Their rows past the new days are deleted at the next sweep.";
}
