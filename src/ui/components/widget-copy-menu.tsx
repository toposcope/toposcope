import { Copy } from "lucide-react";
import type { WidgetExportFormat } from "@/export-series";
import type { ReactNode } from "react";
import { WidgetFormatMenu } from "@/components/widget-format-menu";

type Props = {
  disabled?: boolean;
  onCopy: (format: WidgetExportFormat) => void;
  footer?: (close: () => void) => ReactNode;
  header?: (close: () => void) => ReactNode;
};

export function WidgetCopyMenu({ disabled, onCopy, footer, header }: Props) {
  return (
    <WidgetFormatMenu
      disabled={disabled}
      footer={footer}
      header={header}
      title="Copy this panel to the clipboard"
      ariaLabel="Copy this panel to the clipboard"
      onPick={onCopy}
      trigger={
        <Copy className="size-3" aria-hidden />
      }
    />
  );
}
