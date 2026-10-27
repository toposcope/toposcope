import { formatCompactCount } from "./count-format";

/** A link as `GET /api/links` lists it (#136): no secret. */
export type LinkItem = {
  id: string;
  role: "pull" | "serve";
  connects: "we" | "they";
  peer_id: string;
  peer_name: string;
  peer_url: string;
  q: string;
  /** The kinds it carries, `logs,marks,traces` (#329). */
  kinds: string;
  kid: string;
  position: number;
  settled: number;
  arrived_at: string | null;
  behind_rows: number | null;
  gone_from: number | null;
  gone_to: number | null;
  gone_from_at: string | null;
  gone_to_at: string | null;
  last_contact_at: number | null;
  last_error: string | null;
  created_at: number;
};

export type LinkKeyItem = {
  kid: string;
  label: string;
  kind: "offer" | "invite";
  q: string;
  /** The kinds the link it makes will carry (#329). */
  kinds: string[];
  until: number | null;
  uses: number;
  created_at: number;
};

export type LinksList = {
  here: { id: string; name: string | null };
  links: LinkItem[];
  keys: LinkKeyItem[];
};

/** Behind by less than this reads as caught up, so polls do not toggle the words. */
export const caughtUpWithinMs = 30_000;
/** A link that has not been read this long is quiet: a pass runs every 5 seconds. */
export const quietAfterMs = 30_000;

const pad = (n: number) => String(n).padStart(2, "0");
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `14:02:11` today, `Oct 6 09:12` before; UTC, as the rest of the app reads times. */
export function linkClock(ms: number, now: number): string {
  const d = new Date(ms);
  const today = new Date(now);
  const sameDay =
    d.getUTCFullYear() === today.getUTCFullYear() &&
    d.getUTCMonth() === today.getUTCMonth() &&
    d.getUTCDate() === today.getUTCDate();
  return sameDay
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    : `${months[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `11:40` today, `Oct 5` before: the short form after "since". */
function sinceClock(ms: number, now: number): string {
  const full = linkClock(ms, now);
  return full.includes(" ") ? full.slice(0, full.lastIndexOf(" ")) : full.slice(0, 5);
}

export function lagWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 || hours >= 24 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

export type PositionWords = { text: string; tone: "ok" | "behind" | "quiet" };

/**
 * Where a link stands, in time: caught up; behind, by how long (and how many rows on an
 * every-row link, the only kind where that count is exact); or quiet since when. Who connects
 * decides the quiet words: we call them and they are "not answering"; they call us and they
 * "have not called".
 */
export function linkPositionWords(link: LinkItem, now: number): PositionWords {
  const since = link.last_contact_at ?? link.created_at;
  const quiet = link.last_error !== null || now - since > quietAfterMs;
  if (quiet) {
    const at = sinceClock(since, now);
    return {
      text: link.connects === "we" ? `not answering since ${at}` : `has not called since ${at}`,
      tone: "quiet",
    };
  }
  if (link.last_contact_at === null || link.position >= link.settled) {
    return { text: "caught up", tone: "ok" };
  }
  const lag = link.arrived_at ? now - Date.parse(link.arrived_at) : null;
  if (lag !== null && lag < caughtUpWithinMs) {
    return { text: "caught up", tone: "ok" };
  }
  const time = lag === null ? null : lagWords(lag);
  if (link.q.trim() === "" && link.behind_rows !== null && link.behind_rows > 0) {
    return {
      text: `behind ${formatCompactCount(link.behind_rows)} rows${time ? ` · ${time}` : ""}`,
      tone: "behind",
    };
  }
  return { text: time ? `behind ${time}` : "behind", tone: "behind" };
}

export function contactWords(link: LinkItem): string {
  return link.connects === "we" ? "we call them" : "they call us";
}

/** A key nobody has pasted yet, or a reusable one, in the Position column. */
export function keyPositionWords(key: LinkKeyItem): string {
  if (key.until === null) {
    return "single use · not pasted yet";
  }
  const d = new Date(key.until);
  const date = `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return `until ${date} · used by ${key.uses}`;
}

/** The filter as text: never a blank that reads as "not set yet". */
export function filterWords(q: string): string {
  return q.trim() === "" ? "Every row — no filter" : q;
}
