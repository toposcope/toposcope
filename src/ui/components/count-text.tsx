import { formatFieldCount, useCountFormat } from "@/count-format";

type Props = {
  n: number;
  className?: string;
};

export function CountText({ n, className }: Props) {
  const format = useCountFormat();
  const label = formatFieldCount(n, format);
  const raw = Math.round(n).toLocaleString("en-US");
  return (
    <span
      className={className}
      title={format === "human" && label !== raw ? raw : undefined}
    >
      {label}
    </span>
  );
}
