// The Tree view's layout, pure so the screen, the harness and the tests share it: workspace → agent →
// child from left to right, siblings stacked. An agent is a tile (client/agent-tile.tsx, without card rows)
// and each of its open cards is a leaf of it, a small node in the column right of it, before its child
// agents: permission requests first, then the longest wait (the inbox's order). A folded agent hides its
// cards and its children and counts what it hides. The tile's height is estimated here from its text at the
// column's width and the view draws it at exactly that height. Every node sits on the row of its first
// child, anchors (where connectors meet) aligned, and each sibling's subtree starts below the one before,
// so nothing overlaps whatever the node heights.
import { subtree, type AgentForest, type AgentNode, type WorkspaceTree } from "./agent-tree.ts";
import { hasTileChips, timesText, type TileTimes } from "./tile-info.ts";
import { askKind, cardCounts, cardKind, countsLine, hostAskLine, isPermissionAsk, questionLine, singleItem } from "./cards.ts";
import type { QueueCard } from "./rpc.ts";

/** Sizes in px. */
export const DIAGRAM = {
  /** The workspace column. */
  W0: 160,
  /** Between levels, where the connectors run. */
  G: 40,
  /** The workspace node: two lines. */
  H: 54,
  ROW_GAP: 10,
  /** Between a card node and the next. */
  CARD_GAP: 6,
  /** Card nodes: one line, or two. */
  CARD_H: [30, 48] as const,
  WS_GAP: 26,
  /** Room right of a folded agent for what it hides. */
  PILL: 140,
  /** A folded agent's deck: the tile under it, this much lower. */
  DECK: 4,
  MIN_W: 260,
  MAX_W: 420,
};

/** The card node's insides, for the client's styles and the line estimate. */
export const CARD_NODE = {
  padX: 9,
  gap: 7,
  font: 12.5,
  line: 17,
  /** The wait at the right edge (`12h`, `3d`). */
  timeW: 26,
  /** The kind tag: per character, and its padding and border. */
  tagChar: 5.9,
  tagPad: 12,
};

/** The tile's insides, for the client's styles and the height estimate. */
export const TILE = {
  /** Body padding, and the gap between its parts. */
  pad: 14,
  gap: 8,
  /** The title: font, line, and what sits left of it (the state mark and its gap), which the chips and rows indent by too. */
  titleFont: 14,
  titleLine: 20,
  indent: 20,
  /** The chip row under the title: one line. */
  chipsH: 20,
  /** Card rows and last lines. */
  font: 12.5,
  line: 17,
  rowGap: 6,
  rowPadY: 2,
  rowPadR: 4,
  /** The `+N more` row. */
  more: 20,
  footer: 40,
  maxCards: 3,
  /** The Tree's tile border, each side; the Board's is a hairline. */
  border: 1,
  /** A connector meets the tile this far below its top: the middle of the title's first line. */
  anchorY: 24,
  /** The kind tag: per character, and its padding and border. */
  tagChar: 5.6,
  tagPad: 11,
  /** A kind tag's height with its top margin; a row with one is at least this tall. */
  tagH: 18,
  /** Between a kind tag and its text. */
  tagGap: 7,
  /** A footer's side padding and the gap between its parts. */
  footerPad: 14,
  footerGap: 10,
  footerFont: 12,
};

// ---- a card as a node or a row -----------------------------------------------------

/** The kind mark: what the card asks of the user. */
export type CardNodeKind = "decide" | "approve" | "review" | "returned" | "permission" | "error";

