// Pieces the agent manager's views share: styles, the state mark, per-state counts, the header (the
// counts double as the legend, then Archive all and the view switcher), the one-line agent row with its
// lineage rules, the muted ancestor header of Columns, workspace rows, and what a Needs you agent asks in
// one line. Colors come from the card components' theme tokens; color only carries state, and each state
// also has its own shape.
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { runsWhileWaiting, type AgentState } from "../shared/agent-state";
import { cardNodeLine, cardNodeOrder, cardTagWidth, CARD_NODE, foldLabel, TILE } from "../shared/agent-diagram";
import { countStates, inferredIn, markCounts, rowTime, subtree, type AgentForest, type AgentNode, type MarkCount } from "../shared/agent-tree";
import { countsLine, questionLine, singleItem } from "../shared/cards";
import { lineTone, type Tone } from "../shared/card-tone";
import type { ClosedCards, QueueCard } from "../shared/rpc";
import { cardCounts, cardKind, elapsed, hostAskLine, mix } from "./format";
import { useScrollIntoView } from "./agents-keys";
import { Chevron, pressStyle, type CardState, type QueueViewProps, type Styles } from "./queue-view";
import { WorkspaceBadge } from "./workspace-badge";

export type ManagerView = "tree" | "columns" | "list";
export const VIEWS: readonly { id: ManagerView; label: string }[] = [
  { id: "tree", label: "Tree" },
  { id: "columns", label: "Columns" },
  { id: "list", label: "List" },
];

export const STATE_LABEL: Record<AgentState, string> = { needs_you: "Needs you", working: "Working", done: "Done" };

