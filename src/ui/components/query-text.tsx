import { tokenizeQuery } from "../../query/compile";
import { TOKEN_COLOR } from "./search-query-field";

/** A `q` read, not edited: coloured as the search bar colours it. */
export function QueryText({ q, className }: { q: string; className?: string }) {
  return (
    <span className={`font-mono whitespace-pre ${className ?? ""}`}>
      {tokenizeQuery(q).map((token, i) => (
        <span key={`${token.at}:${i}`} style={{ color: TOKEN_COLOR[token.t] }}>
          {token.text}
        </span>
      ))}
    </span>
  );
}
