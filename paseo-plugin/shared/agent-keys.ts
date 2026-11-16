// Desktop keyboard triage of the Agents screen, pure so the screen and the tests share it: the order the
// open cards are visited in (the order the current view lists them) and what a key does. The screen's
// listener only dispatches the action this returns.
import { boardColumns } from "./agent-columns.ts";
import { cardNodeOrder } from "./agent-diagram.ts";
import type { AgentForest, AgentNode } from "./agent-tree.ts";
import type { CardKind } from "./cards.ts";

export interface CardStop {
  agentId: string;
  cardId: string;
}

export interface Folds {
  agent(agentId: string): boolean;
  workspace(name: string): boolean;
}

/**
 * Every open card of the Needs you agents that is on screen, in the order the view lists them: Tree and
 * List walk the forest depth first, Columns the Needs you column; each agent's cards in the Tree's card
 * order. Folds hide what is under them: a folded workspace, and a folded agent's own cards and descendants
 * (the Tree and the List share the agent folds); Columns has no folds.
 */
export function viewOrderCards(forest: AgentForest, view: "tree" | "columns" | "list", folds?: Folds): CardStop[] {
  const stops = (node: AgentNode) => cardNodeOrder(node.cards).map((card) => ({ agentId: node.agent.id, cardId: card.id }));
  if (view === "columns") {
    return (boardColumns(forest).find((column) => column.state === "needs_you")?.nodes ?? []).flatMap(stops);
  }
  const walk = (node: AgentNode): CardStop[] => {
    const folded = folds?.agent(node.agent.id) === true && (node.cards.length > 0 || node.children.length > 0);
    if (folded) return [];
    return [...(node.status.state === "needs_you" ? stops(node) : []), ...node.children.flatMap(walk)];
  };
  return forest.workspaces.flatMap((ws) => (folds?.workspace(ws.name) ? [] : ws.roots.flatMap(walk)));
}

/**
 * The stop after (`1`) or before (`-1`) the open card. With none open (or one not in the order), a selected
 * agent that has stops counts as standing just before its first card: forward enters it, back goes to the
 * card before it. Otherwise the first, or the last going back.
 */
export function stepCard(order: readonly CardStop[], openCardId: string | null, direction: 1 | -1, selectedAgentId: string | null = null): CardStop | null {
  const at = order.findIndex((stop) => stop.cardId === openCardId);
  if (at >= 0) return order[at + direction] ?? null;
  const first = selectedAgentId === null ? -1 : order.findIndex((stop) => stop.agentId === selectedAgentId);
  if (first >= 0) return order[direction === 1 ? first : first - 1] ?? null;
  return (direction === 1 ? order[0] : order[order.length - 1]) ?? null;
}

/** The `nativeID` of a choice chip (RN-web renders it as the `id` attribute); the listener tells these from other buttons by the prefix. */
export const choiceChipId = (cardId: string, askId: string, index: number): string => `aq-choice:${cardId}:${askId}:${index}`;
export const isChoiceChipOf = (id: string | null | undefined, cardId: string | null): boolean => cardId !== null && Boolean(id?.startsWith(`aq-choice:${cardId}:`));

export interface KeyEvent {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  repeat?: boolean;
}

export interface KeyContext {
  /** The focus is in a text field. */
  typing: boolean;
  /** The focus is on a button, link or other control that Enter or a letter would also press. */
  control: boolean;
  /** The focus is on a choice chip of the open card: Enter sends when Send is ready, else the chip picks. */
  choice: boolean;
  /** A dialog (Archive all) is open. */
  dialogOpen: boolean;
  /** The card open in full; null when there is none. */
  card: {
    kind: CardKind;
    /** Options a number key can pick: those of a single agent ask, else 0. */
    choices: number;
    /** Send is enabled: a pick or reply text on an ask or a result. */
    sendReady: boolean;
  } | null;
}

export type KeyAction =
  | { type: "step"; direction: 1 | -1 }
  | { type: "pick"; index: number }
  | { type: "send" }
  | { type: "seen" }
  | { type: "session" }
  | { type: "back" };

/** What a key does on the Agents screen, or null when it is not ours. */
export function keyAction(event: KeyEvent, context: KeyContext): KeyAction | null {
  if (event.meta || event.ctrl || event.alt || context.typing || context.dialogOpen) return null;
  const { key } = event;
  if (key === "j") return { type: "step", direction: 1 };
  if (key === "k") return { type: "step", direction: -1 };
  // The arrows keep scrolling the Tree and the List until a card is open.
  if (key === "ArrowDown" || key === "ArrowUp") return context.card ? { type: "step", direction: key === "ArrowDown" ? 1 : -1 } : null;
  if (key === "Escape") return context.card ? { type: "back" } : null;
  // A held key would send, or mark seen, one card after another.
  if (event.repeat || !context.card) return null;
  const { card } = context;
  if (/^[1-9]$/.test(key)) return Number(key) <= card.choices ? { type: "pick", index: Number(key) - 1 } : null;
  // A focused control presses itself on Enter; a choice chip yields to Send once it is ready.
  if (key === "Enter") return card.sendReady && (!context.control || context.choice) ? { type: "send" } : null;
  if (key === "e") return card.kind === "result" || card.kind === "receipt" || card.kind === "error" ? { type: "seen" } : null;
  if (key === "o") return { type: "session" };
  return null;
}