export function useManagerStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(() => {
    const c = theme.colors;
    const hairline = StyleSheet.hairlineWidth;
    const soft = mix(c.foreground, c.surface0, 0.13);
    const rule = mix(c.foregroundMuted, c.surface0, 0.62);
    return {
      soft,
      rule,
      ...StyleSheet.create({
        page: { flex: 1, minHeight: 0, backgroundColor: c.surface0 },
        // header: Multitasker 15 · the three states with their counts (the legend) · Archive all · views
        head: {
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          columnGap: 20,
          rowGap: 6,
          paddingHorizontal: compact ? 14 : 28,
          paddingTop: compact ? 16 : 20,
          paddingBottom: compact ? 10 : 14,
        },
        headTitle: { flexDirection: "row", alignItems: "baseline", gap: 8, marginRight: 8 },
        headText: { color: c.foreground, fontSize: 20, lineHeight: 26, fontWeight: "600" },
        headOffline: { color: c.statusDanger, fontSize: 13, lineHeight: 26 },
        headCount: { color: c.foregroundMuted, fontSize: 20, lineHeight: 26, fontVariant: ["tabular-nums"] },
        legend: { flexDirection: "row", alignItems: "center", gap: compact ? 12 : 18 },
        legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
        legendText: { color: c.foregroundMuted, fontSize: 13, lineHeight: 18 },
        legendNum: { color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600", fontVariant: ["tabular-nums"] },
        archive: { height: 28, paddingHorizontal: 10, borderRadius: 7, justifyContent: "center", borderWidth: hairline, borderColor: c.border, backgroundColor: c.surface1 },
        archiveText: { color: c.foreground, fontSize: 12.5, fontWeight: "500" },
        switcher: { flexDirection: "row", marginLeft: "auto", padding: 2, borderRadius: 8, borderWidth: hairline, borderColor: c.border, backgroundColor: c.surface1 },
        switch: { height: 24, paddingHorizontal: 10, borderRadius: 6, justifyContent: "center" },
        switchOn: { backgroundColor: c.surface2 },
        switchText: { color: c.foregroundMuted, fontSize: 12.5, fontWeight: "500" },
        switchTextOn: { color: c.foreground },
        body: { flex: 1, minHeight: 0, flexDirection: "row", borderTopWidth: hairline, borderTopColor: c.border },
        main: { flex: 1, minWidth: 0 },
        panel: { borderLeftWidth: hairline, borderLeftColor: c.border },
        empty: { color: c.foregroundMuted, fontSize: 14, padding: compact ? 16 : 32 },

        // the state mark
        glyph: { width: 12, height: 18, alignItems: "center", justifyContent: "center" },
        dot: { width: 8, height: 8, borderRadius: 4 },
        ring: { width: 9, height: 9, borderRadius: 4.5, borderWidth: 2 },
        check: { fontSize: 11, lineHeight: 14, fontWeight: "700", color: c.foregroundMuted },

        // per-state counts on folded rows: mark + number
        counts: { flexDirection: "row", alignItems: "center", gap: 9 },
        count: { flexDirection: "row", alignItems: "center", gap: 3 },
        countNum: { color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] },

        // one agent per line
        row: { flexDirection: "row", alignItems: "center", height: compact ? 36 : 30, paddingRight: 8, borderRadius: 6 },
        rowSelected: { backgroundColor: c.surface2 },
        rowBody: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
        chev: { width: 12, alignItems: "center" },
        title: { flexShrink: 1, minWidth: 0, color: c.foreground, fontSize: 13.5, lineHeight: 18, fontWeight: "500" },
        titleSelected: { fontWeight: "600" },
        fill: { flex: 1, minWidth: 6 },
        time: { color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] },
        dim: { opacity: 0.5 },
        tag: { paddingHorizontal: 5, borderRadius: 4, borderWidth: hairline, borderColor: c.border, backgroundColor: c.surface2 },
        tagText: { color: c.foregroundMuted, fontSize: 10.5, lineHeight: 15 },

        // workspace rows
        wsRow: { flexDirection: "row", alignItems: "center", gap: 6, height: compact ? 36 : 30, paddingRight: 8, borderRadius: 6 },
        wsName: { flexShrink: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 12.5, lineHeight: 16, fontWeight: "600", letterSpacing: 0.2 },

        // Columns: a column per state, its header, a workspace label over its rows, an ancestor header
        column: {
          flex: 1,
          flexBasis: 0,
          minWidth: 0,
          backgroundColor: c.surface1,
          borderRadius: 12,
          borderWidth: hairline,
          borderColor: c.border,
          paddingHorizontal: 8,
          paddingTop: 6,
          paddingBottom: 10,
        },
        colHead: { flexDirection: "row", alignItems: "center", gap: 7, height: 36, paddingLeft: 4 },
        colLabel: { flexShrink: 1, minWidth: 0, color: c.foreground, fontSize: 14.5, lineHeight: 20, fontWeight: "600" },
        colCount: { color: c.foregroundMuted, fontSize: 14.5, lineHeight: 20, fontVariant: ["tabular-nums"] },
        colWs: { flexDirection: "row", alignItems: "center", gap: 6, height: 24, paddingLeft: 4, marginTop: 6 },
        ancestorTitle: { color: c.foregroundMuted, fontWeight: "400" },

        // a card as one line under its agent
        cardLine: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 22, borderRadius: 5, paddingRight: 6 },
        cardLineText: { flexShrink: 1, minWidth: 0, color: soft, fontSize: 12.5, lineHeight: 17 },
        cardLineGo: { color: c.foregroundMuted, fontSize: 13, lineHeight: 17 },
        quietButton: { height: 22, paddingHorizontal: 7, borderRadius: 5, justifyContent: "center", backgroundColor: c.surface2, borderWidth: hairline, borderColor: c.border },
        quietButtonText: { color: c.foreground, fontSize: 11.5, fontWeight: "500" },
      }),
    };
  }, [theme, compact]);
}

export type ManagerStyles = ReturnType<typeof useManagerStyles>;

/** What every view of the manager draws from: the forest, the styles, the card actions and the taps. */
export interface ManagerCtx {
  theme: PluginTheme;
  s: Styles;
  /** The card components' styles: the panel is about as wide as a phone, so its cards use that spacing. */
  cardS: Styles;
  m: ManagerStyles;
  compact: boolean;
  forest: AgentForest;
  nowMs: number;
  /** The card components' props (data and actions), for the cards in the detail. */
  view: QueueViewProps;
  cardState: CardState;
  selected: string | null;
  select(agentId: string | null): void;
  /** Opens one card of an agent in full in the detail (the Tree's card nodes). */
  selectCard(agentId: string, cardId: string): void;
  folded(key: string): boolean;
  toggle(key: string): void;
  markDone(node: AgentNode): void;
  /** Sends the text into the agent's session; true when it went (a failure is shown as a toast). */
  reply(node: AgentNode, text: string): Promise<boolean>;
  /** The agent a Mark done is on its way for. */
  marking: string | null;
  openAgent: ((agentId: string) => void) | null;
  /** Seen on each of these cards, settling when all went through; null where the screen cannot. */
  seenMany: ((cards: QueueCard[]) => Promise<void>) | null;
  /** Puts a card closed by Seen back to open; null where the screen cannot. */
  reopen: ((card: QueueCard) => Promise<void>) | null;
  /** A hook: the session's closed cards (`queue.closed`, `limit` as there), undefined until they are in. */
  useClosed(host: QueueCard["host"], sessionId: string, limit?: number): ClosedCards | undefined;
}

