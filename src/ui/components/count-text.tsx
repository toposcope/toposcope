import { formatFieldCount, useCountFormat } from "@/count-format";

type Props = {
  n: number;
  className?: string;
  /** A count a short source could still feed (#139): at least this many. */
  floor?: boolean;
};

export function CountText({ n, className, floor = false }: Props) {
  const format = useCountFormat();
  const label = formatFieldCount(n, format);
  const raw = Math.round(n).toLocaleString("en-US");
  return (
    <span
      className={className}
      title={
        format === "human" && label !== raw
          ? `${floor ? "at least " : ""}${raw}`
          : floor
            ? "At least this many: a source is short over this window"
            : undefined
      }
    >
      {floor ? "≥" : ""}
      {label}
    </span>
  );
}
