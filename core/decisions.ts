// The user's closed asks as a decision log: when, what was asked, what was picked. Pure: the CLI reads the store and prints.
// Permission asks (host tool-use requests) are left out: they are approvals, not decisions about the work.
import { cardKind, dayKey, STATS_TIME_ZONE } from "./stats.ts";
import type { Card } from "./types.ts";

export interface DecisionRow {
  id: string;
  /** ISO time the card closed. */
  closedAt: string;
  /** Local day and `MM/DD HH:mm` of that time. */
  day: string;
  when: string;
  topic: string | null;
  short: string;
  question: string;
  options: string[];
  /** Label of the option the agent recommended, when it named one. */
  recommended: string | null;
  /** send, seen, dismiss, permission; null on a card closed before closes were recorded. */
  via: string | null;
  /** Labels the user picked; empty when none are recorded. */
  picks: string[];
  reply: string | null;
  /** Where in the Agents screen the close came from; null on a close from before it was recorded. */
  compact: boolean | null;
  view: "tree" | "columns" | "list" | null;
  batch: boolean;
  /** One phrase: the picks, the reply, or how the card closed. */
  outcome: string;
}

const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: STATS_TIME_ZONE, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** `MM/DD HH:mm` of an instant in local time. */
export function localWhen(iso: string): string {
  const p = Object.fromEntries(timeFormat.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** What the record says happened to the card; never a pick it does not hold. */
function outcomeOf(card: Card): string {
  const closing = card.closing;
  const discussed = card.discussingAt ? " · discussed" : "";
  if (closing) {
    const picks = (closing.picks ?? []).map((pick) => (pick.recommended ? `${pick.label} (recommended)` : pick.label)).join(" · ");
    const reply = closing.reply?.trim() ? `reply: ${closing.reply.trim().replace(/\s+/g, " ")}` : "";
    if (closing.via === "send") return ([picks, reply].filter(Boolean).join(" · ") || "sent") + discussed;
    if (closing.via === "seen") return `seen${discussed}`;
    if (closing.via === "dismiss") return `dismissed${discussed}`;
    return `${picks || "permission"}${discussed}`;
  }
  if (card.supersededBy) return "superseded";
  if (card.doneBy === "agent") return `closed by agent${discussed}`;
  return `closed by user, pick not recorded${discussed}`;
}

/** Closed asks (not permission asks or failed turns the host filed), newest first; `since` is a local day, `topic` a case-insensitive substring. */
export function selectDecisions(cards: Card[], options: { since?: string | null; topic?: string | null } = {}): DecisionRow[] {
  const topic = options.topic?.toLowerCase();
  const rows: DecisionRow[] = [];
  for (const card of cards) {
    if (card.state !== "done" || !card.doneAt || cardKind(card) !== "ask") continue;
    if (options.since && dayKey(card.doneAt) < options.since) continue;
    if (topic && !(card.topic ?? "").toLowerCase().includes(topic)) continue;
    const asks = card.asks.filter((a) => !a.dropped && !a.id.startsWith("err:"));
    if (!asks.length) continue;
    const first = asks[0];
    const options_ = first?.options?.map((o) => o.label) ?? [];
    rows.push({
      id: card.id,
      closedAt: card.doneAt,
      day: dayKey(card.doneAt),
      when: localWhen(card.doneAt),
      topic: card.topic,
      short: asks.map((a) => a.short ?? a.question).join(" / "),
      question: first?.question ?? "",
      options: options_,
      recommended: first?.recommended === undefined ? null : (options_[first.recommended] ?? null),
      via: card.closing?.via ?? null,
      picks: (card.closing?.picks ?? []).map((pick) => pick.label),
      reply: card.closing?.reply?.trim() || null,
      compact: card.closing?.compact ?? null,
      view: card.closing?.view ?? null,
      batch: card.closing?.batch === true,
      outcome: outcomeOf(card),
    });
  }
  return rows.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
}

/** One line per decision, a blank line between days. */
export function formatDecisions(rows: DecisionRow[]): string {
  const out: string[] = [];
  let day = "";
  for (const row of rows) {
    if (day && row.day !== day) out.push("");
    day = row.day;
    out.push(`${row.when}  ${row.topic ?? "-"} · ${row.short} → ${row.outcome}`);
  }
  return out.join("\n");
}