export const agentKey = (id: string) => `agent:${id}`;
export const wsKey = (name: string) => `ws:${name}`;

export function stateColor(theme: PluginTheme, state: AgentState): string {
  if (state === "needs_you") return theme.colors.statusWarning;
  if (state === "working") return theme.colors.statusSuccess;
  return theme.colors.foregroundMuted;
}

/** Needs you: a filled amber dot, an amber ring when inferred. Working: a green ring. Done: a muted check. Shape tells them apart without color. */
export function StateMark({
  state,
  inferred,
  ctx,
  style,
}: {
  state: AgentState;
  inferred?: boolean;
  ctx: Pick<ManagerCtx, "m" | "theme">;
  style?: ViewStyle;
}) {
  const { m, theme } = ctx;
  return (
    <View style={[m.glyph, style]}>
      {state === "done" ? (
        <Text style={m.check}>✓</Text>
      ) : state === "working" || inferred ? (
        <View style={[m.ring, { borderColor: stateColor(theme, state) }]} />
      ) : (
        <View style={[m.dot, { backgroundColor: stateColor(theme, state) }]} />
      )}
    </View>
  );
}

/** A Needs you agent that Paseo still runs: the Working ring and a muted `running`. Nothing for any other agent. */
export function RunningMark({ node, ctx }: { node: AgentNode; ctx: Pick<ManagerCtx, "m" | "theme"> }) {
  if (!runsWhileWaiting(node.status, node.agent.status)) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
      <View style={[ctx.m.ring, { width: 7, height: 7, borderRadius: 3.5, borderWidth: 1.5, borderColor: stateColor(ctx.theme, "working") }]} />
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 }}>running</Text>
    </View>
  );
}

export const markLabel = (item: MarkCount): string => (item.inferred ? "Idle" : STATE_LABEL[item.state]);

/** `● 1  ◌ 2  ○ 1  ✓ 2` over `nodes`, zeros left out. */
export function Counts({ nodes, ctx }: { nodes: readonly AgentNode[]; ctx: ManagerCtx }) {
  const { m } = ctx;
  return (
    <View style={m.counts}>
      {markCounts(countStates(nodes), inferredIn(nodes))
        .filter((item) => item.count > 0)
        .map((item) => (
          <View key={markLabel(item)} style={m.count}>
            <StateMark state={item.state} inferred={item.inferred} ctx={ctx} />
            <Text style={m.countNum}>{item.count}</Text>
          </View>
        ))}
    </View>
  );
}

