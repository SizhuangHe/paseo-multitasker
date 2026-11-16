// Tree: the forest laid out across the width, workspace → agent → child → grandchild from left to right,
// siblings stacked, joined by elbow connectors (layout: shared/agent-diagram). Each agent is the card tile
// Columns uses (client/agent-tile.tsx) without card rows; its open cards are smaller nodes right of it,
// before its children: a kind mark, the card's line and its wait; no fill, a border tinted amber when it
// waits on an answer. A tap on a card node opens that card in the detail. A node with cards or children has
// a fold handle on its right edge; folded, its tile stacks like a deck, shows its cards' counts and a pill
// counts what it hides. Connectors are plain bordered views (no SVG in plugin UI).
import { ScrollView } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  anchor,
  CARD_NODE,
  cardTagWidth,
  DIAGRAM,
  foldLabel,
  layoutDiagram,
  TILE,
  type DiagramAgent,
  type DiagramCard,
  type DiagramItem,
  type DiagramWorkspace,
} from "../shared/agent-diagram";
import { lineTone } from "../shared/card-tone";
import { subtree } from "../shared/agent-tree";
import { elapsed, mix } from "./format";
import { useScrollIntoView } from "./agents-keys";
import { Chevron, pressStyle } from "./queue-view";
import { WorkspaceBadge } from "./workspace-badge";
import { AgentTile } from "./agent-tile";
import { agentKey, Counts, Tag, toneLook, wsKey, type ManagerCtx } from "./agents-bits";

const PAD = 28;
const R = 8; // the elbow's corner
const { G, H } = DIAGRAM;

/** Parent → kid lines: straight across when the kid shares the parent's anchor, else down the gap and round an elbow. */
function Connectors({ items, ctx }: { items: DiagramItem[]; ctx: ManagerCtx }) {
  const color = ctx.m.rule;
  const lines: ReactNode[] = [];
  for (const p of items) {
    if (!p.kids.length) continue;
    const px = p.x + p.w;
    const py = anchor(p);
    const mx = px + G / 2;
    lines.push(<View key={`${p.key}>`} style={{ position: "absolute", left: px, top: py, width: G / 2, height: 1, backgroundColor: color }} />);
    for (const kid of p.kids) {
      const cy = anchor(kid);
      if (Math.abs(cy - py) < 1) {
        lines.push(<View key={`${p.key}>${kid.key}`} style={{ position: "absolute", left: mx, top: py, width: kid.x - mx, height: 1, backgroundColor: color }} />);
      } else {
        lines.push(
          <View
            key={`${p.key}>${kid.key}`}
            style={{
              position: "absolute",
              left: mx,
              top: py,
              width: kid.x - mx,
              height: cy - py + 1,
              borderLeftWidth: 1,
              borderBottomWidth: 1,
              borderColor: color,
              borderBottomLeftRadius: R,
            }}
          />,
        );
      }
    }
  }
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {lines}
    </View>
  );
}

function AgentNodeView({ item, ctx }: { item: DiagramAgent; ctx: ManagerCtx }) {
  const { theme, m } = ctx;
  const c = theme.colors;
  const frame = { position: "absolute" as const, left: item.x, top: item.y, width: item.w };
  // Its card node is highlighted, not the tile, while one of its cards is open.
  const cardOpen = !item.folded && ctx.selected === item.node.agent.id && item.node.cards.some((card) => card.id === ctx.view.selectedId);
  return (
    <>
      {item.folded ? (
        <View
          style={{
            ...frame,
            left: item.x + DIAGRAM.DECK,
            top: item.y + DIAGRAM.DECK,
            height: item.h,
            borderRadius: 10,
            borderWidth: 1,
            backgroundColor: c.surface1,
            borderColor: mix(c.foregroundMuted, c.surface0, 0.72),
            opacity: item.node.status.state === "done" ? 0.5 : 1,
          }}
        />
      ) : null}
      <AgentTile node={item.node} ctx={ctx} tree={{ width: item.w, height: item.h, cards: item.folded ? "count" : "nodes", cardOpen }} frame={frame} />
      {item.foldable ? <FoldHandle item={item} ctx={ctx} /> : null}
    </>
  );
}

/**
 * One open card as a leaf of its agent: the kind mark (decide, approve, review, returned, permission,
 * error; none on an older multi-item card, whose line is its counts), its line in one or two lines, and
 * its wait at the right. A tap opens it in the detail.
 */
