// The agent manager's model: every non-archived Paseo agent with its state, nested under the agent
// that started it (`paseo.parent-agent-id`), and the trees grouped by workspace. Every open card has a
// place: an archived agent that still has cards is listed too, and a session no agent stands for (one
// Paseo did not return) gets a node built from its cards. Siblings and workspaces are
// ordered by the most pressing state anywhere under them (Needs you, then Needs you inferred, Working,
// Done). Also the counts (the sidebar's is Needs you),
// the row times and what Archive all would archive. Pure, so the screen, the harness and the tests
// share it.
import { workspaceName } from "./agent-line.ts";
import { AGENT_STATES, deriveState, type AgentState, type AgentStatus, type IdleClassifier } from "./agent-state.ts";
import type { ManagerAgent, QueueCard } from "./rpc.ts";
import { elapsed } from "./time.ts";

export type StateCounts = Record<AgentState, number>;

/** The name for agents with neither a Paseo workspace nor a cwd. */
export const NO_WORKSPACE = "No workspace";

/** The card that speaks for a session: its most recently updated one (topic and agent are current there). */
export function latestCard<C extends Pick<QueueCard, "updatedAt">>(cards: readonly C[]): C | null {
  return cards.reduce<C | null>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), null);
}

export interface AgentNode {
  /** Where the session lives. */
  host: QueueCard["host"];
  agent: ManagerAgent;
  /** The topic of its latest open queue card, else Paseo's title, else the id's first 8 characters. */
  title: string;
  status: AgentStatus;
  /** Its open queue cards, in queue order. */
  cards: QueueCard[];
  /**
   * Needs you: since when it waits (its oldest open card, else its latest activity). Working: when the run
   * started (`runFrom`). Done: when it last did something.
   */
  since: string;
  /** Working: `since` is the current turn's start (`turn`), or the agent's creation when Paseo gives none. */
  runFrom: "turn" | "created" | null;
  parent: AgentNode | null;
  children: AgentNode[];
  /** The workspace of its top ancestor: lineage wins over where a child runs itself. */
  workspace: string;
}

export interface WorkspaceTree {
  /** The Paseo workspace name, else the cwd with home as ~ (as the agent line names it), else `No workspace`. */
  name: string;
  roots: AgentNode[];
  counts: StateCounts;
}

export interface AgentForest {
  workspaces: WorkspaceTree[];
  byId: ReadonlyMap<string, AgentNode>;
  counts: StateCounts;
  total: number;
}

export interface ForestInput {
  agents: readonly ManagerAgent[];
  /** Open queue cards, in queue order. */
  cards: readonly QueueCard[];
  /** Mark done taps: agent id → when. */
  marks: Readonly<Record<string, string>>;
  /** The daemon's home, to show a cwd as ~/…. */
  home: string | null;
  classify?: IdleClassifier;
}

/** How pressing a node is: Needs you 0, Needs you inferred 1 (no card, a guess), Working 2, Done 3. */
const RANK = (node: AgentNode): number => (node.status.state === "needs_you" ? (node.status.inferred ? 1 : 0) : node.status.state === "working" ? 2 : 3);

export const emptyCounts = (): StateCounts => ({ needs_you: 0, working: 0, done: 0 });

export function countStates(nodes: readonly AgentNode[]): StateCounts {
  const counts = emptyCounts();
  for (const node of nodes) counts[node.status.state] += 1;
  return counts;
}

/** A node and everything under it, depth first. */
export function subtree(node: AgentNode): AgentNode[] {
  return [node, ...node.children.flatMap(subtree)];
}

/** Everything under a node, without the node. */
export const descendants = (node: AgentNode): AgentNode[] => node.children.flatMap(subtree);

/** The node's ancestors, top first. */
export function ancestors(node: AgentNode): AgentNode[] {
  const out: AgentNode[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) out.unshift(parent);
  return out;
}

/** Needs you: the longest wait first. Working: the longest run first. Done: the most recent first. */
function timeKey(node: AgentNode): number {
  const at = Date.parse(node.since);
  return node.status.state === "done" ? -at : at;
}

/** The most pressing state anywhere in the subtree, as its rank. */
function bestRank(node: AgentNode): number {
  return Math.min(RANK(node), ...node.children.map(bestRank));
}

/** Siblings: the most pressing state under them first, then their own state, then by time. */
function compareNodes(a: AgentNode, b: AgentNode): number {
  return (
    bestRank(a) - bestRank(b) ||
    RANK(a) - RANK(b) ||
    timeKey(a) - timeKey(b) ||
    a.agent.id.localeCompare(b.agent.id)
  );
}

