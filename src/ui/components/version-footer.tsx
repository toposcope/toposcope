import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { VersionReply } from "../../shared/releases";
import {
  agoLabel,
  backupSize,
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

function UpgradeBox({ version, title, size }: { version: string; title: string; size: string | null }) {
  return (
    <div className="flex flex-col gap-2 rounded-[6.4px] border border-white/10 bg-[#0d0d10] px-3 py-2.5">
      <div className="text-[12px] font-semibold">{title}</div>
      <p className="m-0 text-[12px] leading-[1.45] text-muted-foreground">
        Run it on the host, in the directory that holds <code className="font-mono text-[11.5px]">compose.yml</code>.
      </p>
      <CopyCommand command={upgradeCommand(version)} />
      <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">
        {size ? `Backs up both stores first: ${size}.` : "Backs up both stores first."} Ingest stops while it runs. Add{" "}
        <code className="font-mono">--no-backup</code> to skip it.
      </p>
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

/** The popover's content, by state: off, could not check, up to date, one release out, several. */
export function ReleasePanel({ reply, now }: { reply: VersionReply; now: number }) {
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
  const latest = reply.releases[0];
  const failed = reply.error ? (
    <div className="flex flex-col gap-1">
      <p className="m-0 text-[12.5px] text-zinc-300">
        {reply.checked_at ? `Could not check for releases since ${dayLabel(reply.checked_at)}` : "Could not check for releases yet"}
      </p>
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
    return (
      <div className="flex flex-col gap-2.5">
        <Header title={`Toposcope ${running}`} link={<External href={tagUrl}>Release notes</External>} />
        <div className="flex items-center gap-[7px] text-[12.5px] text-zinc-300">
          {reply.checked_at ? (
            <>
              <Check className="size-3.5 text-muted-foreground" aria-hidden="true" />
              Up to date · checked {agoLabel(reply.checked_at, now)}
            </>
          ) : (
            "Not checked yet: Toposcope looks a few minutes after it starts."
          )}
        </div>
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
      <UpgradeBox version={reply.latest} title={several ? `Upgrade to ${reply.latest}` : "Upgrade"} size={backupSize(reply.store)} />
      {reply.checked_at ? (
        <div className="text-[11px] text-zinc-500">
          {reply.error ? "Last answer" : "Checked"} {agoLabel(reply.checked_at, now)}
        </div>
      ) : null}
    </div>
  );
}

/** The footer item and its popover. */
export function VersionFooter() {
  const [reply, setReply] = useState<VersionReply | null>(null);
  const [open, setOpen] = useState(false);
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
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={6}
          className="max-h-[calc(100vh-80px)] w-[min(460px,calc(100vw-16px))] overflow-y-auto rounded-[6.4px] border-white/14 bg-[#18181b] p-[14px] shadow-[0_18px_40px_-12px_rgba(0,0,0,0.7)]"
        >
          <ReleasePanel reply={reply} now={Date.now()} />
        </PopoverContent>
      </Popover>
    </>
  );
}
