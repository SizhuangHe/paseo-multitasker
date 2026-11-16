// One agent in detail, the same in every view: where it sits (workspace › parents), its title and agent
// line, its state and time (and `archived` on an archived agent with open cards), then by state its open
// cards (the card components and their actions: Send, Discuss, Seen, Dismiss, Later, permission choices),
// an inferred agent's last line with Mark done, or a finished agent's last line; then its closed cards,
// folded under `Closed N`, each with what happened to it; then its children. A
// side panel on desktop, a full screen on a phone. A card opened from here (its title, or Reply ›) shows
// in full in its place, full screen on a phone, with `‹ Agent` back.
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { managerAgentLine } from "../shared/agent-line";
import { CARD_NODE, cardNodeOrder, cardTagWidth, topicGroups } from "../shared/agent-diagram";
import { ancestors, nodeSessionId, rowTime, type AgentNode } from "../shared/agent-tree";
import { seenReturned } from "../shared/cards";
import { closedLine, closedOutcome, reopenable } from "../shared/closed";
import { CLOSED_MAX } from "../shared/rpc";
import { cardKind, elapsed } from "./format";
import { AgentChips } from "./agent-chips";
import { CardDetail, Chevron, ItemCard, ListCard, pressStyle } from "./queue-view";
import { WorkspaceBadge } from "./workspace-badge";
import { MarkDoneButton, NodeTags, RunningMark, StateMark, STATE_LABEL, Tag, type ManagerCtx } from "./agents-bits";

const d = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, marginBottom: 6 },
  crumbs: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 5, flexShrink: 1, minWidth: 0 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  stateRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  block: { marginTop: 18, gap: 10 },
  label: { fontSize: 11.5, lineHeight: 15, fontWeight: "600", letterSpacing: 0.6 },
});

/**
 * `Closed N`, folded at first, then one row per closed card: the Tree's tag and line, what happened to it,
 * and when it closed. Nothing while the session has none.
 */
