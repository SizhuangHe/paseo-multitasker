// Presentational agent manager: every non-archived Paseo agent (and every archived one that still has
// open cards) in one of three states (Needs you, Working, Done; shared/agent-state), nested under the
// agent that started it and grouped by workspace (shared/agent-tree). Three views on desktop: Tree
// (agents as card tiles joined by connectors, the default; shared/agent-diagram), Columns (one column
// per state, one card tile per agent; agents-board) and List (a compact tree beside the detail); a
// phone always shows the list and opens the detail full screen. The detail shows an agent's open cards
// with the card components and their actions. Archive all asks first, listing exactly what it will
// archive.
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { cardNodeOrder, TILE } from "../shared/agent-diagram";
import { askChoices, askKind, cardKind, singleItem } from "../shared/cards";
import { stepCard, viewOrderCards, type KeyAction } from "../shared/agent-keys";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ancestors, archivePlan, buildForest, idleInferred, mostPressing, rowTime, subtree, type AgentNode } from "../shared/agent-tree";
import type { ClosedCards, ManagerAgent, QueueCard } from "../shared/rpc";
import { AgentDetail } from "./agents-detail";
import { Board } from "./agents-board";
import { useAgentKeys } from "./agents-keys";
import { Diagram } from "./agents-diagram";
import {
  AgentRow,
  CardRow,
  MoreRow,
  flatten,
  Header,
  agentKey,
  STATE_LABEL,
  StateMark,
  U,
  useManagerStyles,
  WorkspaceRow,
  wsKey,
  type ManagerCtx,
  type ManagerView,
} from "./agents-bits";
import type { CardCallbacks } from "./queue-client";
import { pressStyle, useCardState, useStyles, withoutDropped, type QueueData, type QueueViewProps } from "./queue-view";

export type { ManagerView } from "./agents-bits";

export interface AgentsData {
  now: string;
  agents: ManagerAgent[];
  /** Mark done taps: agent id → when. */
  marks: Record<string, string>;
}

export interface AgentsViewProps {
  theme: PluginTheme;
  compact: boolean;
  agents: AgentsData;
  /** The queue's open cards and what the card components need beside them. */
  queue: QueueData;
  /** Milliseconds since `agents` was fetched, so times keep moving between polls. */
  clockSkewMs?: number;
  /** The latest poll failed: what is shown is the last snapshot. */
  offline?: boolean;
  view: ManagerView;
  onView(view: ManagerView): void;
  /** The agent whose detail is open; on the desktop List, null opens the most pressing one. */
  selectedAgent: string | null;
  onSelectAgent(agentId: string | null): void;
  /** The card open in full inside the detail. */
  selectedCard: string | null;
  onSelectCard(cardId: string | null): void;
  /** Fold state by `ws:<name>` and `agent:<id>`, read and written here; the screen keeps it. */
  folds: Map<string, boolean>;
  cards: CardCallbacks;
  onMarkDone(agentId: string): void;
  onReply(agentId: string, text: string): Promise<boolean>;
  marking?: string | null;
  /** Marks these agents done, one call each, and settles when all are done. */
  onMarkDoneMany(agentIds: string[]): Promise<void>;
  /** Archives these agents, deepest first, and settles when all calls are done. */
  onArchive(agentIds: string[]): Promise<void>;
  onOpenAgent: ((agentId: string) => void) | null;
  /** Start with the Archive all dialog open. */
  defaultArchiveOpen?: boolean;
  /** A hook giving a session's closed cards for its detail; without it the detail lists none. */
  useClosed?(host: QueueCard["host"], sessionId: string, limit?: number): ClosedCards | undefined;
}

const noClosed = () => undefined;

const panelWidth = (width: number) => (width >= 1300 ? 480 : 420);
/** Below this panel width the card footer's buttons no longer fit on one row at desktop spacing. */
const FOOTER_ROOM = 460;
const listWidth = (width: number) => (width >= 1300 ? 440 : 380);
/** How long a close by key may take before the next card stops waiting for it. */
const ADVANCE_MS = 10_000;

// ---- views ------------------------------------------------------------------------

