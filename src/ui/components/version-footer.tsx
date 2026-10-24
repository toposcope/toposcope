import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, CircleAlert, Copy, LoaderCircle, RotateCw } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { VersionReply } from "../../shared/releases";
import {
  agoLabel,
  backupLabel,
  backupSize,
  clockLabel,
  tookLabel,
  upgradeTarget,
  upgradeView,
  beforeItems,
  dayLabel,
  firstLine,
  noteParagraphs,
  operationsGuideUrl,
  releasesPageUrl,
  upgradeCommand,
  versionChip,
  type Segment,
} from "../release-panel";

/**
 * The running version at the footer's right end, and a newer release beside it (#201, frames
 * 19b–19i). Clicking it opens a popover with Before you upgrade first, then what's new, then the
 * one command to run on the host. The app never runs it: that would need the Docker socket.
 */

const pollMs = 60 * 60_000;
/** While an upgrade is asked for or running: through the restart, until the new version answers. */
const upgradingPollMs = 2_000;
/** Set before the reload onto a new version, so the popover opens on it (22i). */
const upgradedKey = "toposcope.upgraded";

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-plate hover:text-foreground">
      {children}
      <ArrowUpRight className="size-3" aria-hidden="true" />
    </a>
  );
}

function Paragraphs({ notes, className }: { notes: string; className?: string }) {
  const paragraphs = noteParagraphs(notes);
  return (
    <>
      {paragraphs.map((segments, i) => (
        <p key={i} className={cn("m-0 text-[12.5px] leading-[1.5] text-zinc-300", className)}>
          {segments.map((s: Segment, j) =>
            s.kind === "code" ? (
              <code key={j} className="font-mono text-[11.5px]">
                {s.text}
              </code>
            ) : s.kind === "link" ? (
              <a key={j} href={s.href} target="_blank" rel="noreferrer" className="text-plate hover:text-foreground">
                {s.text}
              </a>
            ) : (
              <span key={j}>{s.text}</span>
            ),
          )}
        </p>
      ))}
    </>
  );
}

