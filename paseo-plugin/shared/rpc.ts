// RPC contracts between the Multitasker screen and the plugin subprocess.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const AskOptionSchema = z.object({
  label: z.string(),
  effect: z.string().optional(),
});

/** What a host permission ask offers (see core HostPermission). */
export const HostPermissionSchema = z.object({
  requestId: z.string(),
  detail: z.string().optional(),
  choices: z.array(z.object({ id: z.string(), label: z.string(), behavior: z.enum(["allow", "deny"]) })).optional(),
  questions: z.array(z.object({ header: z.string(), question: z.string(), options: z.array(z.string()) })).optional(),
});

export const AskSchema = z.object({
  id: z.string(),
  question: z.string(),
  short: z.string().optional(),
  options: z.array(AskOptionSchema).optional(),
  recommended: z.number().int().optional(),
  whyNow: z.string().optional(),
  recommendation: z.string().optional(),
  why: z.string().optional(),
  resolved: z.boolean(),
  dropped: z.boolean().optional(),
  permission: HostPermissionSchema.optional(),
});

export const ResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  href: z.string().optional(),
  note: z.string().optional(),
  look: z.string().optional(),
  resolved: z.boolean(),
  dropped: z.boolean().optional(),
});

export const ReceiptSchema = z.object({
  id: z.string(),
  trackId: z.string().optional(),
  title: z.string(),
  status: z.enum(["returned", "failed"]),
  conclusion: z.string(),
  line: z.string().optional(),
  childRef: z.string().optional(),
  resolved: z.boolean(),
});

const TimelineStepSchema = z.object({ date: z.string().optional(), text: z.string() });

export const TimelineSchema = z.object({
  asked: TimelineStepSchema.extend({ date: z.string() }),
  did: TimelineStepSchema,
  stuck: z.object({ text: z.string() }),
});

/** Which agent a card comes from, in the host's display names (see core AgentMeta). */
export const AgentMetaSchema = z.object({
  plan: z.string().nullable().optional(),
  modelLabel: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  effortLabel: z.string().nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  workspace: z.string().nullable().optional(),
});

/** Where in the Multitasker screen a close came from (see core CloseOrigin); older clients omit it. */
export const CloseOriginSchema = z.object({
  compact: z.boolean().optional(),
  view: z.enum(["tree", "columns", "list"]).optional(),
  batch: z.literal(true).optional(),
});
export type CloseOrigin = z.infer<typeof CloseOriginSchema>;

/** How the user closed a card from the queue (see core Closing). */
export const ClosingSchema = CloseOriginSchema.extend({
  via: z.enum(["send", "seen", "dismiss", "permission"]),
  at: z.string(),
  picks: z.array(z.object({ askId: z.string(), short: z.string(), label: z.string(), recommended: z.boolean() })).optional(),
  reply: z.string().optional(),
});

export const CardSchema = z.object({
  id: z.string(),
  host: z.enum(["paseo"]),
  sessionId: z.string(),
  sessionTitle: z.string().nullable(),
  cwd: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  agent: AgentMetaSchema.nullable(),
  topic: z.string().nullable(),
  timeline: TimelineSchema.nullable(),
  action: z.string(),
  summary: z.string(),
  context: z.string(),
  asks: z.array(AskSchema),
  results: z.array(ResultSchema),
  receipts: z.array(ReceiptSchema),
  state: z.enum(["open", "done"]),
  firstReadyAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  doneAt: z.string().nullable(),
  doneBy: z.enum(["agent", "user"]).nullable(),
  /** The card that replaced this one (`replaces`); null otherwise. Optional: older daemons do not send it. */
  supersededBy: z.string().nullable().optional(),
  /** When the user pressed Discuss on it; null otherwise. Optional: older daemons do not send it. */
  discussingAt: z.string().nullable().optional(),
  /** How the user closed it from the queue; null otherwise. Optional: older daemons do not send it. */
  closing: ClosingSchema.nullable().optional(),
});

export const TrackSchema = z.object({
  id: z.string(),
  host: z.enum(["paseo"]),
  parentSessionId: z.string().nullable(),
  childRef: z.string().nullable(),
  title: z.string(),
  startedAt: z.string(),
  state: z.enum(["running", "returned", "failed"]),
  endedAt: z.string().nullable(),
});

