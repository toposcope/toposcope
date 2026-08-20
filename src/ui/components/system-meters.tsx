import { useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  formatByteRate,
  formatBytes,
  formatBytesPair,
  formatCpuPercent,
} from "../../shared/bytes";
import {
  isHighPressure,
  type ProcessStats,
  type SystemSnapshot,
} from "../../shared/system";
import { cn } from "@/lib/utils";

function Chip({
  label,
  stats,
  showDisk,
}: {
  label: string;
  stats: ProcessStats | null;
  showDisk: boolean;
}) {
  const mem =
    stats === null ? "—" : formatBytesPair(stats.mem_used, stats.mem_limit);
  const disk =
    showDisk && stats?.disk_used != null
      ? formatBytesPair(stats.disk_used, stats.disk_total)
      : null;
  const hot =
    stats !== null &&
    (isHighPressure(stats.mem_used, stats.mem_limit) ||
      (stats.disk_used != null &&
        isHighPressure(stats.disk_used, stats.disk_total)));
  const aria = [label, mem, disk].filter(Boolean).join(" ");

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 whitespace-nowrap font-mono text-[11px] tabular-nums",
            hot ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground",
          )}
          aria-label={aria}
        >
          <span className="opacity-60">{label}</span>
          <span>{mem}</span>
          {disk ? (
            <>
              <span className="opacity-50">·</span>
              <span>{disk}</span>
            </>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="end"
        className="bg-popover text-popover-foreground border px-2 py-1.5 font-mono text-[11px] tabular-nums"
      >
        <p className="font-sans text-[11px] text-muted-foreground">{label}</p>
        {stats === null ? (
          <p>Unavailable</p>
        ) : (
          <>
            <p>Mem {formatBytesPair(stats.mem_used, stats.mem_limit)}</p>
            {showDisk && stats.disk_used != null ? (
              <p>Disk {formatBytesPair(stats.disk_used, stats.disk_total)}</p>
            ) : null}
            {stats.cpu != null ? <p>CPU {formatCpuPercent(stats.cpu)}</p> : null}
            {stats.io_read != null && stats.io_write != null ? (
              <p>
                IO {formatByteRate(stats.io_read)} r · {formatByteRate(stats.io_write)} w
              </p>
            ) : null}
            {!showDisk && stats.disk_used != null ? (
              <p>SQLite {formatBytes(stats.disk_used)}</p>
            ) : null}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function SystemMeters() {
  const [stats, setStats] = useState<SystemSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetch("/api/system");
      if (!res.ok) {
        return;
      }
      const json = (await res.json()) as SystemSnapshot;
      if (cancelled || typeof json.app?.mem_used !== "number") {
        return;
      }
      setStats(json);
    };
    void load();
    const id = setInterval(() => {
      void load();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex items-center gap-2">
      <Chip label="ClickHouse" stats={stats?.clickhouse ?? null} showDisk />
      <Chip label="App" stats={stats?.app ?? null} showDisk={false} />
    </div>
  );
}