function Header({ title, link, sub }: { title: string; link: ReactNode; sub?: string }) {
  return (
    <div className="flex flex-col gap-[3px]">
      <div className="flex items-baseline gap-2">
        <span className="text-[14px] font-semibold">{title}</span>
        <span className="flex-1" />
        {link}
      </div>
      {sub ? <span className="font-mono text-[11px] text-muted-foreground">{sub}</span> : null}
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const code = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="flex items-center gap-2 rounded-[5px] border border-white/12 bg-[#0a0a0c] py-1 pr-1 pl-2.5">
      <code ref={code} className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
        {command}
      </code>
      <button
        type="button"
        className="inline-flex h-[26px] shrink-0 items-center gap-[5px] rounded-[5px] border border-white/16 bg-[#18181b] px-[9px] text-[12px] text-foreground hover:bg-accent"
        onClick={() => {
          // A browser that refuses the clipboard, or has none over plain http, gets the command selected instead (19f).
          const select = () => {
            if (code.current) window.getSelection()?.selectAllChildren(code.current);
          };
          if (!navigator.clipboard?.writeText) {
            select();
            return;
          }
          navigator.clipboard.writeText(command).then(() => setCopied(true), select);
        }}
      >
        {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Asks the host to upgrade (#220); resolves to an error to show, or null once asked. */
type OnUpgrade = (version: string) => Promise<string | null>;

const primaryButton =
  "inline-flex h-[30px] shrink-0 items-center rounded-[4.4px] bg-primary px-3.5 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60";

function LogTail({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 overflow-hidden rounded-[5px] border border-white/8 bg-[#0a0a0c] px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
      {lines.map((line, i) => (
        <span key={i} className="truncate whitespace-pre">
          {line}
        </span>
      ))}
    </div>
  );
}

/** The command on the host: the whole box when upgrading from here is off (22e), one click away when on (22f). */
function HostCommand({ version }: { version: string }) {
  return (
    <>
      <p className="m-0 text-[12px] leading-[1.45] text-muted-foreground">
        Run it on the host, in the directory that holds <code className="font-mono text-[11.5px]">compose.yml</code>.
      </p>
      <CopyCommand command={upgradeCommand(version)} />
    </>
  );
}

function UpgradeBox({
  version,
  title,
  size,
  reply,
  onUpgrade,
}: {
  version: string;
  title: string;
  size: string | null;
  reply: VersionReply;
  onUpgrade?: OnUpgrade;
}) {
  const [confirming, setConfirming] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backs = size ? `Backs up both stores first: ${size}.` : "Backs up both stores first.";
  const status = reply.upgrader?.status;
  const ask = () => {
    if (!onUpgrade) return;
    setAsking(true);
    setError(null);
    void onUpgrade(version).then((err) => {
      setAsking(false);
      setError(err);
      if (!err) setConfirming(false);
    });
  };
  if (!reply.upgrader?.enabled || !onUpgrade) {
    return (
      <div className="flex flex-col gap-2 rounded-[6.4px] border border-white/10 bg-[#0d0d10] px-3 py-2.5">
        <div className="text-[12px] font-semibold">{title}</div>
        <HostCommand version={version} />
        <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">
          {backs} Ingest stops while it runs. Add <code className="font-mono">--no-backup</code> to skip it.
        </p>
        {reply.upgrader ? (
          <p className="m-0 border-t border-white/8 pt-2 text-[11.5px] leading-[1.5] text-muted-foreground">
            To upgrade from here instead, run <code className="font-mono">./upgrade.sh enable-ui</code> once on the host (Linux with systemd).
          </p>
        ) : null}
      </div>
    );
  }
  if (confirming) {
    return (
      <div className="flex flex-col gap-2 rounded-[6.4px] border border-amber-500/45 bg-amber-500/[0.07] px-3 py-2.5">
        <div className="text-[12px] font-semibold">Upgrade to {version} now?</div>
        <p className="m-0 text-[12px] leading-[1.45] text-zinc-300">
          Toposcope backs up both stores{size ? ` (${size})` : ""}, stops, and starts {version}. Nothing is ingested meanwhile; collectors
          hold and resend.
        </p>
        <div className="flex items-center gap-2">
          <button type="button" className={primaryButton} disabled={asking} onClick={ask}>
            Upgrade
          </button>
          <button
            type="button"
            className="h-[30px] rounded-[4.4px] px-2.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
        {error ? <p className="m-0 text-[11.5px] text-red-300">{error}</p> : null}
      </div>
    );
  }
  if (upgradeView(reply, Date.now()) === "failed" && status) {
    return (
      <div className="flex flex-col gap-2 rounded-[6.4px] border border-red-400/40 bg-red-400/[0.06] px-3 py-2.5">
        <div className="flex items-center gap-[7px] text-[12.5px] text-red-300">
          <CircleAlert className="size-3.5 text-red-400" aria-hidden="true" />
          Upgrade to {status.to} failed · back on {reply.running}
        </div>
        {status.message ? <p className="m-0 text-[12px] leading-[1.45] text-zinc-300">{status.message}</p> : null}
        <LogTail lines={reply.upgrader?.log.slice(-4) ?? []} />
        <div className="flex items-center gap-2">
          <button type="button" className={primaryButton} onClick={() => setConfirming(true)}>
            Try again
          </button>
          <span className="flex-1" />
          <span className="text-[11px] text-zinc-500">
            whole log: <code className="font-mono">upgrade/last.log</code> in the app volume
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-[6.4px] border border-white/10 bg-[#0d0d10] px-3 py-2.5">
      <div className="text-[12px] font-semibold">{title}</div>
      <div className="flex items-center gap-2">
        <button type="button" className={primaryButton} onClick={() => setConfirming(true)}>
          Upgrade to {version}
        </button>
      </div>
      <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">
        {backs} Ingest stops while it runs. The host runs it; this page reconnects after.
      </p>
      <details className="text-[11.5px] text-muted-foreground">
        <summary className="cursor-pointer hover:text-foreground">Or on the host</summary>
        <div className="mt-2 flex flex-col gap-2">
          <HostCommand version={version} />
        </div>
      </details>
    </div>
  );
}

/** Upgrading (22h): the host's log until the app stops, then the page waits and reconnects. */
function UpgradingPanel({ reply, now }: { reply: VersionReply; now: number }) {
  const u = reply.upgrader!;
  const to = upgradeTarget(reply) ?? reply.latest;
  const started = u.status?.state === "running" ? u.status.started_at : u.requested?.requested_at ?? null;
  const release = reply.releases.find((r) => r.version === to);
  const log = u.status?.state === "running" ? u.log : [];
  const line = log.at(-1) ?? "Asked; waiting for the host to start it…";
  return (
    <div className="flex flex-col gap-2.5">
      <Header
        title={`Upgrading to ${to}`}
        link={<External href={release?.url ?? releasesPageUrl}>Release on GitHub</External>}
        sub={started ? `started ${clockLabel(started)} · ${tookLabel(started, now)}` : undefined}
      />
      <div className="flex flex-col gap-2 rounded-[6.4px] border border-white/10 bg-[#0d0d10] px-3 py-2.5">
        <div className="flex items-center gap-[7px] text-[12.5px] text-zinc-300">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate">{line}</span>
        </div>
        <LogTail lines={log.slice(-5, -1)} />
        <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">
          Toposcope stops while this runs. This page reconnects when it is back.
        </p>
      </div>
      {reply.checked_at ? <div className="text-[11px] text-zinc-500">Checked {agoLabel(reply.checked_at, now)}</div> : null}
    </div>
  );
}

function BeforeBox({ reply }: { reply: VersionReply }) {
  const items = beforeItems(reply.releases);
  if (items.length === 0) return null;
  const several = reply.releases.length > 1;
  const own = items.filter((i) => i.text !== null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-[5px] rounded-[6.4px] border border-amber-500/45 bg-amber-500/[0.07] px-3 py-2.5">
        <div className="flex items-center gap-[7px] text-[12px] font-semibold text-amber-300">
          <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
          Before you upgrade
          {several && own.length === 1 ? <span className="font-mono font-normal">· {own[0]!.version}</span> : null}
        </div>
        {own.map((item) => (
          <div key={item.version} className="flex flex-col gap-0.5">
            {several && own.length > 1 ? <span className="font-mono text-[11px] text-amber-200">{item.version}</span> : null}
            <Paragraphs notes={item.text!} className="text-zinc-100" />
          </div>
        ))}
      </div>
      {items
        .filter((i) => i.guide)
        .map((item) => (
          <div key={item.version} className="flex items-baseline gap-2 px-0.5 text-[12px] text-muted-foreground">
            <span className="font-mono text-foreground">{item.version}</span>
            <span>
              Upgrade notes for this release are in the <External href={operationsGuideUrl}>operations guide</External>
            </span>
          </div>
        ))}
    </div>
  );
}

function WhatsNewList({ reply }: { reply: VersionReply }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="flex flex-col">
      <div className="pb-1 text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">What&apos;s new</div>
      {reply.releases.map((r) => (
        <div key={r.version} className="flex flex-col gap-1.5 border-t border-white/8 py-1.5">
          <div className="flex items-baseline gap-2.5 text-[12.5px]">
            <span className="font-mono text-foreground">{r.version}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">{dayLabel(r.published_at)}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-300">{open[r.version] ? "" : firstLine(r.notes)}</span>
            <button
              type="button"
              aria-expanded={Boolean(open[r.version])}
              className="shrink-0 text-[12px] text-foreground hover:text-plate"
              onClick={() => setOpen((o) => ({ ...o, [r.version]: !o[r.version] }))}
            >
              {open[r.version] ? "Show less" : "Show all"}
            </button>
          </div>
          {open[r.version] ? <Paragraphs notes={r.notes} /> : null}
        </div>
      ))}
    </div>
  );
}

/** Check now (#219, 22a–22d): one check by hand; off while it runs. */
function CheckNow({ checking, onCheck }: { checking: boolean; onCheck?: () => void }) {
  if (!onCheck) return null;
  return (
    <button
      type="button"
      disabled={checking}
      onClick={onCheck}
      className="inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-[4.4px] border border-white/16 px-2 text-[11.5px] text-foreground hover:bg-accent disabled:opacity-45 disabled:hover:bg-transparent"
    >
      <RotateCw className="size-3" aria-hidden="true" />
      Check now
    </button>
  );
}

/** Up to date, checking, or not checked yet, with Check now (22a, 22b); also under an upgrade's done (22i). */
function StatusLine({ reply, now, checking, onCheck }: { reply: VersionReply; now: number; checking: boolean; onCheck?: () => void }) {
  return (
    <div className="flex items-center gap-[7px] text-[12.5px] text-zinc-300">
      {checking ? (
        <>
          <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">Checking GitHub for releases…</span>
        </>
      ) : reply.checked_at ? (
        <>
          <Check className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">Up to date · checked {agoLabel(reply.checked_at, now)}</span>
        </>
      ) : (
        <span className="min-w-0 flex-1">Not checked yet: Toposcope looks a few minutes after it starts.</span>
      )}
      <CheckNow checking={checking} onCheck={onCheck} />
    </div>
  );
}

type PanelProps = {
  reply: VersionReply;
  now: number;
  /** A check by hand is running (22b). */
  checking?: boolean;
  /** Check now; absent, no button. Never shown while the check is off. */
  onCheck?: () => void;
  /** Upgrade from here (#220); absent, only the command. */
  onUpgrade?: OnUpgrade;
};

/** The popover's content, by state: off, could not check, up to date, one release out, several. */
export function ReleasePanel({ reply, now, checking = false, onCheck, onUpgrade }: PanelProps) {
  const running = reply.running;
  const tagUrl = `${releasesPageUrl}/tag/v${running}`;
  if (reply.check === "off") {
    return (
      <div className="flex flex-col gap-2.5">
        <Header title={`Toposcope ${running}`} link={<External href={releasesPageUrl}>Releases on GitHub</External>} />
        <p className="m-0 text-[12.5px] text-zinc-300">
          The release check is off (<code className="font-mono text-[11.5px]">TOPOSCOPE_UPDATE_CHECK=off</code>)
        </p>
        <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">
          This instance does not know whether a newer release is out, and calls nobody to find out. Remove the line from{" "}
          <code className="font-mono">.env</code> and restart to turn it back on.
        </p>
      </div>
    );
  }
  const view = upgradeView(reply, now);
  if (view === "running") {
    return <UpgradingPanel reply={reply} now={now} />;
  }
  const latest = reply.releases[0];
  const failed = reply.error ? (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <p className="m-0 min-w-0 flex-1 text-[12.5px] text-zinc-300">
          {checking
            ? "Checking GitHub for releases…"
            : reply.checked_at
              ? `Could not check for releases since ${dayLabel(reply.checked_at)}`
              : "Could not check for releases yet"}
        </p>
        {latest && reply.latest !== running ? null : <CheckNow checking={checking} onCheck={onCheck} />}
      </div>
      <p className="m-0 font-mono text-[11px] text-muted-foreground">{reply.error}</p>
    </div>
  ) : null;
  if (!latest || reply.latest === running) {
    if (failed) {
      return (
        <div className="flex flex-col gap-2.5">
          <Header title={`Toposcope ${running}`} link={<External href={releasesPageUrl}>Releases on GitHub</External>} />
          {failed}
          <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">
            {reply.checked_at ? `The last answer, on ${dayLabel(reply.checked_at)}, knew of nothing newer. ` : ""}Toposcope tries again once a
            day. A box with no way out can stop trying with <code className="font-mono">TOPOSCOPE_UPDATE_CHECK=off</code>.
          </p>
        </div>
      );
    }
    const done = view === "done" ? reply.upgrader!.status! : null;
    if (done) {
      const backup = backupLabel(done.backup);
      return (
        <div className="flex flex-col gap-2.5">
          <Header title={`Toposcope ${running}`} link={<External href={tagUrl}>Release notes</External>} />
          <div className="flex items-center gap-[7px] text-[12.5px] text-zinc-300">
            <Check className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>
              Upgraded from {done.from ?? "the last version"} · took {tookLabel(done.started_at, done.finished_at)}
              {backup ? (
                <>
                  {" "}
                  · backup in <code className="font-mono text-[11.5px]">{backup}</code>
                </>
              ) : null}
            </span>
          </div>
          {backup ? (
            <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">
              Going back: <code className="font-mono">./upgrade.sh rollback --yes</code> on the host restores that backup.
            </p>
          ) : null}
          <StatusLine reply={reply} now={now} checking={checking} onCheck={onCheck} />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2.5">
        <Header title={`Toposcope ${running}`} link={<External href={tagUrl}>Release notes</External>} />
        <StatusLine reply={reply} now={now} checking={checking} onCheck={onCheck} />
        <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">
          Toposcope asks GitHub once a day whether a newer release is out, and sends nothing about this instance.{" "}
          <code className="font-mono text-zinc-300">TOPOSCOPE_UPDATE_CHECK=off</code> in <code className="font-mono">.env</code> stops it.
        </p>
      </div>
    );
  }
  const several = reply.releases.length > 1;
  return (
    <div className="flex flex-col gap-3">
      {several ? (
        <Header
          title={`${reply.releases.length} releases since yours`}
          link={<External href={releasesPageUrl}>Releases on GitHub</External>}
          sub={`you run ${running} · latest ${reply.latest} · ${reply.step}`}
        />
      ) : (
        <Header
          title={`Toposcope ${latest.version} is out`}
          link={<External href={latest.url ?? releasesPageUrl}>Release on GitHub</External>}
          sub={[`you run ${running}`, reply.step, dayLabel(latest.published_at, true)].filter(Boolean).join(" · ")}
        />
      )}
      {failed}
      <BeforeBox reply={reply} />
      {several ? (
        <WhatsNewList reply={reply} />
      ) : latest.notes ? (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">What&apos;s new in {latest.version}</div>
          <Paragraphs notes={latest.notes} />
        </div>
      ) : null}
      <UpgradeBox
        version={reply.latest}
        title={several ? `Upgrade to ${reply.latest}` : "Upgrade"}
        size={backupSize(reply.store)}
        reply={reply}
        onUpgrade={onUpgrade}
      />
      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
        <span className="min-w-0 flex-1">
          {checking
            ? "Checking GitHub for releases…"
            : reply.checked_at
              ? `${reply.error ? "Last answer" : "Checked"} ${agoLabel(reply.checked_at, now)}`
              : null}
        </span>
        <CheckNow checking={checking} onCheck={onCheck} />
      </div>
    </div>
  );
}

/** The footer item and its popover. */
export function VersionFooter() {
  const [reply, setReply] = useState<VersionReply | null>(null);
  const [open, setOpen] = useState(() => {
    try {
      if (sessionStorage.getItem(upgradedKey) !== "1") return false;
      sessionStorage.removeItem(upgradedKey);
      return true;
    } catch {
      return false;
    }
  });
  const loaded = useRef<string | null>(null);
  const [checking, setChecking] = useState(false);
  const checkNow = () => {
    setChecking(true);
    void fetch("/api/version/check", { method: "POST" })
      .then(async (res) => {
        if (res.ok) setReply((await res.json()) as VersionReply);
      })
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };
  const upgrade = async (version: string): Promise<string | null> => {
    const res = await fetch("/api/version/upgrade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version }),
    }).catch(() => null);
    if (!res) return "Toposcope did not answer.";
    const body = (await res.json().catch(() => ({}))) as { error?: string; upgrader?: VersionReply["upgrader"] };
    if (body.upgrader) setReply((r) => (r ? { ...r, upgrader: body.upgrader } : r));
    return res.ok ? null : (body.error ?? `Asking failed (${res.status})`);
  };
  const upgrading = reply ? upgradeView(reply, Date.now()) === "running" : false;
  // Through the restart: a failed fetch is the app being down, so keep asking.
  useEffect(() => {
    if (!upgrading) return;
    const t = setInterval(() => {
      void fetch("/api/version")
        .then(async (res) => {
          if (res.ok) setReply((await res.json()) as VersionReply);
        })
        .catch(() => undefined);
    }, upgradingPollMs);
    return () => clearInterval(t);
  }, [upgrading]);
  // A new version answering: this page's code is the old one's, so load the new, popover open.
  useEffect(() => {
    if (!reply) return;
    if (loaded.current === null) {
      loaded.current = reply.running;
    } else if (reply.running !== loaded.current) {
      try {
        sessionStorage.setItem(upgradedKey, "1");
      } catch {
        // The popover just stays shut after the reload.
      }
      window.location.reload();
    }
  }, [reply]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetch("/api/version").catch(() => null);
      if (!res?.ok || cancelled) return;
      setReply((await res.json()) as VersionReply);
    };
    void load();
    const t = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  if (!reply) return null;
  const chip = versionChip(reply);
  return (
    <>
      <span className="h-3.5 w-px shrink-0 bg-border" aria-hidden />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={chip.label}
            title={chip.newer ? `${chip.newer} is out${chip.readFirst ? " · read before upgrading" : ""}` : undefined}
            className={cn(
              "-mr-1.5 inline-flex shrink-0 items-center gap-[5px] rounded px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap hover:bg-accent",
              chip.newer ? "text-zinc-300" : "text-muted-foreground",
              open && "bg-accent text-foreground",
            )}
          >
            {chip.running}
            {chip.newer ? (
              <>
                <span>→</span>
                <span className="text-plate">{chip.newer}</span>
              </>
            ) : null}
            {chip.readFirst ? <span className="size-[5px] rounded-full bg-amber-500" aria-hidden="true" /> : null}
            {upgrading ? <span>· upgrading</span> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={6}
          className="max-h-[calc(100vh-80px)] w-[min(460px,calc(100vw-16px))] overflow-y-auto rounded-[6.4px] border-white/14 bg-[#18181b] p-[14px] shadow-[0_18px_40px_-12px_rgba(0,0,0,0.7)]"
        >
          <ReleasePanel
            reply={reply}
            now={Date.now()}
            checking={checking}
            onCheck={reply.check === "on" ? checkNow : undefined}
            onUpgrade={upgrade}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}
