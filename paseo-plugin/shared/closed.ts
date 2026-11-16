// A session's closed cards as the agent detail lists them: the Tree's kind tag and line, and what
// happened to the card. Pure, shared by the view and the tests.
import { cardNodeLine, type CardNodeLine } from "./agent-diagram.ts";
import { cardCounts, countsLine } from "./cards.ts";
import type { QueueCard } from "./rpc.ts";

/**
 * The card's tag and line as the Tree draws it. An older multi-item card's line counts its items as
 * filed, since every item on a closed card is resolved and the Tree counts only open ones.
 */
export function closedLine(card: QueueCard): CardNodeLine {
  const line = cardNodeLine(card);
  if (line.kind) return line;
  const asFiled = <T extends { resolved: boolean; dropped?: boolean }>(items: T[]) =>
    items.filter((item) => !item.dropped).map((item) => ({ ...item, resolved: false }));
  const counts = cardCounts({ ...card, asks: asFiled(card.asks), results: asFiled(card.results), receipts: asFiled(card.receipts) });
  return { ...line, text: countsLine(counts) };
}

/**
 * What happened to a closed card: `→ Relax` (Send; picks joined with ` · `, then ` · reply` when a reply
 * went with them; `Replied` for a reply alone), `Seen`, `Dismissed`, `→ Accept` (a permission, whose kind tag says so); without a
 * record, `Replaced`, `By agent`, or `You` (closed by the user before closes were recorded).
 */
export function closedOutcome(card: Pick<QueueCard, "closing" | "supersededBy" | "doneBy">): string {
  const closing = card.closing;
  if (closing) {
    const labels = (closing.picks ?? []).map((pick) => pick.label).join(" · ");
    switch (closing.via) {
      case "send":
        if (!labels) return "Replied";
        return closing.reply ? `→ ${labels} · reply` : `→ ${labels}`;
      case "seen":
        return "Seen";
      case "dismiss":
        return "Dismissed";
      case "permission":
        return labels ? `→ ${labels}` : "Permission";
    }
  }
  if (card.supersededBy) return "Replaced";
  return card.doneBy === "user" ? "You" : "By agent";
}

/** Seen tells the session nothing, so a card the user closed with it can be reopened; no other close can. */
export const reopenable = (card: Pick<QueueCard, "closing" | "doneBy">): boolean =>
  card.doneBy === "user" && card.closing?.via === "seen";