export type QueueCard = z.infer<typeof CardSchema>;
export type QueueAsk = z.infer<typeof AskSchema>;
export type QueueTrack = z.infer<typeof TrackSchema>;

/** Open cards in queue order; `now` is the daemon clock for wait times. */
export const listQueue = defineRpc({
  name: "queue.list",
  input: z.object({}),
  output: z.object({
    now: z.string(),
    cards: z.array(CardSchema),
    /**
     * Names for the parent sessions child cards point to, keyed by session id: the topic that session's
     * agent filed under last, else the host's title for it.
     */
    sessionTitles: z.record(z.string(), z.string()),
    /**
     * Card sessions that a registered dispatch started, with the dispatching session (null when it
     * is unknown). The fallback for children the host does not label with a parent.
     */
    childOf: z.record(z.string(), z.string().nullable()),
    /** The daemon's home directory, to show a cwd as ~/…. */
    home: z.string().nullable(),
  }),
});

/** The most closed cards `queue.closed` returns at once. */
export const CLOSED_MAX = 500;

export const ClosedCardsSchema = z.object({
  /** The latest closed first. */
  cards: z.array(CardSchema),
  /** How many closed cards the session has in all; more than `cards` holds past the limit. */
  total: z.number().int().min(0),
});
export type ClosedCards = z.infer<typeof ClosedCardsSchema>;

/** A session's closed cards, the latest closed first (30 unless `limit` says otherwise; `Show all` asks for up to 500). */
export const listClosed = defineRpc({
  name: "queue.closed",
  input: z.object({ host: z.enum(["paseo"]), sessionId: z.string(), limit: z.number().int().min(1).max(CLOSED_MAX).optional() }),
  output: ClosedCardsSchema,
});

export const snoozeCard = defineRpc({
  name: "queue.snooze",
  input: z.object({ cardId: z.string() }),
  output: z.object({ card: CardSchema }),
});

/**
 * Dismiss: closes the card. When it still has open agent asks on a Paseo card, it first tells the
 * session which ones were skipped; if that send fails, the card stays open.
 */
export const markCardDone = defineRpc({
  name: "queue.done",
  input: z.object({ cardId: z.string(), origin: CloseOriginSchema.optional() }),
  output: z.object({ card: CardSchema }),
});

/** Reopen: puts a card the user closed with Seen back to open. Any other closed card is refused. */
export const reopenCard = defineRpc({
  name: "queue.reopen",
  input: z.object({ cardId: z.string() }),
  output: z.object({ card: CardSchema }),
});

/**
 * Send: sends the picks (ask id → option index) and the reply into the card's session as one message,
 * then hands the card back (every item resolved, card closed). Paseo cards only.
 */
export const sendAnswers = defineRpc({
  name: "queue.answer",
  input: z.object({
    cardId: z.string(),
    picks: z.record(z.string(), z.number().int().min(0)),
    /** The user's own words, sent as the message's last line. */
    reply: z.string().max(4000).optional(),
    origin: CloseOriginSchema.optional(),
  }),
  output: z.object({ card: CardSchema }),
});

/**
 * Discuss: sends one message asking the card's session to talk it over, then tags the card
 * (`discussingAt`); it stays open. A card already tagged sends nothing (`sent: false`). Paseo agent
 * cards only (asks, results, receipts).
 */
export const startDiscussion = defineRpc({
  name: "queue.discuss",
  input: z.object({ cardId: z.string() }),
  output: z.object({ card: CardSchema, sent: z.boolean() }),
});

/** The user's answer to a permission ask: one choice (its id), or one option label per question header. */
export const PermissionAnswerSchema = z.union([
  z.object({ actionId: z.string() }),
  z.object({ answers: z.record(z.string(), z.string()) }),
]);
export type PermissionAnswer = z.infer<typeof PermissionAnswerSchema>;

/** allowed / denied: a choice went through; sent: question answers did; stale: no longer pending, nothing sent. */
export const PermissionOutcomeSchema = z.enum(["allowed", "denied", "sent", "stale"]);
export type PermissionOutcome = z.infer<typeof PermissionOutcomeSchema>;

