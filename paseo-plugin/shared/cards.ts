// Card helpers shared by the card components and the plugin server: the card title, how an ask is
// answered (its kind and choices), which cards have Discuss, and the messages the queue sends into
// the session. Those messages are conversation text in the user's voice, not UI: Chinese when the
// card's own text (what the message quotes) has CJK characters, English otherwise.
// Structural types, so both core cards and RPC cards fit.

export interface ChoiceLike {
  label: string;
  effect?: string;
}

export interface AskLike {
  id: string;
  question: string;
  short?: string;
  options?: ChoiceLike[];
  recommended?: number;
  recommendation?: string;
  resolved: boolean;
  dropped?: boolean;
}

export interface CardLike {
  sessionId: string;
  sessionTitle: string | null;
  topic: string | null;
  asks: AskLike[];
  results: { id: string; label: string; resolved: boolean; dropped?: boolean }[];
  receipts: { id: string; title: string; resolved: boolean }[];
}

/** What a card holds: one ask, result or receipt (`item`), or null for an older card with several. */
export type SingleItem<C extends CardLike> =
  | { kind: "ask"; item: C["asks"][number] }
  | { kind: "result"; item: C["results"][number] }
  | { kind: "receipt"; item: C["receipts"][number] };

/** The one item a card holds; null for older multi-item cards (and cards with none). Replaced items do not count. */
export function singleItem<C extends CardLike>(card: C): SingleItem<C> | null {
  const asks = card.asks.filter((ask) => !ask.dropped);
  const results = card.results.filter((result) => !result.dropped);
  if (asks.length + results.length + card.receipts.length !== 1) return null;
  if (asks.length) return { kind: "ask", item: asks[0] };
  if (results.length) return { kind: "result", item: results[0] };
  return { kind: "receipt", item: card.receipts[0] };
}

/** An ask the agent wrote (q1, q2, …), not one the host filed (`perm:`, `err:`). */
export const isAgentAsk = (ask: { id: string }) => /^q\d+$/.test(ask.id);

/** A host permission request (`perm:…`): answered on the card right away, apart from Send. */
export const isPermissionAsk = (ask: { id: string }) => ask.id.startsWith("perm:");

/** A failed turn the host filed (`err:…`). */
export const isErrorAsk = (ask: { id: string }) => ask.id.startsWith("err:");

/** An ask the host filed (a permission request or a failed turn), not the agent. */
export const isHostAsk = (ask: { id: string }) => isPermissionAsk(ask) || isErrorAsk(ask);

/** A host ask as one line: the request or the error, without its `Permission:` / `Error:` prefix. */
export function hostAskLine(ask: { question: string }): string {
  return ask.question.replace(/^(Permission:|Error:)\s*/, "");
}

/** The request's own sentences, as the card shows them: `Permission: <line>`. */
interface PermissionText {
  question: string;
  permission?: { detail?: string };
}

interface QuestionLike {
  header: string;
  question: string;
  options: string[];
}

/**
 * Whether a question request's question still needs saying: one the card's own line already asks does
 * not (the title asks it, the chips answer it); several questions each say their own.
 */
export function asksQuestion(
  ask: PermissionText & { permission?: { questions?: QuestionLike[] } },
  question: QuestionLike,
): boolean {
  if ((ask.permission?.questions?.length ?? 0) > 1) return true;
  return !collapse(hostAskLine(ask)).includes(collapse(question.question));
}

/**
 * A permission request in full, as it will run: the detail's lines verbatim (indentation, blank lines and
 * all), except a line that is exactly what the card's own line already shows (the line itself or one of
 * its ` · ` parts, trimmed at the ends) or, on a question request, the option list the chips show. No
 * substring matching: a command's `fi` stays. Null when nothing is left.
 */
export function permissionDetail(ask: PermissionText & { permission?: { questions?: QuestionLike[] } }): string | null {
  const detail = ask.permission?.detail;
  if (!detail?.trim()) return null;
  const line = hostAskLine(ask).trim();
  const shown = new Set([line, ...line.split(" · ").map((part) => part.trim())].filter(Boolean));
  for (const question of ask.permission?.questions ?? []) {
    if (question.options.length) shown.add(question.options.join(" / "));
  }
  const kept = detail.split("\n").filter((text) => !shown.has(text.trim()));
  while (kept.length && !kept[0].trim()) kept.shift();
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.length ? kept.join("\n") : null;
}

/**
 * What a card holds, as the screen shows it: an agent ask, a permission request, a failed turn, a
 * result or a receipt; `list` for older cards that hold several items.
 */
export type CardKind = "ask" | "permission" | "error" | "result" | "receipt" | "list";

export function cardKind(card: CardLike): CardKind {
  const single = singleItem(card);
  if (!single) return "list";
  if (single.kind !== "ask") return single.kind;
  if (isPermissionAsk(single.item)) return "permission";
  return isErrorAsk(single.item) ? "error" : "ask";
}

/**
 * The cards `Mark N returned as seen` closes: an agent's receipts, from two up (a lone one has its own Seen).
 * Results stay out, since they ask the user to look at something.
 */
