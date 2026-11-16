// The agent tile, shared by Columns and the Tree, top to bottom: the title row (the state mark as in the header
// legend, then the bold title), a chip row (model, effort and, on Columns, the workspace badge and name, `↳ parent`
// and `archived`), body rows (a Needs you agent's open cards, or its last line), and a footer with the state label
// (on Columns, an agent's sub-agents and their state counts after it) and the times as muted text. A tap on the tile
// opens the agent's detail; a tap on a card row opens that card in full. On the Tree the tile is drawn at the height
// shared/agent-diagram estimates, leaves workspace and parent out (the workspace column and the connectors show
// them) and puts `archived` beside the title. Its cards are nodes of their own there, so the tile has no card rows:
// a folded one shows their counts in a line, and it is not highlighted while one of its cards is open.
import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { boardLabel, boardTone } from "../shared/agent-columns";
import { fitTimes, rowTagWidth, tileRows, TILE, type TileCards } from "../shared/agent-diagram";
import { lineTone } from "../shared/card-tone";
import { managerTileLine } from "../shared/agent-line";
import { runsWhileWaiting } from "../shared/agent-state";
import type { AgentNode } from "../shared/agent-tree";
import { hasTileChips, tileTimes, timesText } from "../shared/tile-info";
import { asksSummary, Counts, MarkDoneButton, RunningMark, STATE_LABEL, StateMark, stateColor, Tag, toneColor, toneLook, type ManagerCtx } from "./agents-bits";
import { CHILD, Chip, effortMeter } from "./agent-chips";
import { mix } from "./format";
import { PROVIDER_ICONS } from "./provider-icons";
import { useScrollIntoView } from "./agents-keys";
import { pressStyle } from "./queue-view";
import { WorkspaceBadge } from "./workspace-badge";