/** Workspaces: the most pressing state in them first, then the earliest time among the agents in it. */
function compareWorkspaces(a: WorkspaceTree, b: WorkspaceTree): number {
  const all = (ws: WorkspaceTree) => ws.roots.flatMap(subtree);
  const best = (ws: WorkspaceTree) => Math.min(...ws.roots.map(bestRank));
  const first = (ws: WorkspaceTree, rank: number) =>
    Math.min(...all(ws).filter((node) => RANK(node) === rank).map(timeKey));
  const rank = best(a) - best(b);
  if (rank) return rank;
  return first(a, best(a)) - first(b, best(b)) || a.name.localeCompare(b.name);
}

/** The id of the node a card sits under: its Paseo session id. */
export const cardNodeId = (card: Pick<QueueCard, "sessionId">) => card.sessionId;

/** The session id of a node. */
export const nodeSessionId = (node: Pick<AgentNode, "agent">) => node.agent.id;

/**
 * An agent for a session that has open cards but that the agent list does not hold: what its latest
 * card recorded about it. Its status is unknown, so only its cards decide its state (Needs you).
 */
function agentFromCards(id: string, cards: readonly QueueCard[]): ManagerAgent {
  const latest = latestCard(cards) as QueueCard;
  const first = cards.reduce((a, b) => (b.createdAt < a.createdAt ? b : a));
  const meta = latest.agent;
  return {
    id,
    title: latest.sessionTitle,
    status: "unknown",
    parentId: meta?.parentSessionId ? meta.parentSessionId : null,
    workspace: meta?.workspace ?? null,
    cwd: latest.cwd ?? "",
    provider: latest.provider ?? latest.host,
    model: latest.model,
    meta: { ...meta },
    createdAt: first.createdAt,
    turnStartedAt: null,
    lastActivityAt: latest.updatedAt,
    pendingPermissions: 0,
    signedOff: false,
    lastLine: null,
    archivedAt: null,
  };
}

/**
 * Builds the forest: each agent's state (shared/agent-state), its title and times, nested under its
 * parent when the parent is among the agents (a loop of parents leaves the agent that closes it at the
 * top), and the trees grouped by their top agent's workspace. Sessions with open cards that no listed
 * agent stands for get a node from their cards.
 */
