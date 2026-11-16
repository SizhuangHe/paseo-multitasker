// The state color a card's kind carries on its tag and in a tile footer: one meaning per color.
// Amber waits on the user's decision, green came back fine (or runs), red failed, muted is quiet.
import type { CardNodeKind, CardNodeLine } from "./agent-diagram.ts";

export type Tone = "warning" | "success" | "danger" | "muted";

/** A card line's tag tone: decide, approve and permission amber; review and returned green; error, and a returned whose receipt failed, red. No kind (an older multi-item card): muted. */
export function lineTone(line: Pick<CardNodeLine, "kind" | "tone">): Tone {
  const kind: CardNodeKind | null = line.kind;
  if (kind === "error" || (kind === "returned" && line.tone === "danger")) return "danger";
  if (kind === "decide" || kind === "approve" || kind === "permission") return "warning";
  if (kind === "review" || kind === "returned") return "success";
  return "muted";
}

/** A Needs you tile footer label's tone (`Error` red, `Permission` and `Decide` amber, `Review` and `Returned` green, `Idle` muted); null for any other label. */
export function labelTone(label: string): Tone | null {
  if (label === "Error") return "danger";
  if (label === "Permission" || label === "Decide") return "warning";
  if (label === "Review" || label === "Returned") return "success";
  if (label === "Idle") return "muted";
  return null;
}
