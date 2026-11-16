// Which agent a card comes from, under its title, as chips: [logo plan · model], [effort], and for a
// child [child of <name>] (a main agent has no role chip), then the workspace. Pure, so the server, the
// screen and the UI harness share it.
import type { ManagerAgent, QueueCard, QueueTrack } from "./rpc.ts";

/** Provider logos the screen can draw; anything else gets a neutral dot. */
export type ProviderIconKey = "claude" | "codex" | "opencode";
const ICON_KEYS: readonly string[] = ["claude", "codex", "opencode"];

/**
 * The logo for a card: its Paseo provider by id, or by the built-in it is a
 * profile of when the id extends one (`claude-personal` is a profile of `claude`).
 */
export function providerIconKey(card: Pick<QueueCard, "host" | "provider">): ProviderIconKey | null {
  const id = card.provider ?? "";
  if (ICON_KEYS.includes(id)) return id as ProviderIconKey;
  const base = id.split("-")[0];
  return ICON_KEYS.includes(base) ? (base as ProviderIconKey) : null;
}

/** A model id made readable when the host gives no label: `claude-opus-5-5` → `Opus 5.5`. */
export function shortModel(id: string | null): string | null {
  if (!id) return null;
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  return id.slice(id.lastIndexOf("/") + 1);
}

/** A path with the home directory shown as ~ (the home itself is just ~). */
export function tildify(path: string | null, home: string | null): string | null {
  if (!path) return null;
  if (!home) return path;
  const root = home.replace(/\/+$/, "");
  if (path === root) return "~";
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
}

/** The workspace a card's session runs in: the Paseo workspace name, else the cwd with home as ~. */
export function workspaceName(card: Pick<QueueCard, "agent" | "cwd">, home: string | null): string | null {
  return card.agent?.workspace || tildify(card.cwd, home);
}

/** Card sessions started by a registered dispatch: session id → dispatching session (null if unknown). */
export function trackParents(
  cards: readonly Pick<QueueCard, "host" | "sessionId">[],
  tracks: readonly Pick<QueueTrack, "host" | "childRef" | "parentSessionId" | "startedAt">[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const card of cards) {
    const matches = tracks.filter(
      (t) =>
        t.host === card.host &&
        t.childRef !== null &&
        (t.childRef === card.sessionId || (t.childRef.length >= 7 && card.sessionId.startsWith(t.childRef))) &&
        t.parentSessionId !== card.sessionId,
    );
    if (!matches.length) continue;
    const latest = matches.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
    out[card.sessionId] = latest.parentSessionId;
  }
  return out;
}

export interface AgentLineContext {
  cards: readonly QueueCard[];
  sessionTitles: Record<string, string>;
  childOf: Record<string, string | null>;
  home: string | null;
}

export interface AgentLine {
  icon: ProviderIconKey | null;
  /** Chip A: `plan · model`, the provider logo before it; null when the host names neither. */
  provider: string | null;
  /** Chip B: the effort label; null when there is none. */
  effort: string | null;
  /** Chip C: `child` or `child of <name>` for a child; null for a main agent. */
  child: string | null;
  workspace: string | null;
}

export function agentLine(card: QueueCard, context: AgentLineContext): AgentLine {
  const meta = card.agent ?? {};
  const plan = meta.plan || card.provider;
  const model = meta.modelLabel || shortModel(card.model);
  const effort = meta.effortLabel || meta.effort;
  let role: string | null = null;
  const labelled = meta.parentSessionId;
  const parent = labelled ?? context.childOf[card.sessionId];
  if (labelled || card.sessionId in context.childOf) {
    if (parent) {
      const parentCard = context.cards.find((c) => c.host === card.host && c.sessionId === parent);
      const name = parentCard?.topic || context.sessionTitles[parent] || parentCard?.sessionTitle || parent.slice(0, 8);
      role = `child of ${name}`;
    } else {
      role = "child";
    }
  }
  return {
    icon: providerIconKey(card),
    provider: [plan, model].filter(Boolean).join(" · ") || null,
    effort: effort || null,
    child: role,
    workspace: workspaceName(card, context.home),
  };
}

/**
 * The agent line for an agent the manager lists, as a card's: the provider, effort and, for a child, `child`
 * (the detail's crumbs name the parent and the workspace, so the line leaves them out).
 */
export function managerAgentLine(agent: Pick<ManagerAgent, "provider" | "model" | "meta" | "parentId">, host: QueueCard["host"] = "paseo"): AgentLine {
  const meta = agent.meta ?? {};
  return {
    icon: providerIconKey({ host, provider: agent.provider }),
    provider: [meta.plan || agent.provider, meta.modelLabel || shortModel(agent.model)].filter(Boolean).join(" · ") || null,
    effort: meta.effortLabel || meta.effort || null,
    child: agent.parentId ? "child" : null,
    workspace: null,
  };
}

/** What a tile's first chip names: the provider logo, the model (the provider id when the host names none) and the effort; the plan stays in the detail. */
export interface TileLine {
  icon: ProviderIconKey | null;
  model: string | null;
  effort: string | null;
}

export function managerTileLine(agent: Pick<ManagerAgent, "provider" | "model" | "meta">, host: QueueCard["host"] = "paseo"): TileLine {
  const meta = agent.meta ?? {};
  return {
    icon: providerIconKey({ host, provider: agent.provider }),
    model: meta.modelLabel || shortModel(agent.model) || agent.provider || null,
    effort: meta.effortLabel || meta.effort || null,
  };
}
