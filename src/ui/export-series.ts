import { alignAggBuckets } from "../query/agg";
import { seriesColor } from "./histogram-series";
import type { HistogramBucket, SearchAggResult } from "./types";

export const widgetExportFormats = ["csv", "json", "svg", "png"] as const;
export type WidgetExportFormat = (typeof widgetExportFormats)[number];

export type WidgetSeriesFile = {
  kind: "histogram" | "stat" | "hbar";
  csv: string;
  json: string;
  svg: string;
};

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function seriesKeyUnion(buckets: HistogramBucket[]): string[] {
  const keys = new Set<string>();
  for (const bucket of buckets) {
    for (const key of Object.keys(bucket.series)) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

export function histogramExport(
  buckets: HistogramBucket[],
  agg?: SearchAggResult | null,
): WidgetSeriesFile {
  const keys = seriesKeyUnion(buckets);
  const times = buckets.map((bucket) => bucket.t);
  const includeAgg = Boolean(agg && agg.source !== "refused");
  const aggVals = includeAgg && agg ? alignAggBuckets(times, agg.buckets) : [];
  const aggHeader = includeAgg && agg ? agg.expr : null;
  const header = ["t", "n", ...keys, ...(aggHeader ? [aggHeader] : [])];
  const lines = [header.map(csvCell).join(",")];
  const rows: Array<Record<string, string | number>> = [];
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    if (!bucket) {
      continue;
    }
    const row: Record<string, string | number> = { t: bucket.t, n: bucket.n };
    const cells = [csvCell(bucket.t), String(bucket.n)];
    for (const key of keys) {
      const n = bucket.series[key] ?? 0;
      row[key] = n;
      cells.push(String(n));
    }
    if (aggHeader) {
      const v = aggVals[i];
      if (v === null || v === undefined) {
        row[aggHeader] = "";
        cells.push("");
      } else {
        row[aggHeader] = v;
        cells.push(String(v));
      }
    }
    lines.push(cells.join(","));
    rows.push(row);
  }
  return {
    kind: "histogram",
    csv: `${lines.join("\n")}\n`,
    json: `${JSON.stringify(rows, null, 2)}\n`,
    svg: histogramSvg(buckets, keys),
  };
}

export function statExport(args: {
  series: string;
  value: number | null;
  total: number;
}): WidgetSeriesFile {
  const valueCell = args.value == null ? "" : String(args.value);
  return {
    kind: "stat",
    csv: `series,value,total\n${csvCell(args.series)},${valueCell},${args.total}\n`,
    json: `${JSON.stringify(
      { series: args.series, value: args.value, total: args.total },
      null,
      2,
    )}\n`,
    svg: statSvg(args.series, args.value),
  };
}

export function hbarExport(rows: Array<{ key: string; n: number }>): WidgetSeriesFile {
  const lines = ["key,n", ...rows.map((row) => `${csvCell(row.key)},${row.n}`)];
  return {
    kind: "hbar",
    csv: `${lines.join("\n")}\n`,
    json: `${JSON.stringify(rows, null, 2)}\n`,
    svg: hbarSvg(rows),
  };
}

function svgWrap(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#18181b"/>
${body}
</svg>
`;
}

function histogramSvg(buckets: HistogramBucket[], keys: string[]): string {
  const width = 640;
  const height = 200;
  const pad = { l: 8, r: 8, t: 12, b: 12 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const n = Math.max(1, buckets.length);
  const gap = n > 80 ? 0 : 1;
  const colW = innerW / n;
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.n));
  const parts: string[] = [];
  buckets.forEach((bucket, i) => {
    const x = pad.l + i * colW;
    let y = pad.t + innerH;
    const stack = keys.length > 0 ? keys : ["_"];
    for (let k = 0; k < stack.length; k++) {
      const key = stack[k]!;
      const v = keys.length > 0 ? (bucket.series[key] ?? 0) : bucket.n;
      const h = (v / peak) * innerH;
      if (h <= 0) {
        continue;
      }
      y -= h;
      const color = keys.length > 0 ? seriesColor(key, "level", k) : "#38bdf8";
      parts.push(
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0.5, colW - gap).toFixed(2)}" height="${h.toFixed(2)}" fill="${color}"/>`,
      );
    }
  });
  return svgWrap(width, height, parts.join("\n"));
}

function statSvg(series: string, value: number | null): string {
  const label = value == null ? "—" : String(value);
  return svgWrap(
    480,
    160,
    `<text x="24" y="72" fill="#fafafa" font-family="ui-monospace, Menlo, monospace" font-size="36">${escapeXml(label)}</text>
<text x="24" y="108" fill="#a1a1aa" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">${escapeXml(series)}</text>`,
  );
}

function hbarSvg(rows: Array<{ key: string; n: number }>): string {
  const width = 480;
  const rowH = 22;
  const height = Math.max(80, 16 + rows.length * rowH);
  const peak = Math.max(1, ...rows.map((row) => row.n));
  const parts = rows.map((row, i) => {
    const y = 12 + i * rowH;
    const barW = (row.n / peak) * 280;
    const color = seriesColor(row.key, "service", i);
    return `<text x="12" y="${y + 12}" fill="#a1a1aa" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11">${escapeXml(row.key)}</text>
<rect x="120" y="${y + 4}" width="${barW.toFixed(1)}" height="10" rx="1" fill="${color}"/>
<text x="408" y="${y + 12}" fill="#a1a1aa" font-family="ui-monospace, Menlo, monospace" font-size="11" text-anchor="end">${row.n}</text>`;
  });
  return svgWrap(width, height, parts.join("\n"));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function widgetExportFilename(
  kind: WidgetSeriesFile["kind"],
  format: WidgetExportFormat,
  at = new Date(),
): string {
  const stamp = at.toISOString().slice(0, 19).replaceAll(":", "");
  return `toposcope-${kind}-${stamp}.${format}`;
}

export function widgetSeriesText(
  file: WidgetSeriesFile,
  format: Exclude<WidgetExportFormat, "png">,
): string {
  if (format === "csv") {
    return file.csv;
  }
  if (format === "json") {
    return file.json;
  }
  return file.svg;
}

export async function copyWidgetSeries(
  file: WidgetSeriesFile,
  format: WidgetExportFormat,
): Promise<boolean> {
  try {
    if (format === "png") {
      const blob = await rasterizeSvgPng(file.svg);
      if (!blob || !navigator.clipboard?.write) {
        return false;
      }
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      return true;
    }
    await navigator.clipboard.writeText(widgetSeriesText(file, format));
    return true;
  } catch {
    return false;
  }
}

export function downloadWidgetSeries(
  file: WidgetSeriesFile,
  format: WidgetExportFormat,
): void {
  const name = widgetExportFilename(file.kind, format);
  if (format === "png") {
    void rasterizeSvgPng(file.svg).then((blob) => {
      if (blob) {
        clickDownload(blob, name);
      }
    });
    return;
  }
  const body =
    format === "csv" ? file.csv : format === "json" ? file.json : file.svg;
  const mime =
    format === "csv"
      ? "text/csv"
      : format === "json"
        ? "application/json"
        : "image/svg+xml";
  clickDownload(new Blob([body], { type: mime }), name);
}

function clickDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function rasterizeSvgPng(svg: string, scale = 2): Promise<Blob | null> {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    return Promise.resolve(null);
  }
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, img.width * scale);
      canvas.height = Math.max(1, img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        resolve(null);
        return;
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((out) => {
        URL.revokeObjectURL(url);
        resolve(out);
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}
