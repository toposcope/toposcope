import { cn } from "@/lib/utils";
import {
  inspectTabCloseTitle,
  inspectTabKey,
  inspectTabLabel,
  inspectTabTitle,
  sameInspectTab,
  type InspectTab,
} from "../inspect-tabs";

type Props = {
  tabs: InspectTab[];
  active: InspectTab | null;
  resultsLabel?: string;
  alwaysShow?: boolean;
  onResults: () => void;
  onSelect: (tab: InspectTab) => void;
  onClose: (index: number) => void;
};

function tabWrap(on: boolean): string {
  return cn(
    "flex h-[27px] items-center gap-px rounded-t-[5px] border-b-0 py-0 pr-1 pl-2.5",
    on ? "border border-white/10 bg-card" : "border border-transparent",
  );
}

function tabText(on: boolean): string {
  return cn(
    "border-0 bg-transparent p-0 font-mono text-[11.5px] whitespace-nowrap",
    on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
  );
}

export function ContextTabs({
  tabs,
  active,
  resultsLabel = "Results",
  alwaysShow = false,
  onResults,
  onSelect,
  onClose,
}: Props) {
  if (tabs.length === 0 && !alwaysShow) {
    return null;
  }
  const resultsOn = active === null;
  return (
    <div className="-mb-px flex items-end gap-0.5 px-3 pt-0.5">
      <span className={tabWrap(resultsOn)}>
        <button type="button" className={tabText(resultsOn)} onClick={onResults}>
          {resultsLabel}
        </button>
      </span>
      {tabs.map((tab, i) => {
        const on = sameInspectTab(active, tab);
        return (
          <span key={inspectTabKey(tab)} className={tabWrap(on)}>
            <button
              type="button"
              title={inspectTabTitle(tab)}
              className={tabText(on)}
              onClick={() => onSelect(tab)}
            >
              {inspectTabLabel(tab)}
            </button>
            <button
              type="button"
              title={inspectTabCloseTitle(tab)}
              className="flex size-4 items-center justify-center rounded-[2.4px] text-[13px] leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onClose(i)}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}
