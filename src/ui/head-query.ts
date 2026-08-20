import type { WidgetDef } from "../shared/widgets";
import { seriesPickFromWidget, seriesSelectValue } from "./agg-picker";

export type HeadOption = {
  value: string;
  label: string;
  used: boolean;
};

export function rankHeadOptions(
  items: Array<{ value: string; label: string }>,
  selected: string,
  used: readonly string[],
): HeadOption[] {
  const spent = new Set(used);
  return items
    .map((item) => ({
      ...item,
      used: spent.has(item.value) && item.value !== selected,
    }))
    .sort((a, b) => Number(a.used) - Number(b.used));
}

export function usedCanvasSeriesValues(
  widgets: WidgetDef[],
  exceptId: string,
): string[] {
  return widgets
    .filter((widget) => widget.id !== exceptId && widget.kind !== "hbar")
    .map((widget) =>
      seriesSelectValue(
        seriesPickFromWidget(
          widget.agg === "count" ? null : widget.agg,
          widget.metric,
        ),
      ),
    );
}

export function usedCanvasFieldValues(
  widgets: WidgetDef[],
  exceptId: string,
): string[] {
  return widgets
    .filter((widget) => widget.id !== exceptId)
    .map((widget) =>
      widget.kind === "hbar" ? (widget.attr ?? widget.split) : widget.split,
    );
}