/** Every workspace with its rows, one agent per line. */
function TreeList({ ctx }: { ctx: ManagerCtx }) {
  return (
    <View style={{ gap: 10 }}>
      {ctx.forest.workspaces.map((ws) => (
        <View key={ws.name}>
          <WorkspaceRow name={ws.name} nodes={ws.roots.flatMap(subtree)} ctx={ctx} />
          {ctx.folded(wsKey(ws.name))
            ? null
            : flatten(ws.roots, ctx).map((row) => (
                <Fragment key={row.node.agent.id}>
                  <AgentRow row={row} ctx={ctx} cards />
                  {row.node.status.state === "needs_you" && !ctx.folded(agentKey(row.node.agent.id))
                    ? [
                        ...cardNodeOrder(row.node.cards)
                          .slice(0, TILE.maxCards)
                          .map((card) => <CardRow key={card.id} node={row.node} card={card} depth={row.depth} base={U} ctx={ctx} />),
                        <MoreRow key="more" node={row.node} depth={row.depth} base={U} ctx={ctx} />,
                      ]
                    : null}
                </Fragment>
              ))}
        </View>
      ))}
    </View>
  );
}

const GAP = 14;
const PAD = 24;
// ---- Archive all -------------------------------------------------------------------

/**
 * The confirm dialog: every Done agent it will archive, and the Done agents it keeps because work under
 * them is still open (archiving an agent in Paseo archives the agents it started too).
 */
function ArchiveDialog(props: { ctx: ManagerCtx; open: boolean; busy: boolean; onOpenChange(open: boolean): void; onConfirm(nodes: AgentNode[]): void }) {
  const { ctx } = props;
  const { s, m, theme, nowMs, compact } = ctx;
  const plan = archivePlan(ctx.forest);
  const count = plan.archive.length;
  const muted = theme.colors.foregroundMuted;
  // A phone has no room for the title and the lineage on one line: the title keeps the row and the
  // lineage goes under it, so what is about to be archived stays readable.
  const row = (node: AgentNode) => {
    const lineage = [node.workspace, ...ancestors(node).map((parent) => parent.title)].join(" › ");
    if (compact) {
      return (
        <View key={node.agent.id} style={[m.row, { height: "auto", gap: 8, paddingLeft: 2, paddingVertical: 6, alignItems: "flex-start" }]}>
          <View style={{ marginTop: 1 }}>
            <StateMark state={node.status.state} ctx={ctx} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[m.title, { color: muted }]} numberOfLines={1}>
              {node.title}
            </Text>
            <Text style={[m.time, { fontSize: 11.5 }]} numberOfLines={1}>
              {lineage}
            </Text>
          </View>
          <Text style={[m.time, { flexShrink: 0, minWidth: 52, textAlign: "right", marginTop: 1 }]}>{rowTime(node, nowMs)}</Text>
        </View>
      );
    }
    return (
      <View key={node.agent.id} style={[m.row, { gap: 8, paddingLeft: 2 }]}>
        <StateMark state={node.status.state} ctx={ctx} />
        <Text style={[m.title, { color: muted }]} numberOfLines={1}>
          {node.title}
        </Text>
        <View style={m.fill} />
        <Text style={[m.time, { flexShrink: 1 }]} numberOfLines={1}>
          {lineage}
        </Text>
        <Text style={[m.time, { flexShrink: 0, minWidth: 52, textAlign: "right" }]}>{rowTime(node, nowMs)}</Text>
      </View>
    );
  };
  const label = [{ fontSize: 11.5, lineHeight: 15, fontWeight: "600" as const, letterSpacing: 0.6, color: muted }];
  return (
    <Modal title={count === 1 ? "Archive 1 done agent" : `Archive ${count} done agents`} open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        <View>{plan.archive.map(row)}</View>
        {plan.kept.length ? (
          <View>
            <Text style={[label, { marginBottom: 4 }]}>KEPT · OPEN WORK UNDER THEM</Text>
            {plan.kept.map(row)}
          </View>
        ) : null}
        <View style={[s.foot, { justifyContent: "flex-end" }]}>
          <Pressable accessibilityRole="button" onPress={() => props.onOpenChange(false)} style={pressStyle([s.button, s.secondary], s.hover, s)}>
            <Text style={s.secondaryText}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!count || props.busy}
            onPress={() => props.onConfirm(plan.archive)}
            style={pressStyle([s.button, s.primary, !count || props.busy ? s.disabled : null], {}, s)}
          >
            <Text style={s.primaryText}>{props.busy ? "Archiving…" : `Archive ${count}`}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