/** The chip row: [logo] model, [meter] effort and, on Columns (`tail`), the workspace badge and name, `↳ parent` and `archived`, unboxed. */
function TileChips({ node, ctx, tail }: { node: AgentNode; ctx: ManagerCtx; tail: boolean }) {
  const { m, theme } = ctx;
  const t = tileStyles(ctx);
  const line = managerTileLine(node.agent, node.host);
  const muted = theme.colors.foregroundMuted;
  return (
    <View style={t.chips}>
      {line.model ? <Chip svg={line.icon ? PROVIDER_ICONS[line.icon] : null} text={line.model} theme={theme} /> : null}
      {line.effort ? <Chip svg={effortMeter(line.effort)} text={line.effort} theme={theme} /> : null}
      {tail ? (
        <>
          <View style={t.tail}>
            <WorkspaceBadge name={node.workspace} theme={theme} />
            <Text style={[t.metaText, { flexShrink: 1, minWidth: 0 }]} numberOfLines={1}>
              {node.workspace}
            </Text>
          </View>
          {node.parent ? (
            <View style={[t.tail, { flexShrink: 1, minWidth: 0 }]}>
              <Icon icon={{ svg: CHILD }} size={11} color={muted} />
              <Text style={[t.metaText, { flexShrink: 1, minWidth: 0 }]} numberOfLines={1}>
                {node.parent.title}
              </Text>
            </View>
          ) : null}
          {node.agent.archivedAt && node.cards.length ? (
            <View style={[m.tag, { flexShrink: 0 }]}>
              <Text style={m.tagText}>archived</Text>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/** The sub-agents, as plain muted text and the state marks and counts the Tree's workspace column uses; nothing without children. */
function SubAgents({ node, ctx }: { node: AgentNode; ctx: ManagerCtx }) {
  const t = tileStyles(ctx);
  const n = node.children.length;
  if (!n) return null;
  return (
    <View style={t.subAgents}>
      <Text style={t.time} numberOfLines={1}>
        {n} {n === 1 ? "sub-agent" : "sub-agents"}
      </Text>
      <Counts nodes={node.children} ctx={ctx} />
    </View>
  );
}

/** The footer's times as one muted text: Working `since 10:48 · 12m`, Needs you the wait, Done `3h ago`; `width` is the Tree tile's, which drops `since …` when it does not fit. */
function Times({ node, ctx, width }: { node: AgentNode; ctx: ManagerCtx; width: number | null }) {
  const t = tileStyles(ctx);
  const all = tileTimes(node, ctx.nowMs);
  const running = runsWhileWaiting(node.status, node.agent.status);
  const label = node.status.state === "needs_you" ? boardLabel(node) : STATE_LABEL[node.status.state];
  const times = width ? fitTimes(all, running ? `${label}   running` : label, width) : all;
  const dim = node.status.state === "done" ? { opacity: 0.6 } : null;
  return (
    <Text style={[t.time, { flexShrink: 0 }, dim]} numberOfLines={1}>
      {timesText(times)}
    </Text>
  );
}

/** The body rows; `width` is the tile's (0 on Columns, which has no estimate to make), `cards` how it treats its cards. */
function Rows({ node, ctx, width, cards }: { node: AgentNode; ctx: ManagerCtx; width: number; cards: TileCards }) {
  const { m, theme, s } = ctx;
  const t = tileStyles(ctx);
  const rows = tileRows(node, width, cards);
  const first = rows[0];
  if (!first) return null;
  if (first.kind === "text") {
    const summary =
      node.status.state === "needs_you" && !node.status.inferred && (cards === "count" || !node.cards.length) ? asksSummary(node) : null;
    const text = summary ? summary.text : node.agent.lastLine;
    return text ? (
      <Text style={[t.lastLine, summary?.host ? { color: theme.colors.statusWarning } : null]} numberOfLines={first.max}>
        {text}
      </Text>
    ) : null;
  }
  return (
    <View style={{ gap: TILE.rowGap }}>
      {rows.map((row) => {
        if (row.kind === "more") {
          return (
            <Pressable key="more" accessibilityRole="button" onPress={() => ctx.select(node.agent.id)} style={t.more}>
              <Text style={t.metaText}>+{row.count} more</Text>
            </Pressable>
          );
        }
        if (row.kind !== "card") return null;
        const { card, line: one } = row;
        const color = one.tone === "warning" ? theme.colors.statusWarning : one.tone === "danger" ? theme.colors.statusDanger : m.soft;
        return (
          <Pressable
            key={card.id}
            accessibilityRole="button"
            accessibilityLabel={one.kind ? `${one.kind}: ${one.text}` : one.text}
            onPress={() => ctx.selectCard(node.agent.id, card.id)}
            style={pressStyle(t.cardRow, { backgroundColor: theme.colors.surface2 }, s)}
          >
            {one.kind ? <Tag label={one.kind} ctx={ctx} look={toneLook(theme, lineTone(one), theme.colors.surface1)} minWidth={rowTagWidth(one.kind)} style={{ flexShrink: 0, marginTop: 1 }} /> : null}
            <Text style={[t.cardText, { color }]} numberOfLines={2}>
              {one.text}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * One agent as a tile. On the Board it is a flow item of its column. On the Tree (`tree`) `frame` places
 * it (absolute, `width` and the estimated `height`); `cards` is `nodes` or, folded, `count`, and `cardOpen`
 * says one of its card nodes is open, so the tile is not highlighted.
 */
export function AgentTile({
  node,
  ctx,
  tree,
  frame,
}: {
  node: AgentNode;
  ctx: ManagerCtx;
  tree?: { width: number; height: number; cards: Exclude<TileCards, "rows">; cardOpen: boolean };
  frame?: ViewStyle;
}) {
  const { theme, nowMs, s, m } = ctx;
  const t = tileStyles(ctx);
  const c = theme.colors;
  const state = node.status.state;
  const selected = ctx.selected === node.agent.id && !tree?.cardOpen;
  const label = state === "needs_you" ? boardLabel(node) : STATE_LABEL[state];
  const byLabel = boardTone(node, label);
  const tone = byLabel ? toneColor(theme, byLabel) : stateColor(theme, state);
  const dim = state === "done" ? { opacity: 0.6 } : null;
  const archived = tree && node.agent.archivedAt && node.cards.length;
  const ref = useScrollIntoView(selected);
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => ctx.select(node.agent.id)}
      style={pressStyle(
        [t.tile, tree ? { height: tree.height, borderWidth: TILE.border } : null, selected ? { borderColor: c.foregroundMuted } : null, frame ?? null],
        { backgroundColor: c.surface2 },
        s,
      )}
    >
      <View style={[t.body, tree ? { flex: 1, minHeight: 0, overflow: "hidden" } : null]}>
        <View style={t.titleRow}>
          <StateMark state={state} inferred={node.status.inferred} ctx={ctx} style={{ marginTop: 1 }} />
          <Text style={t.title} numberOfLines={2}>
            {node.title}
          </Text>
          {archived ? (
            <View style={[m.tag, { flexShrink: 0, marginTop: 2 }]}>
              <Text style={m.tagText}>archived</Text>
            </View>
          ) : null}
        </View>
        {hasTileChips(node, !tree) ? <TileChips node={node} ctx={ctx} tail={!tree} /> : null}
        <Rows node={node} ctx={ctx} width={tree?.width ?? 0} cards={tree?.cards ?? "rows"} />
      </View>
      <View style={t.footer}>
        <Text style={[t.label, { color: tone }, dim]}>{label}</Text>
        <RunningMark node={node} ctx={ctx} />
        {label === "Idle" ? <MarkDoneButton node={node} ctx={ctx} small /> : null}
        {tree ? null : <SubAgents node={node} ctx={ctx} />}
        <View style={{ flex: 1 }} />
        <Times node={node} ctx={ctx} width={tree?.width ?? null} />
      </View>
    </Pressable>
  );
}

/** The tile styles, built once per theme (`ctx.m` changes with it). */
const styleCache = new WeakMap<object, ReturnType<typeof makeStyles>>();
function tileStyles(ctx: ManagerCtx) {
  let styles = styleCache.get(ctx.m);
  if (!styles) {
    styles = makeStyles(ctx);
    styleCache.set(ctx.m, styles);
  }
  return styles;
}

function makeStyles(ctx: ManagerCtx) {
  const c = ctx.theme.colors;
  const hairline = StyleSheet.hairlineWidth;
  return StyleSheet.create({
    tile: { backgroundColor: c.surface1, borderRadius: 10, borderWidth: hairline, borderColor: c.border, overflow: "hidden" },
    body: { padding: 14, gap: 8 },
    titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    title: { flex: 1, minWidth: 0, color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" },
    chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 5, rowGap: 4, paddingLeft: TILE.indent },
    tail: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 0, maxWidth: "100%" },
    subAgents: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0 },
    metaText: { color: c.foregroundMuted, fontSize: 12, lineHeight: 16 },
    lastLine: { color: c.foregroundMuted, fontSize: 12.5, lineHeight: 17, paddingLeft: TILE.indent },
    cardRow: { flexDirection: "row", alignItems: "flex-start", gap: 7, marginLeft: TILE.indent, paddingVertical: 2, paddingRight: 4, borderRadius: 5 },
    cardText: { flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 17 },
    more: { marginLeft: TILE.indent, paddingVertical: 2 },
    footer: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 40,
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderTopWidth: hairline,
      borderTopColor: mix(c.foregroundMuted, c.surface1, 0.25),
    },
    label: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
    time: { color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] },
  });
}
