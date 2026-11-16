// The Columns view's model: the forest split into three columns by state (Needs you, Working, Done).
// Inside a column, rows group by workspace and nest by lineage; an ancestor whose own state is another
// column's stays as a header over the agents under it, so the chain reads. Order: Needs you with permission
// requests first, then agents with cards, then inferred ones, each by longest wait; Working by longest
// running, Done by most recent; a parent stays above its children, so siblings and workspaces go by the
// first row anywhere under them. Pure, so the screen, the harness and the tests share it.
import { AGENT_STATES, type AgentState } from "./agent-state.ts";
import type { AgentForest, AgentNode } from "./agent-tree.ts";
import { cardNodeLine, type CardNodeKind } from "./agent-diagram.ts";
import { cardCounts, isPermissionAsk } from "./cards.ts";
import { labelTone, lineTone, type Tone } from "./card-tone.ts";

export interface ColumnRow {
  node: AgentNode;
  /** Lineage depth inside its workspace group. */
  depth: number;
  /** A header only: its own state is another column's, and agents of this column sit under it. */
  ancestor: boolean;
  /** Rows of this column nest under it, right after it. */
  nested: boolean;
}

export interface ColumnGroup {
  workspace: string;
  rows: ColumnRow[];
}

export interface StateColumn {
  state: AgentState;
  /** The agents in this state; ancestor headers are not counted. */
  count: number;
  groups: ColumnGroup[];
}

/** Whether the agent waits on a permission request: one Paseo holds, or an open permission ask on its cards. */
export function asksPermission(node: AgentNode): boolean {
  return (
    node.agent.pendingPermissions > 0 ||
    node.cards.some((card) => card.asks.some((ask) => !ask.resolved && !ask.dropped && isPermissionAsk(ask)))
  );
}

/** Sort key within a column, smallest first. */
type Key = readonly [number, number];

const compareKeys = (a: Key, b: Key) => a[0] - b[0] || a[1] - b[1];

/** Needs you: permission requests, then agents with cards, then inferred ones, each by the longest wait. Working: the longest run. Done: the most recent. */
function rowKey(node: AgentNode, state: AgentState): Key {
  const at = Date.parse(node.since);
  if (state === "needs_you") return [asksPermission(node) ? 0 : node.status.inferred ? 2 : 1, at];
  return [0, state === "done" ? -at : at];
}

interface Pruned {
  node: AgentNode;
  ancestor: boolean;
  children: Pruned[];
  /** The key of the first row anywhere under it, itself included. */
  key: Key;
}

const comparePruned = (a: Pruned, b: Pruned) => compareKeys(a.key, b.key) || a.node.agent.id.localeCompare(b.node.agent.id);

/** The node's tree cut down to one state's agents and the ancestors above them; null when none is under it. */
function prune(node: AgentNode, state: AgentState): Pruned | null {
  const children = node.children.map((child) => prune(child, state)).filter((child): child is Pruned => child !== null);
  const own = node.status.state === state;
  if (!own && !children.length) return null;
  children.sort(comparePruned);
  const keys = [...(own ? [rowKey(node, state)] : []), ...children.map((child) => child.key)];
  return { node, ancestor: !own, children, key: keys.reduce((a, b) => (compareKeys(b, a) < 0 ? b : a)) };
}

function rowsOf(trees: readonly Pruned[], depth = 0): ColumnRow[] {
  return trees.flatMap((tree) => [
    { node: tree.node, depth, ancestor: tree.ancestor, nested: tree.children.length > 0 },
    ...rowsOf(tree.children, depth + 1),
  ]);
}

/** One state's column: its agents by workspace, nested by lineage, ancestors from other columns as headers. */
export function stateColumn(forest: AgentForest, state: AgentState): StateColumn {
  const groups = forest.workspaces
    .map((ws) => {
      const roots = ws.roots.map((root) => prune(root, state)).filter((root): root is Pruned => root !== null);
      roots.sort(comparePruned);
      return { workspace: ws.name, roots };
    })
    .filter((group) => group.roots.length > 0)
    .sort((a, b) => compareKeys(a.roots[0].key, b.roots[0].key) || a.workspace.localeCompare(b.workspace));
  return { state, count: forest.counts[state], groups: groups.map((group) => ({ workspace: group.workspace, rows: rowsOf(group.roots) })) };
}

/** The three columns, Needs you | Working | Done. */
export const stateColumns = (forest: AgentForest): StateColumn[] => AGENT_STATES.map((state) => stateColumn(forest, state));

export interface BoardColumn {
  state: AgentState;
  /** The agents in this state, in the Columns' order: no ancestor headers, no workspace groups, no nesting. */
  nodes: AgentNode[];
}

/** The Board's columns: the column's agents flat, by the column's key across all workspaces (a parent above its own children). */
export function boardColumns(forest: AgentForest): BoardColumn[] {
  return AGENT_STATES.map((state) => {
    const roots = forest.workspaces
      .flatMap((ws) => ws.roots)
      .map((root) => prune(root, state))
      .filter((root): root is Pruned => root !== null)
      .sort(comparePruned);
    return { state, nodes: rowsOf(roots).filter((row) => !row.ancestor).map((row) => row.node) };
  });
}

/** What a Needs you tile's footer says, most pressing first. */
export type BoardLabel = "Permission" | "Error" | "Decide" | "Review" | "Returned" | "Idle";

const LABELS: readonly BoardLabel[] = ["Permission", "Error", "Decide", "Review", "Returned"];

/** The most pressing kind among an agent's open cards (an older multi-item card counts by what it holds). */
function labelOf(card: AgentNode["cards"][number]): BoardLabel {
  const line = cardNodeLine(card);
  const kind: CardNodeKind | null = line.kind;
  if (kind === "permission") return "Permission";
  if (kind === "error") return "Error";
  if (kind === "decide" || kind === "approve") return "Decide";
  if (kind === "review") return "Review";
  if (kind === "returned") return "Returned";
  const n = cardCounts(card);
  return n.permission ? "Permission" : n.think + n.nod ? "Decide" : "Review";
}

/**
 * The footer label of a Needs you agent: the most pressing kind among its cards (Permission > Error >
 * Decide > Review or Returned); `Permission` for a permission request Paseo holds without a card;
 * `Idle` when it has no card.
 */
export function boardLabel(node: AgentNode): BoardLabel {
  if (!node.cards.length) return node.status.reason === "permission" ? "Permission" : "Idle";
  const ranks = node.cards.map((card) => LABELS.indexOf(labelOf(card)));
  return LABELS[Math.min(...ranks, node.agent.pendingPermissions > 0 ? 0 : LABELS.length)];
}

/** A footer label's tone (`labelTone`), but `Returned` is red when one of the agent's receipts failed, as that card's tag is. */
export function boardTone(node: AgentNode, label: string): Tone | null {
  if (label === "Returned" && node.cards.some((card) => lineTone(cardNodeLine(card)) === "danger")) return "danger";
  return labelTone(label);
}