export function seenReturned<C extends CardLike>(cards: readonly C[]): C[] {
  const receipts = cards.filter((card) => cardKind(card) === "receipt");
  return receipts.length >= 2 ? receipts : [];
}

/**
 * Unresolved items by what they ask of the user: permission requests, decide (think), approve (nod),
 * review (look), returned (receipts).
 */
export interface CardCounts {
  permission: number;
  think: number;
  nod: number;
  look: number;
  receipts: number;
}

export function cardCounts(card: CardLike): CardCounts {
  const asks = card.asks.filter((ask) => !ask.resolved);
  return {
    permission: asks.filter(isPermissionAsk).length,
    think: asks.filter((ask) => !isPermissionAsk(ask) && askKind(ask) !== "nod").length,
    nod: asks.filter((ask) => askKind(ask) === "nod").length,
    look: card.results.filter((result) => !result.resolved).length,
    receipts: card.receipts.filter((receipt) => !receipt.resolved).length,
  };
}

/** `1 permission · 2 decide · 3 approve · 1 review · 1 returned`, zeros left out. */
export function countsLine(n: CardCounts): string {
  return [
    n.permission ? `${n.permission} permission` : "",
    n.think ? `${n.think} decide` : "",
    n.nod ? `${n.nod} approve` : "",
    n.look ? `${n.look} review` : "",
    n.receipts ? `${n.receipts} returned` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Card title: the agent's topic. Cards the host created (permission, failure, receipts) and
 * cards filed before topics existed fall back to the Paseo title, then the dispatched work.
 */
export function cardTitle(card: CardLike): string {
  return (
    card.topic?.trim() ||
    card.sessionTitle?.trim() ||
    card.receipts[0]?.title.trim() ||
    card.sessionId.slice(0, 8)
  );
}

/** What the user can pick: the agent's options, or an old free-text recommendation as one option. */
export function askChoices(ask: AskLike): ChoiceLike[] {
  if (ask.options?.length) return ask.options;
  if (ask.recommendation) return [{ label: ask.recommendation }];
  return [];
}

/** Index of the recommended choice, or null when the agent recommends none. */
export function recommendedChoice(ask: AskLike): number | null {
  if (ask.options?.length) {
    const index = ask.recommended;
    return index !== undefined && index >= 0 && index < ask.options.length ? index : null;
  }
  return ask.recommendation ? 0 : null;
}

/**
 * think (Decide): choices, none recommended. nod (Approve): a recommended choice, preselected.
 * plain: nothing to pick (host asks, old asks without a recommendation); answered in the session.
 */
export type AskKind = "think" | "nod" | "plain";

export function askKind(ask: AskLike): AskKind {
  if (!askChoices(ask).length) return "plain";
  return recommendedChoice(ask) === null ? "think" : "nod";
}

/** Asks in screen order: Decide (think and plain) first, then Approve (nod), each in filing order. */
export function screenOrder<T extends AskLike>(asks: readonly T[]): T[] {
  return [...asks.filter((ask) => askKind(ask) !== "nod"), ...asks.filter((ask) => askKind(ask) === "nod")];
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The question as one line: `short`, or for old asks the question cut to 40 characters. */
export function questionLine(ask: AskLike): string {
  if (ask.short?.trim()) return collapse(ask.short);
  const chars = [...collapse(ask.question)];
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : chars.join("");
}

/**
 * The question a card's detail shows under its title: the full question, or null when the title already
 * is it. The title is `short` or the question cut to 40 characters, so an ask filed without `short` (the
 * CLI, which leaves it optional) would otherwise never show the rest of what it asks.
 */
export function detailQuestion(ask: AskLike): string | null {
  const question = ask.question.trim();
  return collapse(question) === questionLine(ask) ? null : question;
}

/** Picks: ask id → index into `askChoices(ask)`. */
export type Picks = Record<string, number>;

/** The agent's own asks still open on the card (not host asks, not replaced ones). */
export function openAgentAsks<T extends AskLike>(asks: readonly T[]): T[] {
  return asks.filter((ask) => !ask.resolved && !ask.dropped && isAgentAsk(ask));
}

/** `question → label (recommended)`, the way a pick reads in the message. */
function pickLine(ask: AskLike, index: number): string {
  const label = collapse(askChoices(ask)[index]?.label ?? "");
  const recommended = recommendedChoice(ask) === index ? " (recommended)" : "";
  return `${questionLine(ask)} → ${label}${recommended}`;
}

/**
 * The message Send puts into the session, which closes the card. A card holding one ask sends the
 * question with the pick (or just the question when the user only wrote a reply), then the reply:
 *
 *   (Answered "release notes" from the queue; this card is closed.)
 *   Relax the release check? → Not yet (recommended)
 *   <the user's reply>
 *
 * A result or receipt card sends the reply under a header naming it. Older multi-item cards send one
 * line per picked ask, then the asks left unanswered, then the reply (`composeListAnswer`).
 */
export function composeAnswerMessage(card: CardLike, picks: Picks, reply = ""): string {
  const text = reply.trim();
  const single = singleItem(card);
  const title = cardTitle(card);
  if (single?.kind === "ask" && isAgentAsk(single.item)) {
    const ask = single.item;
    const index = picks[ask.id];
    const line = typeof index === "number" ? pickLine(ask, index) : questionLine(ask);
    const head = `(Answered "${title}" from the queue; this card is closed.)`;
    return [head, line, ...(text ? [text] : [])].join("\n");
  }
  if (single?.kind === "result") {
    const label = single.item.label;
    const head = `(Replied from the queue to the result "${label}" on "${title}"; this card is closed.)`;
    return [head, ...(text ? [text] : [])].join("\n");
  }
  if (single?.kind === "receipt") {
    const name = single.item.title;
    const head = `(Replied from the queue to the receipt "${name}" on "${title}"; this card is closed.)`;
    return [head, ...(text ? [text] : [])].join("\n");
  }
  return composeListAnswer(card, picks, text);
}

/**
 * Send on an older multi-item card: it lists the picks, names the asks left unanswered, and ends with
 * the user's reply, if any:
 *
 *   (Answered the "release notes" card from the queue; this card is closed.)
 *   q2 Relax the release check? → Not yet (recommended)
 *   Not answered: q3 Ship on Friday?; ask again next time if needed.
 *   <the user's reply>
 */
function composeListAnswer(card: CardLike, picks: Picks, text: string): string {
  const order = screenOrder(openAgentAsks(card.asks));
  const title = cardTitle(card);
  const lines = order.filter((ask) => typeof picks[ask.id] === "number").map((ask) => `${ask.id} ${pickLine(ask, picks[ask.id])}`);
  const unanswered = order.filter((ask) => typeof picks[ask.id] !== "number");
  if (unanswered.length) {
    const list = unanswered.map((ask) => `${ask.id} ${questionLine(ask)}`);
    lines.push(`Not answered: ${list.join(", ")}; ask again next time if needed.`);
  }
  const head = `(Answered the "${title}" card from the queue; this card is closed.)`;
  return [head, ...lines, ...(text ? [text] : [])].join("\n");
}

/**
 * The card's one line, as Discuss names it: an agent ask's `short` (else its question cut to 40
 * characters), a result's label, a receipt's title. Null for permission requests, failed turns and
 * older multi-item cards, which have no Discuss.
 */
export function discussLine(card: CardLike): string | null {
  const single = singleItem(card);
  if (!single) return null;
  if (single.kind === "ask") return isAgentAsk(single.item) ? questionLine(single.item) : null;
  return collapse(single.kind === "result" ? single.item.label : single.item.title);
}

/** Discuss is on Paseo agent cards (asks, results, receipts); not on host requests or older cards. */
export function discussable(card: CardLike & { host: string }): boolean {
  return card.host === "paseo" && discussLine(card) !== null;
}

/**
 * The message Discuss puts into the session: the user wants to talk the card over before acting on it,
 * so the agent explains it in plain words (an ask with its options' trade-offs) and waits. Null on
 * cards without Discuss.
 *
 *   (From the queue: I want to talk through "<line>" before deciding. Explain the background and each
 *   option's trade-offs in a few plain sentences, then wait for me.)
 */
export function composeDiscussMessage(card: CardLike): string | null {
  const line = discussLine(card);
  if (line === null) return null;
  const ask = singleItem(card)?.kind === "ask";
  return ask
    ? `(From the queue: I want to talk through "${line}" before deciding. Explain the background and each option's trade-offs in a few plain sentences, then wait for me.)`
    : `(From the queue: I want to talk through "${line}". Explain the background in a few plain sentences, then wait for me.)`;
}

/**
 * The message Dismiss puts into the session when the card still has an open ask: that the user skipped
 * it and the agent should not wait on it. Null when there is none (Dismiss is silent).
 *
 *   (Skipped "<title>" from the queue: <question>. No need to wait on me; if I really need to decide,
 *   ask again separately.)
 */
export function composeSkipMessage(card: CardLike): string | null {
  const single = singleItem(card);
  if (single) {
    if (single.kind !== "ask" || !openAgentAsks([single.item]).length) return null;
    const question = questionLine(single.item);
    const stop = /[?.!\uff1f\uff01\u3002]$/.test(question) ? "" : ".";
    return `(Skipped "${cardTitle(card)}" from the queue: ${question}${stop} No need to wait on me; if I really need to decide, ask again separately.)`;
  }
  const skipped = screenOrder(openAgentAsks(card.asks));
  if (!skipped.length) return null;
  const items = skipped.map((ask) => `${ask.id} ${questionLine(ask)}`);
  const list = items.join("; ");
  const stop = /[?.!\uff1f\uff01\u3002]$/.test(list) ? "" : ".";
  return `(Skipped the "${cardTitle(card)}" card from the queue, not answered: ${list}${stop} No need to wait on me for these; if I really need to decide, ask again separately.)`;
}
