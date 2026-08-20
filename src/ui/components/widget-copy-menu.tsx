import type { WidgetExportFormat } from "@/export-series";
import { WidgetFormatMenu } from "@/components/widget-format-menu";

type Props = {
  disabled?: boolean;
  onCopy: (format: WidgetExportFormat) => void;
};

export function WidgetCopyMenu({ disabled, onCopy }: Props) {
  return (
    <WidgetFormatMenu
      disabled={disabled}
      title="Copy this panel to the clipboard"
      ariaLabel="Copy this panel to the clipboard"
      onPick={onCopy}
      trigger={
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      }
    />
  );
}
