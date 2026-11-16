// What the agent manager lists: every non-archived Paseo agent with the facts the state rules need
// (shared/agent-state), read through the plugin's Paseo API, plus each agent Paseo does not list (an
// archived one) that still has open cards, fetched by id so its cards stay reachable. Timelines are read
// only for the agents whose state depends on them, and cached: an idle agent's until Paseo's `updatedAt`
// for it moves, a running agent's for a few seconds.
import { PARENT_AGENT_ID_LABEL, type PaseoAgent, type PaseoApi } from "./host.ts";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { createHash } from "node:crypto";
import type { DoneMark, InferredOutcome, InferredRow, InferredInput, SessionIdentity } from "agent-queue-core";
import { deriveState, signsOff } from "../shared/agent-state.ts";
import type { ManagerAgent } from "../shared/rpc.ts";
import { agentMeta } from "./session.ts";

const PAGE = 200;
const TAIL = 40;
const TIMELINE_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 5_000;
/** How long before an open inferred row whose agent Paseo would not show is looked up again. */
const UNKNOWN_RETRY_MS = 10 * 60_000;
const RUNNING_TTL_MS = 4_000;
const CONCURRENCY = 4;
const LINE_MAX = 200;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The agent's final assistant message: the assistant text at the end of its timeline, after its last
 * tool call or user message (thinking in between is skipped). Null when the timeline ends in anything
 * else (a tool call, an error, a user message), so an agent cut off mid-step never reads as signed off.
 */
export function finalAssistantMessage(items: readonly AgentTimelineItem[]): string | null {
  const parts: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "reasoning") continue;
    if (item.type !== "assistant_message") break;
    parts.unshift(item.text);
  }
  const text = parts.join("\n\n").trim();
  return text || null;
}

const cutLine = (line: string) => {
  const chars = [...line];
  return chars.length > LINE_MAX ? `${chars.slice(0, LINE_MAX).join("")}…` : line;
};