export function buildForest(input: ForestInput): AgentForest {
  const cardsOf = new Map<string, QueueCard[]>();
  for (const card of input.cards) {
    if (card.state !== "open") continue;
    cardsOf.set(card.sessionId, [...(cardsOf.get(card.sessionId) ?? []), card]);
  }
  const listed = new Set(input.agents.map((agent) => agent.id));
  const agents = [
    ...input.agents,
    ...[...cardsOf].filter(([id]) => !listed.has(id)).map(([id, cards]) => agentFromCards(id, cards)),
  ];
  const all = new Map(agents.map((agent) => [agent.id, agent]));
  // A parent counts as live (its children's results go there) unless Paseo archived it.
  const live = (id: string) => {
    const parent = all.get(id);
    return parent !== undefined && !parent.archivedAt;
  };

  // Parents among the agents; an agent whose chain leads back to itself is cut loose.
  const parentOf = new Map<string, string | null>();
  for (const agent of agents) {
    const parent = agent.parentId && agent.parentId !== agent.id && all.has(agent.parentId) ? agent.parentId : null;
    parentOf.set(agent.id, parent);
  }
  const ordered = [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const agent of ordered) {
    const seen = new Set<string>([agent.id]);
    for (let at = parentOf.get(agent.id) ?? null; at; at = parentOf.get(at) ?? null) {
      if (seen.has(at)) {
        if (at === agent.id) parentOf.set(agent.id, null);
        break;
      }
      seen.add(at);
    }
  }

  const byId = new Map<string, AgentNode>();
  for (const agent of agents) {
    const cards = cardsOf.get(agent.id) ?? [];
    const markedAt = input.marks[agent.id] ?? null;
    const status = deriveState(
      {
        status: agent.status,
        pendingPermissions: agent.pendingPermissions,
        openCards: cards.length,
        signedOff: agent.signedOff,
        markedAt,
        lastActivityAt: agent.lastActivityAt,
        isChild: agent.parentId !== null,
        parentLive: agent.parentId !== null && agent.parentId !== agent.id && live(agent.parentId),
      },
      input.classify,
    );
    const latest = latestCard(cards);
    const title = latest?.topic?.trim() || agent.title?.trim() || agent.id.slice(0, 8);
    let since = agent.lastActivityAt;
    let runFrom: AgentNode["runFrom"] = null;
    if (status.state === "needs_you" && cards.length) {
      since = cards.reduce((a, b) => (b.firstReadyAt < a ? b.firstReadyAt : a), cards[0].firstReadyAt);
    } else if (status.state === "working") {
      runFrom = agent.turnStartedAt ? "turn" : "created";
      since = agent.turnStartedAt ?? agent.createdAt;
    }
    byId.set(agent.id, { host: "paseo", agent, title, status, cards, since, runFrom, parent: null, children: [], workspace: NO_WORKSPACE });
  }

  const roots: AgentNode[] = [];
  for (const node of byId.values()) {
    const parent = parentOf.get(node.agent.id);
    const parentNode = parent ? byId.get(parent) : undefined;
    if (parentNode) {
      node.parent = parentNode;
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortDeep = (nodes: AgentNode[]) => {
    nodes.sort(compareNodes);
    for (const node of nodes) sortDeep(node.children);
  };
  sortDeep(roots);

  const workspaces = new Map<string, WorkspaceTree>();
  for (const root of roots) {
    const name = workspaceName({ agent: { workspace: root.agent.workspace }, cwd: root.agent.cwd }, input.home) || NO_WORKSPACE;
    for (const node of subtree(root)) node.workspace = name;
    let ws = workspaces.get(name);
    if (!ws) workspaces.set(name, (ws = { name, roots: [], counts: emptyCounts() }));
    ws.roots.push(root);
  }
  for (const ws of workspaces.values()) ws.counts = countStates(ws.roots.flatMap(subtree));

  return {
    workspaces: [...workspaces.values()].sort(compareWorkspaces),
    byId,
    counts: countStates([...byId.values()]),
    total: byId.size,
  };
}

/** The sidebar's count: the agents that need the user, archived ones with open cards included. */
export const needsYouCount = (input: ForestInput): number => buildForest(input).counts.needs_you;

/** The Needs you agents among `nodes` that are inferred (no card, no permission request): counts show them apart. */
export const inferredIn = (nodes: Iterable<AgentNode>): number =>
  [...nodes].filter((node) => node.status.state === "needs_you" && node.status.inferred).length;

export interface MarkCount {
  state: AgentState;
  inferred: boolean;
  count: number;
}

/** Counts as drawn: each state with its mark, Needs you without its inferred agents, which follow it with their own mark when there are any. */
export function markCounts(counts: StateCounts, inferred: number): MarkCount[] {
  return AGENT_STATES.flatMap((state) => {
    const item = { state, inferred: false, count: counts[state] };
    if (state !== "needs_you" || !inferred) return [item];
    return [{ ...item, count: item.count - inferred }, { state, inferred: true, count: inferred }];
  });
}

/** Every node in screen order: workspaces in order, each tree depth first. */
export function screenOrder(forest: AgentForest): AgentNode[] {
  return forest.workspaces.flatMap((ws) => ws.roots.flatMap(subtree));
}

/** The agent to show first: the first Needs you agent in screen order, else the first agent; null when there is none. */
export function mostPressing(forest: AgentForest): AgentNode | null {
  const order = screenOrder(forest);
  return order.find((node) => node.status.state === "needs_you") ?? order[0] ?? null;
}

/**
 * What Archive all archives: every Done agent whose descendants are all Done too. Archiving an agent in
 * Paseo also archives the agents it started, so a Done agent with live work under it is kept, and listed
 * as kept, rather than taking that work with it.
 */
export function archivePlan(forest: AgentForest): { archive: AgentNode[]; kept: AgentNode[] } {
  const done = screenOrder(forest).filter((node) => node.status.state === "done");
  const live = (node: AgentNode) => descendants(node).some((child) => child.status.state !== "done");
  return { archive: done.filter((node) => !live(node)), kept: done.filter(live) };
}

export const IDLE_MS = 24 * 3_600_000;

/** What Mark idle done marks: inferred agents (no card, no permission request, not archived) whose last activity is over 24 h old, in screen order. */
export function idleInferred(forest: AgentForest, nowMs: number): AgentNode[] {
  return screenOrder(forest).filter(
    (node) =>
      node.status.inferred &&
      node.status.state === "needs_you" &&
      !node.agent.archivedAt &&
      node.cards.length === 0 &&
      nowMs - Date.parse(node.agent.lastActivityAt) > IDLE_MS,
  );
}

/**
 * The time at a row's right edge. Needs you: the wait (`4h`). Working: how long it has run and its last
 * activity (`12m · last 2m ago`, or `12m · active now`); `short`, only how long it has run (`12m`), for a
 * column too narrow for both. Done: how long ago it finished (`3h ago`).
 */
export function rowTime(node: AgentNode, nowMs: number, short = false): string {
  const since = elapsed(node.since, nowMs);
  if (node.status.state === "needs_you") return since;
  if (node.status.state === "working") {
    if (short) return since;
    const last = elapsed(node.agent.lastActivityAt, nowMs);
    return `${since} · ${last === "now" ? "active now" : `last ${last} ago`}`;
  }
  return since === "now" ? "now" : `${since} ago`;
}

export { AGENT_STATES };