// ---- Mark idle done ----------------------------------------------------------------

/** The confirm dialog: the inferred agents idle over 24 h it will mark done, each with its idle time. */
function MarkIdleDialog(props: { ctx: ManagerCtx; nodes: AgentNode[]; open: boolean; busy: boolean; onOpenChange(open: boolean): void; onConfirm(nodes: AgentNode[]): void }) {
  const { ctx, nodes } = props;
  const { s, m, nowMs } = ctx;
  const count = nodes.length;
  return (
    <Modal title={count === 1 ? "Mark 1 agent done" : `Mark ${count} agents done`} open={props.open} onOpenChange={props.onOpenChange}>
      <Modal.Content>
        <View>
          {nodes.map((node) => (
            <View key={node.agent.id} style={node.agent.lastLine ? { paddingBottom: 6 } : null}>
              <View style={[m.row, { gap: 8, paddingLeft: 2 }]}>
                <StateMark state={node.status.state} inferred ctx={ctx} />
                <Text style={[m.title, { color: ctx.theme.colors.foregroundMuted }]} numberOfLines={1}>
                  {node.title}
                </Text>
                <View style={m.fill} />
                <Text style={[m.time, { flexShrink: 0, minWidth: 52, textAlign: "right" }]}>{rowTime(node, nowMs)}</Text>
              </View>
              {node.agent.lastLine ? (
                <Text style={[m.time, { paddingLeft: 22, marginTop: -4 }]} numberOfLines={1}>
                  {node.agent.lastLine}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
        <View style={[s.foot, { justifyContent: "flex-end" }]}>
          <Pressable accessibilityRole="button" onPress={() => props.onOpenChange(false)} style={pressStyle([s.button, s.secondary], s.hover, s)}>
            <Text style={s.secondaryText}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!count || props.busy}
            onPress={() => props.onConfirm(nodes)}
            style={pressStyle([s.button, s.primary, !count || props.busy ? s.disabled : null], {}, s)}
          >
            <Text style={s.primaryText}>{props.busy ? "Marking…" : "Mark done"}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

// ---- the screen -------------------------------------------------------------------------

export function AgentsView(props: AgentsViewProps) {
  const { theme, compact, view } = props;
  const s = useStyles(theme, compact);
  const m = useManagerStyles(theme, compact);
  const cards = useMemo(() => props.queue.cards.map(withoutDropped), [props.queue.cards]);
  const forest = useMemo(
    () => buildForest({ agents: props.agents.agents, cards, marks: props.agents.marks, home: props.queue.home }),
    [props.agents.agents, props.agents.marks, cards, props.queue.home],
  );
  const nowMs = Date.parse(props.agents.now) + (props.clockSkewMs ?? 0);
  const [, setFoldVersion] = useState(0);
  const [width, setWidth] = useState(0);
  const [archiveOpen, setArchiveOpen] = useState(props.defaultArchiveOpen ?? false);
  const [archiving, setArchiving] = useState(false);
  const [idleOpen, setIdleOpen] = useState(false);
  const [marking, setMarking] = useState(false);

  // A side panel can be about as wide as a phone; its cards take the spacing measured to fit there, and
  // the manager's own rows keep the screen's. The List gives its detail the rest of the row instead.
  const detailWidth = view === "list" ? Math.min(width - listWidth(width), 820) : panelWidth(width);
  // Before the first layout `width` is 0: keep the desktop spacing for that frame, not a dense flash.
  const cardDense = compact || (width > 0 && detailWidth < FOOTER_ROOM);
  const cardS = useStyles(theme, cardDense);
  const cardView: QueueViewProps = {
    theme,
    compact: cardDense,
    data: { ...props.queue, cards },
    selectedId: props.selectedCard,
    onSelect: props.onSelectCard,
    ...props.cards,
  };
  const cardState = useCardState(cardView);

  // The desktop List always shows a detail: the chosen agent, else the most pressing one.
  const chosen = props.selectedAgent ? forest.byId.get(props.selectedAgent) ?? null : null;
  const selected = chosen ?? (!compact && view === "list" ? mostPressing(forest) : null);
  const select = (agentId: string | null) => {
    props.onSelectAgent(agentId);
    props.onSelectCard(null);
  };

  const ctx: ManagerCtx = {
    theme,
    s,
    cardS,
    m,
    compact,
    forest,
    nowMs,
    view: cardView,
    cardState,
    selected: selected?.agent.id ?? null,
    select,
    selectCard: (agentId, cardId) => {
      props.onSelectAgent(agentId);
      props.onSelectCard(cardId);
    },
    folded: (key) => props.folds.get(key) ?? false,
    toggle: (key) => {
      props.folds.set(key, !(props.folds.get(key) ?? false));
      setFoldVersion((version) => version + 1);
    },
    markDone: (node) => {
      props.onMarkDone(node.agent.id);
      // On a phone the detail is where Mark done lives; back to the list, ready for the next one. There are
      // usually several inferred agents to clear and the detail of a Done one has nothing to say.
      if (compact) select(null);
    },
    reply: (node, text) => props.onReply(node.agent.id, text),
    marking: props.marking ?? null,
    openAgent: props.onOpenAgent,
    seenMany: props.cards.onSeenMany ?? null,
    reopen: props.cards.onReopen ?? null,
    useClosed: props.useClosed ?? noClosed,
  };

  // Keys: j/k walk the open cards in the order this view lists them; Escape is `‹ Agent`.
  // Not memoized: the fold map is mutated in place and a fold toggle re-renders this component.
  const order = viewOrderCards(forest, view, { agent: (id) => props.folds.get(agentKey(id)) ?? false, workspace: (name) => props.folds.get(wsKey(name)) ?? false });
  // Keys can arrive faster than a render: step from the card the last key opened, not the last one drawn.
  const open = useRef(props.selectedCard);
  open.current = props.selectedCard;
  const openCard = props.selectedCard ? cards.find((card) => card.id === props.selectedCard) ?? null : null;
  const sole = openCard ? singleItem(openCard) : null;
  const ask = sole?.kind === "ask" ? sole.item : null;
  const kind = openCard ? cardKind(openCard) : null;
  const idle = openCard !== null && Boolean(props.cards.onAnswer) && props.cards.busyCardId !== openCard.id;
  const picks = openCard ? cardState.answersFor(openCard) : {};
  const reply = openCard ? cardState.reply(openCard) : "";

  // After a close by key, the card that followed it opens instead of the agent. The close itself clears the
  // selection (onClosed), so the follower waits here; a close that never comes expires, and so does any
  // other change of the selection.
  const advance = useRef<{ from: string; to: { agentId: string; cardId: string } | null; at: number } | null>(null);
  const closeByKey = (card: QueueCard) => {
    const at = order.findIndex((stop) => stop.cardId === card.id);
    advance.current = { from: card.id, to: at < 0 ? null : order[at + 1] ?? null, at: Date.now() };
  };
  useEffect(() => {
    const pending = advance.current;
    if (!pending) return;
    if (props.selectedCard !== null) {
      if (props.selectedCard !== pending.from) advance.current = null;
      return;
    }
    advance.current = null;
    if (pending.to && Date.now() - pending.at < ADVANCE_MS) ctx.selectCard(pending.to.agentId, pending.to.cardId);
  }, [props.selectedCard]);

  // A close that ends with its card still open failed: nothing is following it.
  const wasBusy = useRef<string | null>(null);
  useEffect(() => {
    const pending = advance.current;
    if (pending && props.cards.busyCardId === null && wasBusy.current === pending.from && props.selectedCard === pending.from) advance.current = null;
    wasBusy.current = props.cards.busyCardId ?? null;
  }, [props.cards.busyCardId]);

  const onKey = (action: KeyAction) => {
    if (action.type === "step") {
      advance.current = null;
      const stop = stepCard(order, open.current, action.direction, props.selectedAgent);
      if (stop) {
        open.current = stop.cardId;
        ctx.selectCard(stop.agentId, stop.cardId);
      }
      return;
    }
    if (!openCard) return;
    if (action.type === "back") {
      advance.current = null;
      props.onSelectCard(null);
    } else if (action.type === "pick" && ask) {
      cardState.actions.pick(openCard, ask, action.index);
    } else if (action.type === "send") {
      closeByKey(openCard);
      props.cards.onAnswer?.(openCard, picks, reply);
    } else if (action.type === "seen") {
      closeByKey(openCard);
      props.cards.onDone(openCard);
    } else if (action.type === "session") {
      props.cards.onOpenSession?.(openCard);
    }
  };
  useAgentKeys({
    enabled: !compact,
    openCardId: props.selectedCard,
    context: {
      dialogOpen: archiveOpen || idleOpen,
      card: openCard && kind
        ? {
            kind,
            choices: kind === "ask" && ask && askKind(ask) !== "plain" && idle ? askChoices(ask).length : 0,
            // as the detail's Send: a pick or reply text on an ask, reply text on a result
            sendReady: idle && (kind === "ask" || kind === "result") && (Object.keys(picks).length > 0 || reply.trim() !== ""),
          }
        : null,
    },
    onAction: onKey,
  });

  const archive = (nodes: AgentNode[]) => {
    // Deepest first, so each listed agent is archived by its own call, not by its parent's cascade.
    const ids = [...nodes].sort((a, b) => ancestors(b).length - ancestors(a).length).map((node) => node.agent.id);
    setArchiving(true);
    void props.onArchive(ids).finally(() => {
      setArchiving(false);
      setArchiveOpen(false);
    });
  };

  const idleNodes = idleInferred(forest, nowMs);
  const markIdle = (nodes: AgentNode[]) => {
    setMarking(true);
    void props.onMarkDoneMany(nodes.map((node) => node.agent.id)).finally(() => {
      setMarking(false);
      setIdleOpen(false);
    });
  };

  const header = (
    <Header ctx={ctx} view={view} offline={props.offline} onView={props.onView} onArchive={() => setArchiveOpen(true)} idle={idleNodes.length} onMarkIdle={() => setIdleOpen(true)} />
  );
  const dialog = (
    <>
      <ArchiveDialog ctx={ctx} open={archiveOpen} busy={archiving} onOpenChange={setArchiveOpen} onConfirm={archive} />
      <MarkIdleDialog ctx={ctx} nodes={idleNodes} open={idleOpen} busy={marking} onOpenChange={setIdleOpen} onConfirm={markIdle} />
    </>
  );
  const empty = forest.total === 0 ? <Text style={m.empty}>No agents</Text> : null;

  if (compact) {
    return (
      <View style={m.page}>
        {selected ? (
          <ScrollView key={`detail:${selected.agent.id}:${props.selectedCard ?? ""}`} style={{ flex: 1 }}>
            <AgentDetail node={selected} ctx={ctx} mode="screen" onClose={() => select(null)} />
          </ScrollView>
        ) : (
          <ScrollView key="list" style={{ flex: 1 }}>
            {header}
            {empty ?? (
              <View style={{ paddingHorizontal: 8, paddingBottom: 40 }}>
                <TreeList ctx={ctx} />
              </View>
            )}
          </ScrollView>
        )}
        {dialog}
      </View>
    );
  }

  // The List always shows a detail, so its detail has no close.
  const detail = (node: AgentNode, closable: boolean) => (
    <ScrollView key={`detail:${node.agent.id}:${props.selectedCard ?? ""}`} style={{ flex: 1 }}>
      <AgentDetail node={node} ctx={ctx} mode="panel" onClose={closable ? () => select(null) : null} />
    </ScrollView>
  );

  let body;
  if (view === "list") {
    body = (
      <>
        <View style={[{ width: listWidth(width), borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.colors.border }]}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingLeft: 14, paddingRight: 12, paddingTop: 12, paddingBottom: 32 }}>
            {empty ?? <TreeList ctx={ctx} />}
          </ScrollView>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {selected ? (
            <View style={{ flex: 1, width: "100%", maxWidth: 820, paddingLeft: 12 }}>{detail(selected, false)}</View>
          ) : null}
        </View>
      </>
    );
  } else {
    const panel = selected ? panelWidth(width) : 0;
    const mainWidth = width - panel;
    body = (
      <>
        <View style={m.main}>
          {view === "columns" && !empty ? (
            width ? <Board ctx={ctx} /> : null
          ) : (
            <ScrollView style={{ flex: 1 }}>
              {empty ?? (width ? <Diagram ctx={ctx} width={mainWidth} /> : null)}
            </ScrollView>
          )}
        </View>
        {selected ? <View style={[m.panel, { width: panel }]}>{detail(selected, true)}</View> : null}
      </>
    );
  }

  return (
    <View style={m.page} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {header}
      <View style={m.body}>{body}</View>
      {dialog}
    </View>
  );
}
