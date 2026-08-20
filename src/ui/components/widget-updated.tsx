import { liveUpdatedLabel } from "../live-updated";

type Props = {
  fetchedAt: number | undefined;
  now: number;
};

export function WidgetUpdated({ fetchedAt, now }: Props) {
  const label = liveUpdatedLabel(fetchedAt, now);
  if (!label) {
    return null;
  }
  return (
    <span
      className="px-1 font-mono text-[11px] text-muted-foreground"
      title={`Last updated ${label} ago`}
    >
      {label}
    </span>
  );
}