/** Multitasker 15 (and Offline while the polls fail), then each state with its mark and count (the legend), then Mark N done (when any), Archive all, then the views on desktop. */
export function Header(props: {
  ctx: ManagerCtx;
  view: ManagerView;
  offline?: boolean;
  onView(view: ManagerView): void;
  onArchive(): void;
  /** Inferred agents idle over 24 h (`idleInferred`); the button shows only when there are some. */
  idle: number;
  onMarkIdle(): void;
}) {
  const { ctx, view } = props;
  const { m, s, forest, compact } = ctx;
  const done = forest.counts.done;
  return (
    <View style={m.head}>
      <View style={m.headTitle}>
        <Text style={m.headText}>Multitasker</Text>
        <Text style={m.headCount}>{forest.total}</Text>
        {props.offline ? <Text style={m.headOffline}>Offline</Text> : null}
      </View>
      <View style={m.legend}>
        {markCounts(forest.counts, inferredIn(forest.byId.values())).map((item) => (
          <View key={markLabel(item)} style={m.legendItem}>
            <StateMark state={item.state} inferred={item.inferred} ctx={ctx} />
            {compact && !item.inferred ? null : <Text style={m.legendText}>{markLabel(item)}</Text>}
            <Text style={m.legendNum}>{item.count}</Text>
          </View>
        ))}
      </View>
      {props.idle ? (
        <Pressable accessibilityRole="button" onPress={props.onMarkIdle} style={pressStyle(m.archive, s.hover, s)}>
          <Text style={m.archiveText}>Mark {props.idle} done</Text>
        </Pressable>
      ) : null}
      {done ? (
        <Pressable accessibilityRole="button" onPress={props.onArchive} style={pressStyle(m.archive, s.hover, s)}>
          <Text style={m.archiveText}>Archive all</Text>
        </Pressable>
      ) : null}
      {compact ? null : (
        <View style={m.switcher} accessibilityRole="tablist">
          {VIEWS.map((option) => {
            const on = option.id === view;
            return (
              <Pressable
                key={option.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => props.onView(option.id)}
                style={pressStyle([m.switch, on ? m.switchOn : null], s.hover, s)}
              >
                <Text style={[m.switchText, on ? m.switchTextOn : null]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ---- rows ------------------------------------------------------------------------

/** Indent per level. Lines sit under the parent's chevron. */
export const U = 18;
/** Where an agent row's title starts: chevron, mark and their gaps. Card rows and the line under an inferred title align to it. */
const TITLE_X = 38;

export interface FlatRow {
  node: AgentNode;
  depth: number;
}

/** The visible rows of a tree, depth first; a folded agent hides what is under it. */
export function flatten(roots: readonly AgentNode[], ctx: ManagerCtx): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: readonly AgentNode[], depth: number) => {
    for (const node of nodes) {
      out.push({ node, depth });
      if (node.children.length && !ctx.folded(agentKey(node.agent.id))) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/** One vertical rule per ancestor level; `own` adds the row's own level. */
function Rules({ depth, base, own, ctx }: { depth: number; base: number; own?: boolean; ctx: ManagerCtx }) {
  const levels = Array.from({ length: depth + (own ? 1 : 0) }, (_, index) => index + 1);
  return (
    <>
      {levels.map((level) => (
        <View
          key={level}
          pointerEvents="none"
          style={{ position: "absolute", left: base + (level - 1) * U + 5, top: 0, bottom: 0, width: 1, backgroundColor: ctx.m.rule }}
        />
      ))}
    </>
  );
}

/**
 * One agent on one line: lineage rules, chevron (when it has children), state mark, title, `archived`
 * on an archived agent with open cards, how many cards it holds
 * on the List's rows, per-state counts when folded, and its time at the right edge. `fold={false}` leaves
 * the chevron out (Columns, where a row's children may sit in other columns); `short` shows a Working
 * agent's run without its last activity (a narrow column).
 */
export function AgentRow(props: { row: FlatRow; ctx: ManagerCtx; base?: number; fold?: boolean; short?: boolean; cards?: boolean; onPress?(): void }) {
  const { row, ctx } = props;
  const base = props.base ?? U;
  const { m, s, theme } = ctx;
  const { node } = row;
  // The List's rows carry their open cards as rows under them, so they fold too.
  const foldable = (props.fold ?? true) && (node.children.length > 0 || (props.cards === true && node.cards.length > 0));
  const folded = foldable && ctx.folded(agentKey(node.agent.id));
  const cardOpen = props.cards === true && !folded && node.cards.some((card) => card.id === ctx.view.selectedId);
  const selected = ctx.selected === node.agent.id && !cardOpen;
  const done = node.status.state === "done";
  // Folded, the cards are not on screen: the row says how many.
  const held = props.cards && folded && node.cards.length ? foldLabel({ cards: node.cards.length, children: 0 }) : null;
  // An inferred agent on the List shows its line only when that line is the question it asks.
  const waiting = props.cards && node.status.inferred && node.agent.lastLineAsks ? node.agent.lastLine : null;
  const ref = useScrollIntoView(selected);
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={props.onPress ?? (() => ctx.select(node.agent.id))}
      style={pressStyle([m.row, { paddingLeft: base + row.depth * U }, waiting ? { height: "auto", minHeight: m.row.height, paddingVertical: 4 } : null, selected ? m.rowSelected : null], s.hover, s)}
    >
      <Rules depth={row.depth} base={base} ctx={ctx} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={[m.rowBody, { flex: 0 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={foldable ? (folded ? "Unfold" : "Fold") : undefined}
            accessibilityState={foldable ? { expanded: !folded } : undefined}
            disabled={!foldable}
            onPress={() => ctx.toggle(agentKey(node.agent.id))}
            style={[m.chev, { marginRight: -2 }]}
          >
            {foldable ? <Chevron open={!folded} s={s} /> : null}
          </Pressable>
          <View style={done ? m.dim : null}>
            <StateMark state={node.status.state} inferred={node.status.inferred} ctx={ctx} />
          </View>
          <Text style={[m.title, selected ? m.titleSelected : null, done ? { color: theme.colors.foregroundMuted } : null]} numberOfLines={1}>
            {node.title}
          </Text>
          <NodeTags node={node} ctx={ctx} />
          <RunningMark node={node} ctx={ctx} />
          {held ? (
            <Text style={[m.time, { flexShrink: 0 }]} numberOfLines={1}>
              {held}
            </Text>
          ) : null}
          <View style={m.fill} />
          {folded ? <Counts nodes={node.children.flatMap(subtree)} ctx={ctx} /> : null}
          <Text style={[m.time, { flexShrink: 0 }, done ? m.dim : null]} numberOfLines={1}>
            {rowTime(node, ctx.nowMs, props.short)}
          </Text>
        </View>
        {waiting ? (
          <Text style={[m.time, { paddingLeft: TITLE_X, paddingRight: 2 }]} numberOfLines={1}>
            {waiting}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * One open card as a row under its agent on the List: the kind tag, its line in one line and its wait at
 * the right, as the Tree's card node draws them. A tap opens the card in full.
 */
export function CardRow({ node, card, depth, base, ctx }: { node: AgentNode; card: QueueCard; depth: number; base: number; ctx: ManagerCtx }) {
  const { m, s, theme } = ctx;
  const c = theme.colors;
  const line = cardNodeLine(card);
  const selected = ctx.selected === node.agent.id && ctx.view.selectedId === card.id;
  const color = line.tone === "warning" ? c.statusWarning : line.tone === "danger" ? c.statusDanger : m.soft;
  const ref = useScrollIntoView(selected);
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={line.kind ? `${line.kind}: ${line.text}` : line.text}
      onPress={() => ctx.selectCard(node.agent.id, card.id)}
      style={pressStyle([m.row, { paddingLeft: base + depth * U + TITLE_X }, selected ? m.rowSelected : null], s.hover, s)}
    >
      <Rules depth={depth + 1} base={base} ctx={ctx} />
      <View style={[m.rowBody, { gap: CARD_NODE.gap }]}>
        {line.kind ? <Tag label={line.kind} ctx={ctx} look={toneLook(theme, lineTone(line), selected ? c.surface2 : c.surface0)} minWidth={cardTagWidth(line.kind)} style={{ flexShrink: 0 }} /> : null}
        <Text style={{ flex: 1, minWidth: 0, color, fontSize: CARD_NODE.font, lineHeight: CARD_NODE.line, fontWeight: selected ? "600" : "400" }} numberOfLines={1}>
          {line.text}
        </Text>
        <Text style={[m.time, { flexShrink: 0, minWidth: 18, textAlign: "right" }]}>{elapsed(card.firstReadyAt, ctx.nowMs)}</Text>
      </View>
    </Pressable>
  );
}

/** The List's `+N more` under an agent's first three card rows: a tap opens the agent. */
export function MoreRow({ node, depth, base, ctx }: { node: AgentNode; depth: number; base: number; ctx: ManagerCtx }) {
  const { m, s } = ctx;
  const count = node.cards.length - TILE.maxCards;
  if (count <= 0) return null;
  return (
    <Pressable accessibilityRole="button" onPress={() => ctx.select(node.agent.id)} style={pressStyle([m.row, { paddingLeft: base + depth * U + TITLE_X }], s.hover, s)}>
      <Rules depth={depth + 1} base={base} ctx={ctx} />
      <Text style={m.time}>+{count} more</Text>
    </Pressable>
  );
}

/** A tone's color: amber waits on the user, green came back fine or runs, red failed, muted is quiet. */
export function toneColor(theme: PluginTheme, tone: Tone): string {
  const c = theme.colors;
  return tone === "warning" ? c.statusWarning : tone === "success" ? c.statusSuccess : tone === "danger" ? c.statusDanger : c.foregroundMuted;
}

/** A kind tag's look on `surface`: the tone's text, a faint tint of it and a hairline of it; muted (the plain grey tag) gets none. */
export function toneLook(theme: PluginTheme, tone: Tone, surface: string): TagLook | undefined {
  if (tone === "muted") return undefined;
  const color = toneColor(theme, tone);
  return { color, backgroundColor: mix(color, surface, 0.92), borderColor: mix(color, surface, 0.6) };
}

export interface TagLook {
  color: string;
  backgroundColor: string;
  borderColor: string;
}

/** A tag: grey unless `look` colors it; `minWidth` gives the kind tags one width, text centered. */
export function Tag({ label, ctx, look, minWidth, style }: { label: string; ctx: Pick<ManagerCtx, "m">; look?: TagLook; minWidth?: number; style?: ViewStyle }) {
  return (
    <View style={[ctx.m.tag, look ? { backgroundColor: look.backgroundColor, borderColor: look.borderColor } : null, minWidth ? { minWidth, alignItems: "center" } : null, style ?? null]}>
      <Text style={[ctx.m.tagText, look ? { color: look.color } : null]}>{label}</Text>
    </View>
  );
}

/** On an archived agent listed because it still has open cards. */
export const ArchivedTag = ({ ctx }: { ctx: Pick<ManagerCtx, "m"> }) => <Tag label="archived" ctx={ctx} />;

/** The muted tag after an agent's title: `archived` (an inferred agent has its ring, and the legend). */
export function NodeTags({ node, ctx }: { node: AgentNode; ctx: Pick<ManagerCtx, "m"> }) {
  return (
    <>
      {node.agent.archivedAt ? <ArchivedTag ctx={ctx} /> : null}
    </>
  );
}

/** A workspace: chevron, folder and name; folded, the counts of what it holds. */
export function WorkspaceRow({ name, nodes, ctx, style }: { name: string; nodes: readonly AgentNode[]; ctx: ManagerCtx; style?: ViewStyle }) {
  const { m, s } = ctx;
  const folded = ctx.folded(wsKey(name));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: !folded }}
      onPress={() => ctx.toggle(wsKey(name))}
      style={pressStyle([m.wsRow, style ?? null], s.hover, s)}
    >
      <View style={m.chev}>
        <Chevron open={!folded} s={s} />
      </View>
      <WorkspaceBadge name={name} theme={ctx.theme} />
      <Text style={m.wsName} numberOfLines={1}>
        {name}
      </Text>
      <View style={m.fill} />
      {folded ? <Counts nodes={nodes} ctx={ctx} /> : null}
    </Pressable>
  );
}

// ---- what a Needs you agent asks, in one line ----------------------------------------

/** A card in one line: the ask's short question, the permission request or error (amber), or an older card's counts. */
export function cardLine(card: QueueCard): { text: string; host: boolean } {
  const kind = cardKind(card);
  const single = singleItem(card);
  if (kind === "permission" || kind === "error") return { text: single?.kind === "ask" ? hostAskLine(single.item) : "", host: true };
  if (kind === "list") {
    const n = cardCounts(card);
    return { text: countsLine(n), host: n.permission > 0 };
  }
  if (single?.kind === "ask") return { text: questionLine(single.item), host: false };
  if (single?.kind === "result") return { text: single.item.label, host: false };
  return { text: single?.kind === "receipt" ? single.item.title : "", host: false };
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * What a Needs you agent asks, short: one card's line, the count by kind for several cards, a pending
 * permission Paseo holds without a card, or an inferred agent's last line. Null for the other states.
 */
export function asksSummary(node: AgentNode): { text: string; host: boolean } | null {
  if (node.status.state !== "needs_you") return null;
  if (node.status.reason === "permission") return { text: plural(node.agent.pendingPermissions, "permission request"), host: true };
  if (node.status.inferred) return node.agent.lastLine ? { text: node.agent.lastLine, host: false } : null;
  if (node.cards.length === 1) return cardLine(node.cards[0]);
  const n = node.cards.map(cardCounts).reduce(
    (a, b) => ({ permission: a.permission + b.permission, think: a.think + b.think, nod: a.nod + b.nod, look: a.look + b.look, receipts: a.receipts + b.receipts }),
    { permission: 0, think: 0, nod: 0, look: 0, receipts: 0 },
  );
  return { text: countsLine(n), host: n.permission > 0 };
}

/** Mark done, small, as on a row; busy while it goes out. */
export function MarkDoneButton({ node, ctx, small }: { node: AgentNode; ctx: ManagerCtx; small?: boolean }) {
  const { m, s } = ctx;
  const busy = ctx.marking === node.agent.id;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={() => ctx.markDone(node)}
      style={pressStyle(small ? [m.quietButton, busy ? s.disabled : null] : [s.small, s.secondary, busy ? s.disabled : null], s.hover, s)}
    >
      <Text style={small ? m.quietButtonText : [s.secondaryText, s.smallText]}>Mark done</Text>
    </Pressable>
  );
}

