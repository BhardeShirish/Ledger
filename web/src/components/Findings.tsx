import { Badge } from "./ui";

export type Finding = {
  severity: "act" | "watch" | "good" | "info";
  title: string;
  detail: string;
};

const TONE = {
  act: "bad", watch: "warn", good: "good", info: "neutral",
} as const;

const WORD = {
  act: "Act on this", watch: "Keep an eye", good: "Going well", info: "For info",
} as const;

/**
 * The server sorts these worst-first, so the list is read top down and the
 * order is never re-decided here.
 */
export function FindingList({ findings }: { findings: Finding[] }) {
  return (
    <ul className="space-y-2">
      {findings.map((f, i) => (
        <li key={i}
            className="rounded-md border border-rule-strong bg-paper-2 px-3 py-2.5">
          <div className="flex flex-wrap items-start gap-2">
            <Badge tone={TONE[f.severity] ?? "neutral"}>{WORD[f.severity]}</Badge>
            <span className="font-semibold">{f.title}</span>
          </div>
          <p className="mt-1 text-sm text-ink-soft">{f.detail}</p>
        </li>
      ))}
    </ul>
  );
}
