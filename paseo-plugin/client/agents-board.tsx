// The Board view: Needs you | Working | Done, each agent one card tile (client/agent-tile.tsx; membership
// and order in shared/agent-columns boardColumns). The columns scroll on their own under a fixed header.
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { boardColumns, type BoardColumn } from "../shared/agent-columns";
import { countStates, inferredIn, markCounts } from "../shared/agent-tree";
import { markLabel, StateMark, type ManagerCtx } from "./agents-bits";
import { AgentTile } from "./agent-tile";

const GAP = 12;

function BoardColumnView({ column, ctx }: { column: BoardColumn; ctx: ManagerCtx }) {
  const { m } = ctx;
  return (
    <View style={{ flex: 1, flexBasis: 0, minWidth: 0, minHeight: 0 }}>
      <View style={[m.colHead, { paddingHorizontal: 4 }]}>
        {markCounts(countStates(column.nodes), inferredIn(column.nodes))
          .filter((item) => item.state === column.state && (!item.inferred || item.count > 0))
          .map((item) => (
            <View key={markLabel(item)} style={{ flexDirection: "row", alignItems: "center", gap: 7, minWidth: 0, flexShrink: 1, marginLeft: item.inferred ? 11 : 0 }}>
              <StateMark state={item.state} inferred={item.inferred} ctx={ctx} />
              {item.inferred ? null : (
                <Text style={m.colLabel} numberOfLines={1}>
                  {markLabel(item)}
                </Text>
              )}
              <Text style={m.colCount}>{item.count}</Text>
            </View>
          ))}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: GAP, paddingTop: 6, paddingBottom: 24 }}>
        {column.nodes.map((node) => (
          <AgentTile key={node.agent.id} node={node} ctx={ctx} />
        ))}
      </ScrollView>
    </View>
  );
}

/** Equal columns that fill the screen's height; they shrink on a narrow desktop and never wrap. */
export function Board({ ctx }: { ctx: ManagerCtx }) {
  const columns = useMemo(() => boardColumns(ctx.forest), [ctx.forest]);
  return (
    <View style={{ flex: 1, minHeight: 0, flexDirection: "row", gap: GAP + 6, paddingHorizontal: 24, paddingTop: 8 }}>
      {columns.map((column) => (
        <BoardColumnView key={column.state} column={column} ctx={ctx} />
      ))}
    </View>
  );
}