function CardNodeView({ item, ctx }: { item: DiagramCard; ctx: ManagerCtx }) {
  const { theme, m, s } = ctx;
  const c = theme.colors;
  const { card, line } = item;
  const selected = ctx.selected === item.node.agent.id && ctx.view.selectedId === card.id;
  const tint = line.tone === "danger" ? c.statusDanger : c.statusWarning;
  const border = selected ? c.foreground : line.ask ? mix(tint, c.surface0, 0.6) : mix(c.foregroundMuted, c.surface0, 0.78);
  const color = line.tone === "warning" ? c.statusWarning : line.tone === "danger" ? c.statusDanger : m.soft;
  const ref = useScrollIntoView(selected);
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={line.kind ? `${line.kind}: ${line.text}` : line.text}
      onPress={() => ctx.selectCard(item.node.agent.id, card.id)}
      style={pressStyle(
        {
          position: "absolute",
          left: item.x,
          top: item.y,
          width: item.w,
          height: item.h,
          justifyContent: "center",
          paddingHorizontal: CARD_NODE.padX,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: border,
          backgroundColor: selected ? c.surface1 : c.surface0,
        },
        { backgroundColor: c.surface1 },
        s,
      )}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: CARD_NODE.gap }}>
        {line.kind ? (
          <Tag label={line.kind} ctx={ctx} look={toneLook(theme, lineTone(line), selected ? c.surface1 : c.surface0)} minWidth={cardTagWidth(line.kind)} style={{ height: CARD_NODE.line, justifyContent: "center", flexShrink: 0 }} />
        ) : null}
        <Text
          style={{ flex: 1, minWidth: 0, color, fontSize: CARD_NODE.font, lineHeight: CARD_NODE.line, fontWeight: selected ? "600" : "400" }}
          numberOfLines={item.lines}
        >
          {line.text}
        </Text>
        <Text style={[m.time, { flexShrink: 0, lineHeight: CARD_NODE.line, minWidth: 18, textAlign: "right" }]}>{elapsed(card.firstReadyAt, ctx.nowMs)}</Text>
      </View>
    </Pressable>
  );
}

/** At a node's right edge: a small handle that folds its cards and children, or once folded, what it hides (`5 cards · 1 child`). */
function FoldHandle({ item, ctx }: { item: DiagramAgent; ctx: ManagerCtx }) {
  const { theme, s, m } = ctx;
  const c = theme.colors;
  const key = agentKey(item.node.agent.id);
  const y = anchor(item);
  if (item.folded) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Unfold"
        onPress={() => ctx.toggle(key)}
        style={pressStyle(
          {
            position: "absolute",
            left: item.x + item.w + 12,
            top: y - 12,
            height: 24,
            paddingHorizontal: 9,
            borderRadius: 12,
            justifyContent: "center",
            backgroundColor: c.surface2,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: m.rule,
          },
          s.hover,
          s,
        )}
      >
        <Text style={m.countNum} numberOfLines={1}>
          {foldLabel(item.hidden)}
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Fold"
      onPress={() => ctx.toggle(key)}
      style={pressStyle(
        {
          position: "absolute",
          left: item.x + item.w - 7,
          top: y - 7,
          width: 14,
          height: 14,
          borderRadius: 7,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: c.surface0,
          borderWidth: 1,
          borderColor: m.rule,
        },
        s.hover,
        s,
      )}
    >
      <View style={{ width: 6, height: 1.25, backgroundColor: c.foregroundMuted }} />
    </Pressable>
  );
}

function WorkspaceNode({ item, ctx }: { item: DiagramWorkspace; ctx: ManagerCtx }) {
  const { theme, s, m } = ctx;
  const { ws } = item;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: !item.folded }}
      onPress={() => ctx.toggle(wsKey(ws.name))}
      style={pressStyle({ position: "absolute", left: item.x - 6, top: item.y, width: item.w, height: H, paddingLeft: 6, paddingTop: TILE.pad, borderRadius: 8 }, s.hover, s)}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 20 }}>
        <View style={m.chev}>
          <Chevron open={!item.folded} s={s} />
        </View>
        <WorkspaceBadge name={ws.name} theme={theme} />
        <Text style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }} numberOfLines={1}>
          {ws.name}
        </Text>
      </View>
      <View style={{ paddingLeft: 18, marginTop: 2, flexDirection: "row" }}>
        <Counts nodes={ws.roots.flatMap(subtree)} ctx={ctx} />
      </View>
    </Pressable>
  );
}

/** The tree for a main area `width` wide; wider trees scroll sideways. */
export function Diagram({ ctx, width: areaWidth }: { ctx: ManagerCtx; width: number }) {
  const { items, height, width } = layoutDiagram({
    forest: ctx.forest,
    avail: areaWidth - 2 * PAD,
    workspaceFolded: (name) => ctx.folded(wsKey(name)),
    agentFolded: (id) => ctx.folded(agentKey(id)),
  });
  return (
    <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: PAD, paddingTop: 22, paddingBottom: 36 }}>
      <View style={{ position: "relative", width, height }}>
        <Connectors items={items} ctx={ctx} />
        {items.map((item) =>
          item.kind === "workspace" ? (
            <WorkspaceNode key={item.key} item={item} ctx={ctx} />
          ) : item.kind === "agent" ? (
            <AgentNodeView key={item.key} item={item} ctx={ctx} />
          ) : (
            <CardNodeView key={item.key} item={item} ctx={ctx} />
          ),
        )}
      </View>
    </ScrollView>
  );
}