function ClosedList({ node, ctx }: { node: AgentNode; ctx: ManagerCtx }) {
  const { s, m, nowMs } = ctx;
  const muted = ctx.theme.colors.foregroundMuted;
  // Show all holds for the agent it was pressed on; another agent's detail starts at 30 again.
  const [allFor, setAllFor] = useState<string | null>(null);
  const first = ctx.useClosed(node.host, nodeSessionId(node));
  const every = ctx.useClosed(node.host, nodeSessionId(node), allFor === node.agent.id ? CLOSED_MAX : undefined);
  // The first 30 stay while the rest load, and when that fetch fails.
  const all = allFor === node.agent.id && every !== undefined;
  const closed = all ? every : first;
  if (!closed?.total) return null;
  // The folds map starts every key false, so for this list true means unfolded: it starts folded.
  const key = `closed:${node.agent.id}`;
  const open = ctx.folded(key);
  const more = closed.total - closed.cards.length;
  const quietLink = { height: 22, paddingHorizontal: 4, borderRadius: 5, justifyContent: "center" } as const;
  return (
    <View style={{ marginTop: 22 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => ctx.toggle(key)}
        style={pressStyle([m.wsRow, { paddingLeft: 4 }], s.hover, s)}
      >
        <View style={m.chev}>
          <Chevron open={open} s={s} />
        </View>
        <Text style={m.wsName}>Closed</Text>
        <Text style={m.time}>{closed.total}</Text>
      </Pressable>
      {open
        ? closed.cards.map((card) => {
            const line = closedLine(card);
            return (
              <View key={card.id} style={[m.row, { paddingLeft: 4, gap: CARD_NODE.gap }]}>
                {line.kind ? <Tag label={line.kind} ctx={ctx} minWidth={cardTagWidth(line.kind)} /> : null}
                <Text style={[m.cardLineText, { flex: 1, color: muted }]} numberOfLines={1}>
                  {line.text}
                </Text>
                {ctx.reopen && reopenable(card) ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Reopen ${line.text}`} onPress={() => void ctx.reopen?.(card)} style={pressStyle(quietLink, s.hover, s)}>
                    <Text style={m.time}>Reopen</Text>
                  </Pressable>
                ) : null}
                <Text style={[m.time, { flexShrink: 1, maxWidth: "45%" }]} numberOfLines={1}>
                  {closedOutcome(card)}
                </Text>
                <Text style={[m.time, { flexShrink: 0, minWidth: 18, textAlign: "right" }]}>{elapsed(card.doneAt ?? card.updatedAt, nowMs)}</Text>
              </View>
            );
          })
        : null}
      {open && more > 0 ? (
        all ? (
          <Text style={[m.time, { paddingLeft: 4, paddingVertical: 6 }]}>+{more} more</Text>
        ) : (
          <Pressable accessibilityRole="button" onPress={() => setAllFor(node.agent.id)} style={pressStyle([quietLink, { alignSelf: "flex-start", marginTop: 6 }], s.hover, s)}>
            <Text style={m.time}>Show {more} more</Text>
          </Pressable>
        )
      ) : null}
    </View>
  );
}

/** `Mark N returned as seen`: Seen on each of the agent's open receipts (two or more), each of which can be reopened. */
function SeenReturned({ node, ctx }: { node: AgentNode; ctx: ManagerCtx }) {
  const [busy, setBusy] = useState(false);
  const receipts = seenReturned(node.cards);
  if (!ctx.seenMany || !receipts.length) return null;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={() => {
        setBusy(true);
        void ctx.seenMany?.(receipts).finally(() => setBusy(false));
      }}
      style={pressStyle([ctx.m.quietButton, { marginLeft: "auto", marginVertical: -3 }, busy ? ctx.s.disabled : null], ctx.s.hover, ctx.s)}
    >
      <Text style={ctx.m.quietButtonText}>Mark {receipts.length} returned as seen</Text>
    </Pressable>
  );
}

/** `onClose`: the phone's back link, or the panel's ×; null leaves the panel without one. */
/** Reply and Send for an inferred agent: the text goes into its session as the user's message. */
function ReplyBox({ node, ctx }: { node: AgentNode; ctx: ManagerCtx }) {
  const { s, theme } = ctx;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !busy && text.trim() !== "";
  const send = async () => {
    setBusy(true);
    try {
      if (await ctx.reply(node, text)) setText("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 10, marginTop: 12 }}>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Reply…"
        accessibilityLabel={`Reply to ${node.title}`}
        placeholderTextColor={theme.colors.foregroundMuted}
        editable={!busy}
        multiline
        style={ctx.cardS.replyInput}
      />
      <View style={[s.itemButtons, { justifyContent: "flex-end" }]}>
        <MarkDoneButton node={node} ctx={ctx} />
        <Pressable accessibilityRole="button" disabled={!ready} onPress={send} style={pressStyle([s.small, s.primary, ready ? null : s.disabled], {}, s)}>
          <Text style={[s.primaryText, s.smallText]}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function AgentDetail({ node, ctx, mode, onClose }: { node: AgentNode; ctx: ManagerCtx; mode: "panel" | "screen"; onClose: (() => void) | null }) {
  const { s, m, theme, nowMs, view } = ctx;
  const muted = theme.colors.foregroundMuted;
  const pad = mode === "screen" ? { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 40 } : { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 40 };

  // A card opened from here (its title, or Reply ›) shows in full; its back link returns to the agent.
  const card = node.cards.find((c) => c.id === view.selectedId);
  if (card) {
    return (
      <View style={pad}>
        <CardDetail view={view} card={card} state={ctx.cardState} s={ctx.cardS} nowMs={nowMs} backLabel="Agent" />
      </View>
    );
  }

  const crumbText = { color: muted, fontSize: 12.5, lineHeight: 17 };
  const sectionLabel = [d.label, { color: muted }];
  const state = node.status.state;
  const openSession = ctx.openAgent && (() => ctx.openAgent?.(node.agent.id));

  const top = (
    <View style={d.bar}>
      {mode === "screen" && onClose ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Back to agents" onPress={onClose} style={pressStyle(s.back, s.hover, s)}>
          <Text style={s.backChevron}>‹</Text>
          <Text style={s.backText}>Multitasker</Text>
        </Pressable>
      ) : null}
      <View style={{ flex: 1 }} />
      {openSession ? (
        <Pressable accessibilityRole="button" onPress={openSession} style={pressStyle(s.quiet, s.hover, s)}>
          <Text style={s.quietText}>Open session ↗</Text>
        </Pressable>
      ) : null}
      {mode === "panel" && onClose ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={pressStyle([s.quiet, { width: 36 }], s.hover, s)}>
          <Text style={[s.quietText, { fontSize: 18 }]}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );

  let body: ReactNode = null;
  if (state === "needs_you" && node.cards.length) {
    // The Tree's order: a session blocked on a permission request shows that first.
    // Open cards under a subhead per topic when they span two or more.
    body = topicGroups(cardNodeOrder(node.cards)).map((group) => (
      <View key={group.topic ?? ""} style={{ gap: 10 }}>
        {group.topic ? <Text style={[sectionLabel, { marginTop: 4 }]}>{group.topic}</Text> : null}
        {group.cards.map((c) =>
          cardKind(c) === "list" ? (
            <ListCard key={c.id} card={c} s={ctx.cardS} theme={theme} onSelect={view.onSelect} />
          ) : (
            <ItemCard key={c.id} card={c} props={view} actions={ctx.cardState.actions} s={ctx.cardS} nowMs={nowMs} waited={elapsed(c.firstReadyAt, nowMs)} />
          ),
        )}
      </View>
    ));
  } else if (state === "needs_you" && node.status.reason === "permission") {
    const count = node.agent.pendingPermissions;
    body = (
      <View style={s.item}>
        <Text style={[s.itemTitle, { color: theme.colors.statusWarning }]}>
          {count === 1 ? "A permission request is waiting" : `${count} permission requests are waiting`}
        </Text>
        <Text style={[s.itemNote, { marginTop: 6 }]}>Answer in the session.</Text>
      </View>
    );
  } else if (state === "needs_you" && node.status.inferred) {
    body = (
      <View style={s.item}>
        <View style={s.itemHead}>
          <Text style={[s.itemTitle, { flex: 1, minWidth: 0 }, node.agent.lastLine ? null : { color: muted, fontWeight: "500" }]} numberOfLines={3}>
            {node.agent.lastLine ?? "No final message"}
          </Text>
        </View>
        <ReplyBox node={node} ctx={ctx} />
      </View>
    );
  } else if (state === "done" && node.agent.lastLine) {
    body = (
      <Text style={[s.bodyText, { fontSize: 14, lineHeight: 21, color: muted }]} numberOfLines={3}>
        {node.agent.lastLine}
      </Text>
    );
  }

  return (
    <View style={pad}>
      {top}
      <View style={d.crumbs}>
        <WorkspaceBadge name={node.workspace} theme={theme} />
        <Text style={crumbText}>{node.workspace}</Text>
        {ancestors(node).map((parent) => (
          <Pressable key={parent.agent.id} accessibilityRole="link" onPress={() => ctx.select(parent.agent.id)} style={{ flexDirection: "row", gap: 5 }}>
            <Text style={crumbText}>›</Text>
            <Text style={[crumbText, { textDecorationLine: "underline", textDecorationColor: m.rule } as never]} numberOfLines={1}>
              {parent.title}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={d.titleRow}>
        <StateMark state={state} inferred={node.status.inferred} ctx={ctx} />
        <Text style={[s.title, { flex: 1, minWidth: 0, fontSize: 21, lineHeight: 28 }]} accessibilityRole="header">
          {node.title}
        </Text>
      </View>
      <View style={{ marginLeft: 22 }}>
        <AgentChips line={managerAgentLine(node.agent, node.host)} theme={theme} />
      </View>
      <View style={d.stateRow}>
        <Text style={{ color: node.status.inferred ? muted : theme.colors.foreground, fontSize: 13.5, fontWeight: "600" }}>{node.status.inferred ? "Idle" : STATE_LABEL[state]}</Text>
        <Text style={{ color: muted, fontSize: 13, fontVariant: ["tabular-nums"] }}>{rowTime(node, nowMs)}</Text>
        <RunningMark node={node} ctx={ctx} />
        <NodeTags node={node} ctx={ctx} />
        <SeenReturned node={node} ctx={ctx} />
      </View>
      {body ? <View style={d.block}>{body}</View> : null}
      <ClosedList node={node} ctx={ctx} />
      {node.children.length ? (
        <View style={{ marginTop: 22 }}>
          <Text style={[sectionLabel, { marginBottom: 4 }]}>CHILDREN</Text>
          {node.children.map((child) => {
            const done = child.status.state === "done";
            return (
              <Pressable
                key={child.agent.id}
                accessibilityRole="button"
                onPress={() => ctx.select(child.agent.id)}
                style={pressStyle([m.row, { paddingLeft: 4, gap: 8 }], s.hover, s)}
              >
                <View style={done ? m.dim : null}>
                  <StateMark state={child.status.state} inferred={child.status.inferred} ctx={ctx} />
                </View>
                <Text style={[m.title, done ? { color: muted } : null]} numberOfLines={1}>
                  {child.title}
                </Text>
                <NodeTags node={child} ctx={ctx} />
                {child.children.length ? <Text style={m.time}>+{child.children.length}</Text> : null}
                <View style={m.fill} />
                <Text style={[m.time, done ? m.dim : null]}>{rowTime(child, nowMs)}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
