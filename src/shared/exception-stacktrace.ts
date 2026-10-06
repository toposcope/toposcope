import type { ExceptionFrame } from "./exception";

function sourceFile(file: string): boolean {
  return file.length <= 4096 && !/[\x00-\x1f]/.test(file) && !/[/\\]$/.test(file) && (
    /^(?:[/\\]|[a-z]:[/\\]|\.{1,2}[/\\]|[a-z][a-z0-9+.-]*:\/\/)/i.test(file) ||
    /\.[a-z0-9]+$/i.test(file)
  );
}

function frame(file: string, fn: string, anonymous = false): ExceptionFrame | undefined {
  const path = file.trim();
  const name = fn.trim();
  if (!sourceFile(path) || (!name && !anonymous) || name.length > 1024 || /[\x00-\x1f]/.test(name)) {
    return undefined;
  }
  return { file: path, function: name };
}

/** Read known SDK stack formats. The raw stack stays stored; no log-body parsing. */
export function parseExceptionStacktrace(raw: unknown, maxFrames: number): ExceptionFrame[] {
  if (typeof raw !== "string") {
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const frames: ExceptionFrame[] = [];
  for (let i = 0; i < lines.length && frames.length < maxFrames; i++) {
    const line = lines[i]!;
    if (line.length > 8192) {
      continue;
    }
    let parsed: ExceptionFrame | undefined;
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^\s*File "([^"]+)", line \d+, in (.+?)\s*$/))) {
      parsed = frame(match[1]!, match[2]!);
    } else if ((match = line.match(/^\s*at (.+?) in (.+):line \d+\s*$/))) {
      parsed = frame(match[2]!, match[1]!);
    } else if ((match = line.match(/^\s*#\d+ (.+?)\(\d+\): ([^(]+)\(.*\)\s*$/))) {
      parsed = frame(match[1]!, match[2]!);
    } else if ((match = line.match(/^\s*at (.+?) \((.+):\d+:\d+\)\s*$/))) {
      parsed = frame(match[2]!, match[1]!);
    } else if ((match = line.match(/^\s*at (.+):\d+:\d+\s*$/))) {
      parsed = frame(match[1]!, "", true);
    } else if ((match = line.match(/^\s*at ([^\s(]+)\(([^)]+):\d+\)\s*$/))) {
      parsed = frame(match[2]!, match[1]!);
    } else if (i > 0 && (match = line.match(/^\s+(.+\.go):\d+(?: \+0x[0-9a-f]+)?\s*$/i))) {
      const call = lines[i - 1]!.match(/^([^\s]+)\(.*\)\s*$/);
      if (call) {
        parsed = frame(match[1]!, call[1]!);
      }
    }
    if (parsed) {
      frames.push(parsed);
    }
  }
  return frames;
}
