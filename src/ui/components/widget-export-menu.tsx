import { Download } from "lucide-react";
import type { WidgetExportFormat } from "@/export-series";
import { WidgetFormatMenu } from "@/components/widget-format-menu";

type Props = {
  disabled?: boolean;
  onExport: (format: WidgetExportFormat) => void;
};

export function WidgetExportMenu({ disabled, onExport }: Props) {
  return (
    <WidgetFormatMenu
      disabled={disabled}
      title="Export this panel"
      ariaLabel="Export this panel"
      onPick={onExport}
      trigger={<Download className="size-[13px]" />}
    />
  );
}
