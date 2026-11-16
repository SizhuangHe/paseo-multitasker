// Which of three states an agent is in for the agent manager: Needs you (the next step is the
// user's), Working (the agent is at it) or Done (nobody has to do anything; it can be archived).
// Paseo's status, the agent's open queue cards and a few fixed rules decide it; when the rules
// cannot tell, the agent is Needs you and marked inferred, never Done. Pure, so the server, the
// screen and the tests share it.

export type AgentState = "needs_you" | "working" | "done";

export const AGENT_STATES: readonly AgentState[] = ["needs_you", "working", "done"];

/**
 * What decided the state:
 * - card: it has an open queue card (permission and error cards included);
 * - permission: Paseo holds a permission request for it;
 * - running: Paseo runs it (running or initializing);
 * - signed_off: its last message signs off (`signsOff`);
 * - marked: the user tapped Mark done after its latest activity;
 * - child: it was started by another agent that is not archived, so its result goes there;
 * - classified: a classifier read its last message (none in this version, see `IdleClassifier`);
 * - inferred: none of the above.
 */
export type StateReason = "card" | "permission" | "running" | "signed_off" | "marked" | "child" | "classified" | "inferred";

export interface AgentStatus {
  state: AgentState;
  reason: StateReason;
  /** The rules could not tell: the state is a guess (`Idle` on screen). */
  inferred: boolean;
}

/** What the rules look at, for one agent. */
export interface StateFacts {
  /** Paseo's status: initializing, idle, running, error or closed. */
  status: string;
  pendingPermissions: number;
  /** The agent's open queue cards. */
  openCards: number;
  /** Its last assistant message signs off. */
  signedOff: boolean;
  /** When the user last tapped Mark done on it; null when never. */
  markedAt: string | null;
  lastActivityAt: string;
  /** It carries a parent (`paseo.parent-agent-id`). */
  isChild: boolean;
  /** That parent is among the non-archived agents. */
  parentLive: boolean;
}

/**
 * The seam for a cheap-model classifier: given an idle agent the rules left open, say Done or Needs
 * you, or null when unsure. Not used in this version; a later one would read the last message on the
 * server and pass its verdicts in here. A verdict still shows as inferred.
 */
export type IdleClassifier = (facts: StateFacts) => "done" | "needs_you" | null;

/** Paseo statuses in which the agent is at work. */
const WORKING_STATUSES: readonly string[] = ["running", "initializing"];

/** Whether Paseo runs the agent (running or initializing): the fact behind Working, and behind `runsWhileWaiting`. */
export const isRunning = (paseoStatus: string): boolean => WORKING_STATUSES.includes(paseoStatus);

/** Needs you because of a card or permission request, yet Paseo is still running it: it may settle the ask itself. */
export const runsWhileWaiting = (verdict: AgentStatus, paseoStatus: string): boolean =>
  verdict.state === "needs_you" && !verdict.inferred && isRunning(paseoStatus);

/**
 * The sign-off rules. An agent's last message says it finished when it holds every pattern of one rule.
 * Kept small on purpose: a finished agent typically ends with a short "done" and a goodbye.
 * - en: "done", "finished" or "complete(d)", and "goodbye" or "bye".
 */
export const SIGN_OFF_RULES: readonly { id: string; all: readonly RegExp[] }[] = [
  { id: "en", all: [/\b(?:done|finished|completed?)\b/i, /\b(?:good-?bye|bye)\b/i] },
];

/** Whether a last assistant message signs off under `SIGN_OFF_RULES`. */
export function signsOff(message: string | null | undefined): boolean {
  if (!message) return false;
  return SIGN_OFF_RULES.some((rule) => rule.all.every((pattern) => pattern.test(message)));
}

/**
 * The agent's state, by these rules in order:
 * 1. an open card or a pending permission request: Needs you, even while it runs;
 * 2. running or initializing: Working;
 * 3. otherwise (idle, closed, error) it is Done when its last message signs off, when the user marked it
 *    done at or after its latest activity, or when it is a child whose parent is not archived;
 * 4. else Needs you, inferred (a classifier, when given, may call it Done; still inferred).
 */
export function deriveState(facts: StateFacts, classify?: IdleClassifier): AgentStatus {
  if (facts.openCards > 0) return { state: "needs_you", reason: "card", inferred: false };
  if (facts.pendingPermissions > 0) return { state: "needs_you", reason: "permission", inferred: false };
  if (isRunning(facts.status)) return { state: "working", reason: "running", inferred: false };
  if (facts.signedOff) return { state: "done", reason: "signed_off", inferred: false };
  if (facts.markedAt && Date.parse(facts.markedAt) >= Date.parse(facts.lastActivityAt)) {
    return { state: "done", reason: "marked", inferred: false };
  }
  if (facts.isChild && facts.parentLive) return { state: "done", reason: "child", inferred: false };
  const verdict = classify?.(facts) ?? null;
  if (verdict === "done") return { state: "done", reason: "classified", inferred: true };
  return { state: "needs_you", reason: verdict ? "classified" : "inferred", inferred: true };
}
