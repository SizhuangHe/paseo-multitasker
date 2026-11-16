// Send: the user's answer and reply go into the card's session as one message, as if the user had
// typed it there. A card holds one thing for the user, so Send answers that one ask (or replies to that
// result) and closes only that card, done by the user; the session's other cards stay. Older cards
// with several items send every pick at once and close with all of them (open permission requests excepted).
import { QueueInputError } from "agent-queue-core";
import type { Card, CloseOrigin, ClosingInput, Queue } from "agent-queue-core";
import {
  askChoices,
  askKind,
  composeAnswerMessage,
  composeDiscussMessage,
  composeSkipMessage,
  openAgentAsks,
  questionLine,
  recommendedChoice,
  type Picks,
} from "../shared/cards.ts";

export interface AnswerDeps {
  queue: Queue;
  /** Sends text into a Paseo session as a user message. */
  send(sessionId: string, text: string): Promise<void>;
}

/** Checks the picks and reply against the card. */
function checkAnswer(card: Card, picks: Picks, reply: string): void {
  const ids = Object.keys(picks);
  if (card.state !== "open") throw new QueueInputError(["This card is already closed"]);
  if (!ids.length && !reply.trim()) throw new QueueInputError(["Nothing to send: pick an answer or write a reply"]);
  const issues: string[] = [];
  for (const id of ids) {
    const ask = card.asks.find((candidate) => candidate.id === id && !candidate.dropped);
    const index = picks[id];
    if (!ask) issues.push(`${id} is not on this card`);
    else if (ask.resolved) issues.push(`${id} is already answered`);
    else if (askKind(ask) === "plain") issues.push(`${id} has no options; answer in the session`);
    else if (!Number.isInteger(index) || index < 0 || index >= askChoices(ask).length) issues.push(`${id} has no option ${index + 1}`);
  }
  if (issues.length) throw new QueueInputError(issues);
}

/** What Send records on the card: each pick with its label and whether it was the recommended one, and the reply. */
function sendClosing(card: Card, picks: Picks, reply: string, origin: CloseOrigin): ClosingInput {
  const chosen = Object.entries(picks).flatMap(([askId, index]) => {
    const ask = card.asks.find((candidate) => candidate.id === askId);
    const label = ask ? askChoices(ask)[index]?.label : undefined;
    return ask && label !== undefined ? [{ askId, short: questionLine(ask), label, recommended: recommendedChoice(ask) === index }] : [];
  });
  const text = reply.trim();
  return { via: "send", ...origin, ...(chosen.length ? { picks: chosen } : {}), ...(text ? { reply: text } : {}) };
}

/** Sends the answers and reply, then closes the card. Returns the card as it is afterwards. */
export async function answerCard(deps: AnswerDeps, cardId: string, picks: Picks, reply = "", origin: CloseOrigin = {}): Promise<Card> {
  const card = deps.queue.get(cardId);
  if (!card) throw new QueueInputError([`unknown card ${cardId}`]);
  checkAnswer(card, picks, reply);
  await deps.send(card.sessionId, composeAnswerMessage(card, picks, reply));
  // The session may have closed the card while the message was on its way; the answers are sent either way.
  const now = deps.queue.get(cardId);
  return now && now.state === "open" ? deps.queue.handBack(cardId, sendClosing(card, picks, reply, origin)) : (now ?? card);
}

/**
 * Dismiss and Seen: close the card. A Paseo ask card first tells its session the ask was skipped (an
 * older card names every open ask); if that send fails, the error propagates and the card stays open.
 * Results, receipts and errors close silently. Open permission requests stay open (the session is
 * blocked on them), and so does an older card holding one until it is answered.
 */
export async function dismissCard(deps: AnswerDeps, cardId: string, origin: CloseOrigin = {}): Promise<Card> {
  const card = deps.queue.get(cardId);
  if (!card) throw new QueueInputError([`unknown card ${cardId}`]);
  if (card.state !== "open") return card;
  const message = composeSkipMessage(card);
  if (message) await deps.send(card.sessionId, message);
  const now = deps.queue.get(cardId);
  const via = openAgentAsks(card.asks).length ? "dismiss" : "seen";
  return now && now.state === "open" ? deps.queue.handBack(cardId, { via, ...origin }) : (now ?? card);
}

export interface DiscussDeps extends AnswerDeps {
  /** Discusses still on their way, by card id (one map per plugin process). */
  pending?: Map<string, Promise<unknown>>;
}

/**
 * Discuss: the user wants to talk the card over in its session first. One message asks the agent to
 * explain it in plain words and wait; then the card is tagged `discussingAt` and stays open (the agent
 * closes it once the user decides there). On a card already tagged nothing is sent again, nor while a
 * Discuss on it is still on its way (Paseo can take tens of seconds to take a message): that call waits
 * for the first and shares its outcome. If the send fails, the error propagates and the card stays
 * untagged. `sent` says whether this call sent the message.
 */
export async function discussCard(deps: DiscussDeps, cardId: string): Promise<{ card: Card; sent: boolean }> {
  const card = deps.queue.get(cardId);
  if (!card) throw new QueueInputError([`unknown card ${cardId}`]);
  if (card.state !== "open") throw new QueueInputError(["This card is already closed"]);
  const message = composeDiscussMessage(card);
  if (message === null) throw new QueueInputError(["Permission requests, failed turns and older cards have no Discuss"]);
  if (card.discussingAt) return { card, sent: false };
  const running = deps.pending?.get(cardId);
  if (running) {
    await running;
    return { card: deps.queue.get(cardId) ?? card, sent: false };
  }
  const sending = deps.send(card.sessionId, message);
  deps.pending?.set(cardId, sending);
  try {
    await sending;
  } finally {
    deps.pending?.delete(cardId);
  }
  return { card: deps.queue.markDiscussing(cardId), sent: true };
}

/** Reply: the user's text goes into an agent's session as a user message, for an agent with no card to answer. */
export async function replyToAgent(deps: Pick<AnswerDeps, "send">, agentId: string, text: string): Promise<void> {
  const message = text.trim();
  if (!message) throw new QueueInputError(["Nothing to send: write a reply"]);
  if (!agentId) throw new QueueInputError(["Unknown agent"]);
  await deps.send(agentId, message);
}