/** A message's lines with text, without Markdown list and heading marks. */
function textLines(text: string): string[] {
  return text
    .split("\n")
    .map((raw) => collapse(raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "").replace(/\*\*|`/g, "").replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, "$1")))
    .filter(Boolean);
}

/** A message's first line with text, without Markdown list and heading marks, cut to 200 characters. */
export function firstLine(text: string | null): string | null {
  const line = text ? textLines(text)[0] : undefined;
  return line === undefined ? null : cutLine(line);
}

const ASKS = /\uff1f|\?(?:\s|$)/;

const TAIL_LINES = 5;

/**
 * The line of a final message that says what the agent is waiting on: its last question among the last
 * five lines (a `?` inside a URL does not count, nor a question heading in the body); else its first line, joined with the next when that one only leads in (ends in a colon).
 */
export function waitingLine(text: string | null): string | null {
  const lines = text ? textLines(text) : [];
  if (!lines.length) return null;
  const question = lines.slice(-TAIL_LINES).findLast((line) => ASKS.test(line));
  if (question !== undefined) return cutLine(question);
  const [first, next] = lines;
  return cutLine(/[\uff1a:]$/.test(first) && next !== undefined ? `${first} ${next}` : first);
}

/** Whether a final message asks something: a question among its last five lines (the test `waitingLine` uses). */
export function hasQuestion(text: string | null): boolean {
  return (text ? textLines(text) : []).slice(-TAIL_LINES).some((line) => ASKS.test(line));
}

/** What a timeline tail says: when the agent last did something, and its final message. */
interface TailRead {
  lastAt: string | null;
  message: string | null;
}

/** Reads the tail of an agent's timeline; null when Paseo does not answer in time. */
async function readTail(paseo: PaseoApi, agentId: string): Promise<TailRead | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const page = await Promise.race([
    paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: TAIL }),
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), TIMELINE_TIMEOUT_MS))),
  ])
    .catch(() => null)
    .finally(() => clearTimeout(timer));
  if (!page) return null;
  // Rows other plugins append are not the agent's own activity.
  const own = page.entries.filter((entry) => entry.item.type !== "plugin");
  const lastAt = own.reduce<string | null>((a, b) => (!a || Date.parse(b.timestamp) > Date.parse(a) ? b.timestamp : a), null);
  return { lastAt, message: finalAssistantMessage(own.map((entry) => entry.item)) };
}

/** Every non-archived agent Paseo lists (background helpers and internal agents are left out, as in Paseo's own lists). */
async function allAgents(paseo: PaseoApi): Promise<PaseoAgent[]> {
  const out: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: PAGE, ...(cursor ? { cursor } : {}) },
    });
    out.push(...page.entries.map((entry) => entry.agent));
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return out.filter((agent) => !agent.archivedAt && !agent.internal);
}

/**
 * Agents Paseo did not list that still have open cards (archived ones, mostly), fetched by id. One that
 * Paseo does not return in time is left out; the screen then shows its cards from their own snapshot.
 */
async function cardedExtras(paseo: PaseoApi, ids: readonly string[]): Promise<PaseoAgent[]> {
  const fetched = await Promise.all(
    ids.map(async (id) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refreshed = await Promise.race([
        paseo.agents.ref(id).refresh(),
        new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), FETCH_TIMEOUT_MS))),
      ])
        .catch(() => null)
        .finally(() => clearTimeout(timer));
      return refreshed?.agent ?? null;
    }),
  );
  return fetched.filter((agent): agent is PaseoAgent => agent !== null);
}

/** Runs `work` over `items`, a few at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(lanes);
}

const latest = (...values: (string | null | undefined)[]) =>
  values.reduce<string | null>((a, b) => (b && (!a || Date.parse(b) > Date.parse(a)) ? b : a), null);

export const parentOf = (agent: Pick<PaseoAgent, "id" | "labels">): string | null => {
  const parent = agent.labels?.[PARENT_AGENT_ID_LABEL]?.trim() || null;
  return parent && parent !== agent.id ? parent : null;
};

/** The part of the queue store the inferred log needs. */
export interface InferredLog {
  logInferred(input: InferredInput): boolean;
  openInferred(host: "paseo"): InferredRow[];
  settleInferred(identity: SessionIdentity, outcome: InferredOutcome, options?: { exceptHash?: string; at?: string }): number;
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

export interface AgentFeedInput {
  paseo: PaseoApi;
  /** Session ids with an open Paseo card: their state is Needs you whatever their timeline says. */
  carded: ReadonlySet<string>;
  marks: readonly DoneMark[];
  /** Where inferred endings and what became of them are recorded; omitted, nothing is. */
  log?: InferredLog;
  now?: () => Date;
}

/** Lists agents for the manager, keeping timeline reads between calls (one feed per plugin process). */
export class AgentFeed {
  #tails = new Map<string, { key: string; at: number; read: TailRead }>();
  /** (session, final hash) pairs already written to the log, so a poll with nothing new writes nothing. */
  #logged = new Set<string>();
  /** Sessions Paseo neither lists nor returned as archived, and when each was last asked about. */
  #unknown = new Map<string, number>();
  /** The background look-up of unlisted sessions; at most one at a time. */
  #probe: Promise<void> | null = null;

  /** Resolves when the background look-up of unlisted sessions, if one is running, has finished. */
  async settled(): Promise<void> {
    await this.#probe;
  }

  async list({ paseo, carded, marks, log, now = () => new Date() }: AgentFeedInput): Promise<{ now: string; agents: ManagerAgent[]; marks: Record<string, string> }> {
    // The log's time for this poll is its start, so a Mark done tapped while it runs is never earlier than a row it writes.
    const startedAt = now().toISOString();
    const listed = await allAgents(paseo);
    const live = new Set(listed.map((agent) => agent.id));
    const agents = [...listed, ...(await cardedExtras(paseo, [...carded].filter((id) => !live.has(id))))];
    const running = (agent: PaseoAgent) => agent.status === "running" || agent.status === "initializing";
    // The timeline matters for a running agent (its last activity) and for an idle one the rules must
    // read (no card, not a child of a live agent): its final message and whether a Mark done still holds.
    const needsTail = (agent: PaseoAgent) => {
      if (running(agent)) return true;
      const parent = parentOf(agent);
      return !carded.has(agent.id) && !(parent && live.has(parent));
    };

    const tails = new Map<string, TailRead | null>();
    const clock = now().getTime();
    await eachLimited(agents.filter(needsTail), CONCURRENCY, async (agent) => {
      const key = running(agent) ? "running" : agent.updatedAt;
      const hit = this.#tails.get(agent.id);
      if (hit && hit.key === key && (key !== "running" || clock - hit.at < RUNNING_TTL_MS)) {
        tails.set(agent.id, hit.read);
        return;
      }
      const read = await readTail(paseo, agent.id);
      if (read) this.#tails.set(agent.id, { key, at: clock, read });
      tails.set(agent.id, read);
    });
    const shown = new Set(agents.map((agent) => agent.id));
    for (const id of this.#tails.keys()) if (!shown.has(id)) this.#tails.delete(id);

    const out = await Promise.all(
      agents.map(async (agent): Promise<ManagerAgent> => {
        const meta = await agentMeta(paseo, agent);
        const tail = tails.get(agent.id) ?? null;
        const message = running(agent) ? null : (tail?.message ?? null);
        return {
          id: agent.id,
          title: agent.title,
          status: agent.status,
          parentId: parentOf(agent),
          workspace: meta.workspace ?? null,
          cwd: agent.cwd,
          provider: agent.provider,
          model: agent.runtimeInfo?.model || agent.model || null,
          meta: { plan: meta.plan, modelLabel: meta.modelLabel, effort: meta.effort, effortLabel: meta.effortLabel },
          createdAt: agent.createdAt,
          turnStartedAt: agent.activeTurn?.startedAt ?? null,
          // The timeline's newest entry is the agent's own activity. Paseo's `updatedAt` also moves when a
          // client opens the agent's tab or relabels it, so it stands in only when the timeline was not read.
          lastActivityAt:
            latest(tail ? tail.lastAt : agent.updatedAt, agent.lastUserMessageAt, agent.activeTurn?.startedAt) ?? agent.updatedAt,
          pendingPermissions: agent.pendingPermissions?.length ?? 0,
          signedOff: signsOff(message),
          lastLine: signsOff(message) ? firstLine(message) : waitingLine(message),
          lastLineAsks: !signsOff(message) && hasQuestion(message),
          archivedAt: agent.archivedAt ?? null,
        };
      }),
    );
    if (log) {
      // The log is a record on the side: a failure there must not keep the screen from loading.
      try {
        await this.#recordInferred(paseo, log, agents, out, tails, carded, marks, live, startedAt);
      } catch (error) {
        console.error("agent-queue: inferred log", error);
      }
    }
    const markMap: Record<string, string> = {};
    for (const mark of marks) if (mark.host === "paseo") markMap[mark.sessionId] = mark.markedAt;
    return { now: now().toISOString(), agents: out, marks: markMap };
  }
  /**
   * The inferred log: writes a row for each idle agent the rules leave to the user (no card, no
   * permission request, not signed off, not marked, not a child of a live agent) with a final message,
   * once per message, and gives each open row its outcome the first time the feed can tell. What the
   * feed knows maps to outcomes as follows (marked_done and card_filed are set by the store itself):
   * - the agent is archived (listed with `archivedAt`, or gone from the list and returned by id with
   *   one): `archived`;
   * - the agent runs again, or its final message is no longer the logged one: `user_replied` when
   *   Paseo's `lastUserMessageAt` is later than the row's first sighting, else `active_again`. The
   *   feed cannot tell a typed reply from any other user message (a queue answer sent to the session
   *   counts), nor a user message from an automatic turn Paseo records as one.
   * A row is closed by the first of these; polls that see none leave it open.
   */
  async #recordInferred(
    paseo: PaseoApi,
    log: InferredLog,
    agents: readonly PaseoAgent[],
    out: readonly ManagerAgent[],
    tails: ReadonlyMap<string, TailRead | null>,
    carded: ReadonlySet<string>,
    marks: readonly DoneMark[],
    live: ReadonlySet<string>,
    at: string,
  ): Promise<void> {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const shown = new Map(out.map((agent) => [agent.id, agent]));
    const markedAt = new Map(marks.filter((mark) => mark.host === "paseo").map((mark) => [mark.sessionId, mark.markedAt]));
    const finals: { agent: ManagerAgent; message: string; hash: string }[] = [];
    for (const agent of agents) {
      const view = shown.get(agent.id);
      const message = tails.get(agent.id)?.message ?? null;
      if (!view || !message || agent.status === "running" || agent.status === "initializing") continue;
      const parent = parentOf(agent);
      const verdict = deriveState({
        status: agent.status,
        pendingPermissions: view.pendingPermissions,
        openCards: carded.has(agent.id) ? 1 : 0,
        signedOff: view.signedOff,
        markedAt: markedAt.get(agent.id) ?? null,
        lastActivityAt: view.lastActivityAt,
        isChild: parent !== null,
        parentLive: parent !== null && live.has(parent),
      });
      if (!verdict.inferred || verdict.state !== "needs_you") continue;
      const hash = hashOf(message);
      finals.push({ agent: view, message, hash });
    }

    const unlisted: string[] = [];
    const open = log.openInferred("paseo");
    for (const id of this.#unknown.keys()) if (!open.some((row) => row.sessionId === id)) this.#unknown.delete(id);
    for (const row of open) {
      const identity = { host: "paseo" as const, sessionId: row.sessionId };
      // A Mark done at or after the first sighting is the row's outcome, even when the poll read the marks before the tap.
      const mark = markedAt.get(row.sessionId);
      if (mark && Date.parse(mark) >= Date.parse(row.firstSeenAt)) {
        log.settleInferred(identity, "marked_done", { at: mark });
        continue;
      }
      const agent = byId.get(row.sessionId);
      if (!agent) {
        const tried = this.#unknown.get(row.sessionId);
        if (tried === undefined || Date.parse(at) - tried >= UNKNOWN_RETRY_MS) unlisted.push(row.sessionId);
        continue;
      }
      if (agent.archivedAt) {
        log.settleInferred(identity, "archived", { at });
        continue;
      }
      const running = agent.status === "running" || agent.status === "initializing";
      const read = tails.get(agent.id);
      // A tail that was not read says nothing about the message; a null message means it ended in a tool call or user message.
      const moved = running || (read != null && (read.message === null || hashOf(read.message) !== row.finalHash));
      if (!moved) continue;
      const userAt = agent.lastUserMessageAt ? Date.parse(agent.lastUserMessageAt) : 0;
      log.settleInferred(identity, userAt > Date.parse(row.firstSeenAt) ? "user_replied" : "active_again", { at });
    }

    this.#lookUp(paseo, log, unlisted, at);

    // The table's unique key already dedupes, so the in-memory keys only need to cover the endings in view.
    const logged = new Set<string>();
    for (const { agent, message, hash } of finals) {
      const key = `${agent.id}:${hash}`;
      logged.add(key);
      if (this.#logged.has(key)) continue;
      log.logInferred({ host: "paseo", sessionId: agent.id, finalHash: hash, finalTail: message, hasQuestion: hasQuestion(message), at });
    }
    this.#logged = logged;
  }

  /**
   * Asks Paseo by id about open rows whose agent it does not list, off the poll: the screen must not wait on
   * agents that do not answer. A row whose agent comes back archived settles; any other answer, or none,
   * is asked again after UNKNOWN_RETRY_MS.
   */
  #lookUp(paseo: PaseoApi, log: InferredLog, ids: readonly string[], at: string): void {
    if (this.#probe || ids.length === 0) return;
    for (const id of ids) this.#unknown.set(id, Date.parse(at));
    this.#probe = cardedExtras(paseo, ids)
      .then((found) => {
        for (const agent of found) {
          if (!agent.archivedAt) continue;
          log.settleInferred({ host: "paseo", sessionId: agent.id }, "archived", { at });
          this.#unknown.delete(agent.id);
        }
      })
      .catch((error) => console.error("agent-queue: inferred log", error))
      .finally(() => {
        this.#probe = null;
      });
  }
}