export interface CardNodeLine {
  /** Null for an older card with several items: its text names the kinds. */
  kind: CardNodeKind | null;
  text: string;
  /** The text's color: a permission request in the warning color, a failure in the danger color. */
  tone: "plain" | "warning" | "danger";
  /** It waits on an answer (an ask, a permission request, a failed turn): the node's border is tinted. */
  ask: boolean;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * A card on the tree: an ask's `short` question (decide, or approve when one choice is recommended), a
 * permission request as `Bash · …` (warning), a failed turn (danger), a result's label (review), a
 * receipt's `line` or else its title (returned; a failed one in the danger color), an older multi-item
 * card's counts (`2 decide · 3 review`).
 */
export function cardNodeLine(card: QueueCard): CardNodeLine {
  const kind = cardKind(card);
  const single = singleItem(card);
  if (kind === "list") {
    const counts = cardCounts(card);
    return {
      kind: null,
      text: countsLine(counts),
      tone: counts.permission ? "warning" : "plain",
      ask: counts.permission + counts.think + counts.nod > 0,
    };
  }
  if (single?.kind === "ask") {
    if (kind === "permission") return { kind: "permission", text: collapse(hostAskLine(single.item)), tone: "warning", ask: true };
    if (kind === "error") return { kind: "error", text: collapse(hostAskLine(single.item)), tone: "danger", ask: true };
    return { kind: askKind(single.item) === "nod" ? "approve" : "decide", text: questionLine(single.item), tone: "plain", ask: true };
  }
  if (single?.kind === "result") return { kind: "review", text: collapse(single.item.label), tone: "plain", ask: false };
  const receipt = single?.kind === "receipt" ? single.item : undefined;
  return {
    kind: "returned",
    text: collapse(receipt?.line?.trim() || receipt?.title || ""),
    tone: receipt?.status === "failed" ? "danger" : "plain",
    ask: false,
  };
}

const hasPermission = (card: QueueCard) => card.asks.some((ask) => !ask.resolved && !ask.dropped && isPermissionAsk(ask));
const urgency = (card: QueueCard) => (hasPermission(card) ? 2 : cardKind(card) === "error" ? 1 : 0);

/**
 * An agent's card nodes in the inbox's order: permission requests first, then failed turns (the order a
 * tile's footer names them in, so the card it names is never under `+N more`), then the longest wait, then queue
 * order; with two or more topics, grouped by topic (topics in the order of their first card), so the Tree,
 * the List, the detail's subheads and j/k all walk one order.
 */
export function cardNodeOrder<C extends QueueCard>(cards: readonly C[]): C[] {
  const sorted = cards
    .map((card, index) => ({ card, index }))
    .sort(
      (a, b) =>
        urgency(b.card) - urgency(a.card) ||
        a.card.firstReadyAt.localeCompare(b.card.firstReadyAt) ||
        a.index - b.index,
    )
    .map(({ card }) => card);
  return topicGroups(sorted).flatMap((group) => group.cards);
}

/**
 * Cards (already in order) grouped by topic, topics in order of their first card; a card without one
 * heads no group. With fewer than two distinct topics there is one group with a null topic: no subheads.
 */
export function topicGroups<C extends QueueCard>(cards: readonly C[]): { topic: string | null; cards: C[] }[] {
  const groups = new Map<string, C[]>();
  for (const card of cards) {
    const key = card.topic ?? "";
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  if (groups.size < 2) return [{ topic: null, cards: [...cards] }];
  return [...groups].map(([topic, grouped]) => ({ topic: topic || null, cards: grouped }));
}

/** What a folded agent hides: every open card under it (its own and its descendants') and every agent under it. */
export interface FoldCounts {
  cards: number;
  children: number;
}

export function foldCounts(node: AgentNode): FoldCounts {
  const under = subtree(node);
  return { cards: under.reduce((sum, at) => sum + at.cards.length, 0), children: under.length - 1 };
}

/** `5 cards · 1 child`, zeros left out. */
export function foldLabel(counts: FoldCounts): string {
  return [
    counts.cards ? `${counts.cards} ${counts.cards === 1 ? "card" : "cards"}` : "",
    counts.children ? `${counts.children} ${counts.children === 1 ? "child" : "children"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Wide characters (CJK, kana, full-width forms) take a full em; the rest about half. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

/** The text's width in px at `font` px, estimated. */
export function textWidth(text: string, font: number = TILE.font): number {
  let ems = 0;
  for (const char of text) ems += WIDE.test(char) ? 1 : 0.56;
  return ems * font;
}

/** The kind tag's width in px, estimated (0 without one). */
export const tagWidth = (label: string | null) => (label ? label.length * TILE.tagChar + TILE.tagPad : 0);

/** Kind tags share one width, that of `returned` (the widest but `permission`, which grows): so the lines beside them start at one edge. */
const KIND_CHARS = "returned".length;

/** A kind tag's width on the Tree's card node and the List's card rows, drawn as its minimum width. */
export const cardTagWidth = (label: string | null) => (label ? Math.max(label.length, KIND_CHARS) * CARD_NODE.tagChar + CARD_NODE.tagPad : 0);

/** A kind tag's width on a tile's card row (Columns), drawn as its minimum width. */
export const rowTagWidth = (label: string | null) => (label ? Math.max(label.length, KIND_CHARS) * TILE.tagChar + TILE.tagPad : 0);

/** Lines `text` takes in `room` px at `font`, at most `max`. */
export function textLines(text: string, room: number, font: number, max: 1 | 2): 1 | 2 {
  return max === 2 && textWidth(text, font) > room ? 2 : 1;
}

/** A tile's text column: its width less the body padding and the indent under the icon. */
const innerWidth = (width: number) => width - 2 * TILE.pad - TILE.indent;

/** A card node's lines on a node `width` wide: two when the text will not fit in one beside the tag and the wait. */
export function cardNodeLines(line: CardNodeLine, width: number): 1 | 2 {
  const tag = line.kind ? cardTagWidth(line.kind) + CARD_NODE.gap : 0;
  const room = width - 2 * CARD_NODE.padX - tag - CARD_NODE.gap - CARD_NODE.timeW;
  return textLines(line.text, room, CARD_NODE.font, 2);
}

/** A card row's lines on a tile `width` wide: two when the text will not fit beside the kind tag. */
export function cardRowLines(line: CardNodeLine, width: number): 1 | 2 {
  const tag = line.kind ? rowTagWidth(line.kind) + TILE.tagGap : 0;
  return textLines(line.text, innerWidth(width) - TILE.rowPadR - tag, TILE.font, 2);
}

/** How a tile treats its open cards: as rows (Columns), left to their own nodes (the Tree), or, with the agent folded, as a one-line count. */
export type TileCards = "rows" | "nodes" | "count";

/** What a tile shows below its title, top to bottom, each with its line count. */
export type TileRow = { kind: "card"; card: QueueCard; line: CardNodeLine; lines: 1 | 2 } | { kind: "text"; lines: 1 | 2; max: 1 | 2 } | { kind: "more"; count: number };

/**
 * A Needs you agent's open cards in order (up to three, then `+N more`; none as `nodes`, one line of their
 * counts as `count`); its last line (2 lines; 1 when Done); else one line of what it asks.
 */
export function tileRows(node: AgentNode, width: number, cards: TileCards = "rows"): TileRow[] {
  const state = node.status.state;
  const last = node.agent.lastLine;
  const lastLine = (max: 1 | 2): TileRow[] => (last ? [{ kind: "text", lines: textLines(last, innerWidth(width), TILE.font, max), max }] : []);
  if (state === "working") return lastLine(2);
  if (state === "done") return lastLine(1);
  if (node.status.inferred) return lastLine(2);
  if (!node.cards.length) return [{ kind: "text", lines: 1, max: 1 }];
  if (cards === "nodes") return [];
  if (cards === "count") return [{ kind: "text", lines: 1, max: 1 }];
  const ordered = cardNodeOrder(node.cards);
  const rows: TileRow[] = ordered.slice(0, TILE.maxCards).map((card) => {
    const line = cardNodeLine(card);
    return { kind: "card", card, line, lines: cardRowLines(line, width) };
  });
  if (ordered.length > TILE.maxCards) rows.push({ kind: "more", count: ordered.length - TILE.maxCards });
  return rows;
}

/** The tile's title lines (1-2) on a tile `width` wide; on the Tree an `archived` tag beside the title takes room (Columns has it at the end of the chip row). */
export function titleLines(node: AgentNode, width: number, columns = false): 1 | 2 {
  const tag = !columns && node.agent.archivedAt && node.cards.length ? tagWidth("archived") + TILE.tagGap : 0;
  return textLines(node.title, innerWidth(width) - tag, TILE.titleFont, 2);
}

/**
 * The tile's height in px: border, body padding, then its parts with a gap between: the title, the chip row
 * when there is anything to chip (on Columns, `columns`, it always ends in the workspace; there it can wrap, and
 * the Board does not estimate), the rows, and the fixed footer.
 */
export function tileHeight(node: AgentNode, width: number, cards: TileCards = "rows", columns = false): number {
  const rows = tileRows(node, width, cards);
  const rowH = (row: TileRow) =>
    row.kind === "card" ? Math.max(row.lines * TILE.line, row.line.kind ? TILE.tagH : 0) + 2 * TILE.rowPadY : row.kind === "more" ? TILE.more : row.lines * TILE.line;
  const rowsH = rows.reduce((sum, row) => sum + rowH(row), 0) + Math.max(0, rows.length - 1) * TILE.rowGap;
  const parts = [
    titleLines(node, width, columns) * TILE.titleLine,
    ...(hasTileChips(node, columns) ? [TILE.chipsH] : []),
    ...(rows.length ? [rowsH] : []),
  ];
  return 2 * TILE.border + 2 * TILE.pad + parts.reduce((sum, h) => sum + h, 0) + (parts.length - 1) * TILE.gap + TILE.footer;
}

/** The Working times without the start (`12m` only, no `since …`) when they do not fit beside the state label. */
export function fitTimes(times: TileTimes, label: string, width: number): TileTimes {
  const room = width - 2 * TILE.footerPad - TILE.footerGap - textWidth(label, TILE.footerFont) * 1.1;
  const measure = (text: string) => textWidth(text, TILE.footerFont);
  return times.start && measure(timesText(times)) * 1.05 > room ? { ...times, start: null } : times;
}

// ---- the layout ------------------------------------------------------------------------

interface Box {
  key: string;
  /** 0 the workspace column, 1 its top agents, and so on. */
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramWorkspace extends Box {
  kind: "workspace";
  ws: WorkspaceTree;
  folded: boolean;
  kids: DiagramItem[];
}

export interface DiagramAgent extends Box {
  kind: "agent";
  node: AgentNode;
  /** It has cards or children, so it has a fold handle. */
  foldable: boolean;
  folded: boolean;
  /** Its card nodes, then its child agents; none while folded. */
  kids: DiagramItem[];
  /** What it hides while folded. */
  hidden: FoldCounts;
}

export interface DiagramCard extends Box {
  kind: "card";
  card: QueueCard;
  /** The agent it belongs to. */
  node: AgentNode;
  line: CardNodeLine;
  lines: 1 | 2;
  kids: [];
}

export type DiagramItem = DiagramWorkspace | DiagramAgent | DiagramCard;

export interface DiagramInput {
  forest: AgentForest;
  /** The width the tree may take before it scrolls sideways. */
  avail: number;
  workspaceFolded(name: string): boolean;
  agentFolded(id: string): boolean;
}

export interface DiagramLayout {
  /** Every item, parents before their kids. */
  items: DiagramItem[];
  width: number;
  height: number;
}

/** An item's anchor offset below its top: a tile's and the workspace's are the middle of the title's first line, a card node's its middle. */
const anchorAt = (item: DiagramItem) => (item.kind === "card" ? item.h / 2 : TILE.anchorY);

/** An item's anchor: where connectors meet it. */
export const anchor = (item: DiagramItem) => item.y + anchorAt(item);

/** The card node's key: unique among the agents' keys. */
export const cardItemKey = (card: Pick<QueueCard, "id">) => `card:${card.id}`;

export function layoutDiagram(input: DiagramInput): DiagramLayout {
  const { forest } = input;
  const cardItem = (card: QueueCard, node: AgentNode, depth: number): DiagramCard => ({
    kind: "card",
    key: cardItemKey(card),
    depth,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    card,
    node,
    line: cardNodeLine(card),
    lines: 1,
    kids: [],
  });
  const agentItem = (node: AgentNode, depth: number): DiagramAgent => {
    const foldable = node.cards.length > 0 || node.children.length > 0;
    const folded = foldable && input.agentFolded(node.agent.id);
    return {
      kind: "agent",
      key: node.agent.id,
      depth,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      node,
      foldable,
      folded,
      kids: folded
        ? []
        : [...cardNodeOrder(node.cards).map((card) => cardItem(card, node, depth + 1)), ...node.children.map((child) => agentItem(child, depth + 1))],
      hidden: folded ? foldCounts(node) : { cards: 0, children: 0 },
    };
  };
  const roots: DiagramWorkspace[] = forest.workspaces.map((ws) => {
    const folded = input.workspaceFolded(ws.name);
    return {
      kind: "workspace",
      key: `ws:${ws.name}`,
      depth: 0,
      x: 0,
      y: 0,
      w: DIAGRAM.W0,
      h: DIAGRAM.H,
      ws,
      folded,
      kids: folded ? [] : ws.roots.map((node) => agentItem(node, 1)),
    };
  });
  const items: DiagramItem[] = [];
  const collect = (item: DiagramItem) => {
    items.push(item);
    item.kids.forEach(collect);
  };
  roots.forEach(collect);

  // columns: every level as wide as the room allows, within bounds
  const levels = Math.max(1, ...items.map((item) => item.depth));
  const nodeW = Math.round(Math.max(DIAGRAM.MIN_W, Math.min(DIAGRAM.MAX_W, (input.avail - DIAGRAM.W0 - DIAGRAM.G * levels) / levels)));
  const xAt = (depth: number) => (depth === 0 ? 0 : DIAGRAM.W0 + DIAGRAM.G + (depth - 1) * (nodeW + DIAGRAM.G));
  for (const item of items) {
    item.x = xAt(item.depth);
    if (item.depth > 0) item.w = nodeW;
    if (item.kind === "agent") item.h = tileHeight(item.node, item.w, item.folded ? "count" : "nodes");
    if (item.kind === "card") {
      item.lines = cardNodeLines(item.line, item.w);
      item.h = DIAGRAM.CARD_H[item.lines - 1];
    }
  }

  // rows: a node's anchor is its first kid's; each kid's subtree starts below the one before
  const anchorOffset = (item: DiagramItem): number => (item.kids.length ? Math.max(anchorAt(item), anchorOffset(item.kids[0])) : anchorAt(item));
  const gap = (above: DiagramItem, below: DiagramItem) => (above.kind === "card" && below.kind === "card" ? DIAGRAM.CARD_GAP : DIAGRAM.ROW_GAP);
  const place = (item: DiagramItem, top: number): number => {
    const own = item.kind === "agent" && item.folded ? DIAGRAM.DECK : 0;
    if (!item.kids.length) {
      item.y = top;
      return top + item.h + own;
    }
    const offset = anchorOffset(item);
    item.y = top + offset - anchorAt(item);
    let at = top + offset - anchorOffset(item.kids[0]);
    let bottom = at;
    item.kids.forEach((kid, index) => {
      if (index) at = bottom + gap(item.kids[index - 1], kid);
      bottom = place(kid, at);
    });
    return Math.max(bottom, item.y + item.h + own);
  };
  let bottom = 0;
  roots.forEach((root, index) => {
    bottom = place(root, index ? bottom + DIAGRAM.ROW_GAP + DIAGRAM.WS_GAP : 0);
  });

  const width = Math.max(0, ...items.map((item) => item.x + item.w + (item.kind === "agent" && item.folded ? DIAGRAM.PILL : 0)));
  return { items, width, height: bottom };
}