/**
 * Answers a permission ask right away, apart from Send: the session is blocked on it. `stale` means
 * the request was no longer pending, so nothing was sent and the ask is resolved.
 */
export const answerPermission = defineRpc({
  name: "queue.permission",
  input: z.object({
    cardId: z.string(),
    askId: z.string(),
    answer: PermissionAnswerSchema,
    origin: CloseOriginSchema.optional(),
  }),
  output: z.object({ outcome: PermissionOutcomeSchema, card: CardSchema.nullable() }),
});

// ---- agent manager ----------------------------------------------------------------

/**
 * One non-archived Paseo agent as the agent manager needs it: its Paseo status and lineage, who it is
 * (for the agent line), its times, and what its last message says. Only facts; the three states are
 * derived from these and the open cards (shared/agent-state).
 */
export const ManagerAgentSchema = z.object({
  id: z.string(),
  /** Paseo's title. */
  title: z.string().nullable(),
  /** Paseo's status: initializing, idle, running, error or closed (kept open for newer hosts). */
  status: z.string(),
  /** The `paseo.parent-agent-id` label: the agent that started this one; null for a top-level agent. */
  parentId: z.string().nullable(),
  /** The Paseo workspace name, null when it has none. */
  workspace: z.string().nullable(),
  cwd: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  /** Display names for the agent line (plan, model label, effort). */
  meta: AgentMetaSchema.nullable(),
  createdAt: z.string(),
  /** When the turn running now started (Paseo's `activeTurn.startedAt`); null between turns or when the host does not say. */
  turnStartedAt: z.string().nullable(),
  /** The agent's latest activity: its newest timeline entry or user message, else Paseo's `updatedAt`. */
  lastActivityAt: z.string(),
  /** Permission requests Paseo holds open for it. */
  pendingPermissions: z.number().int().min(0),
  /** Its last assistant message ends the work in the sign-off words (shared/agent-state `signsOff`). */
  signedOff: z.boolean(),
  /** The first line of its last assistant message, when the manager read it; null otherwise. */
  lastLine: z.string().nullable(),
  /** `lastLine` is the question the manager found in the final message (not a sign-off or first line). Optional: older servers do not send it. */
  lastLineAsks: z.boolean().optional(),
  /**
   * When Paseo archived it. Set only on an archived agent that is listed because it still has open
   * cards. Optional: older daemons do not send it.
   */
  archivedAt: z.string().nullable().optional(),
});
export type ManagerAgent = z.infer<typeof ManagerAgentSchema>;

/**
 * Every non-archived Paseo agent, plus archived ones that still have open cards, and the sessions the
 * user marked done (session id → when).
 */
export const listAgents = defineRpc({
  name: "manager.agents",
  input: z.object({}),
  output: z.object({
    now: z.string(),
    agents: z.array(ManagerAgentSchema),
    marks: z.record(z.string(), z.string()),
  }),
});

/** Mark done: the agent counts as Done until it does something new. */
export const markAgentDone = defineRpc({
  name: "manager.mark-done",
  input: z.object({ agentId: z.string() }),
  output: z.object({ markedAt: z.string() }),
});

/** Reply: sends the text into an agent's session as the user's message; for an agent that waits with no card. */
export const replyToAgent = defineRpc({
  name: "manager.reply",
  input: z.object({ agentId: z.string(), text: z.string().max(4000) }),
  output: z.object({}),
});

// ---- result preview ---------------------------------------------------------------

export const ResultPreviewSchema = z.object({
  kind: z.enum(["text", "image", "none"]),
  /** Text: the first lines of the file, each cut short. */
  text: z.string().optional(),
  shown: z.number().int().optional(),
  total: z.number().int().optional(),
  /** Image: base64 data. */
  mime: z.string().optional(),
  data: z.string().optional(),
});
export type ResultPreview = z.infer<typeof ResultPreviewSchema>;

/** A result's file as text or an image, read from the card's stored href only (never a client path). */
export const previewResult = defineRpc({
  name: "queue.preview",
  input: z.object({ cardId: z.string(), resultId: z.string() }),
  output: ResultPreviewSchema,
});
