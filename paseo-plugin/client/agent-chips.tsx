// The agent line as chips: [logo plan · model], [effort meter effort], and for a child [↳ child of <name>],
// then the workspace badge and name. Chips are neutral (color is for status); each wraps whole.
import { Icon } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { AgentLine } from "../shared/agent-line";
import { effortBars, METER_BARS } from "../shared/effort-meter";
import { mix } from "./format";
import { PROVIDER_ICONS } from "./provider-icons";
import { WorkspaceBadge } from "./workspace-badge";

const stroke = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const CHILD = stroke('<path d="M6 4v9a3 3 0 0 0 3 3h10"/><path d="M15 11l4 5-4 5"/>');

/** The effort meter: four bars of rising height, the first `filled` in the chip's text color, the rest faint. Hand-drawn. */
export const effortMeter = (effort: string | null): string => {
  const filled = effortBars(effort);
  const heights = [6, 9.5, 13, 16];
  const bars = heights
    .slice(0, METER_BARS)
    .map((h, i) => `<rect x="${0.5 + i * 4}" y="${16 - h}" width="3.1" height="${h}" rx="0.8" fill="currentColor"${i < filled ? "" : ' fill-opacity="0.28"'}/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${bars}</svg>`;
};

/** A chip: an icon and text, or `children` after the icon. Neutral, since color means state here. */
export function Chip({ svg, text, theme, children }: { svg: string | null; text?: string; theme: PluginTheme; children?: ReactNode }) {
  const muted = theme.colors.foregroundMuted;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        height: 20,
        paddingHorizontal: 6,
        borderRadius: 5,
        maxWidth: "100%",
        backgroundColor: mix(theme.colors.surface0, theme.colors.foreground, 0.08),
      }}
    >
      {svg ? <Icon icon={{ svg }} size={11} color={muted} /> : <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: muted, opacity: 0.6, marginHorizontal: 3 }} />}
      {text ? (
        <Text style={{ flexShrink: 1, minWidth: 0, color: muted, fontSize: 11.5, lineHeight: 16 }} numberOfLines={1}>
          {text}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

export function AgentChips({ line, theme }: { line: AgentLine; theme: PluginTheme }) {
  if (!line.provider && !line.effort && !line.child && !line.workspace) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 5, rowGap: 4, marginTop: 4 }}>
      {line.provider ? <Chip svg={line.icon ? PROVIDER_ICONS[line.icon] : null} text={line.provider} theme={theme} /> : null}
      {line.effort ? <Chip svg={effortMeter(line.effort)} text={line.effort} theme={theme} /> : null}
      {line.child ? <Chip svg={CHILD} text={line.child} theme={theme} /> : null}
      {line.workspace ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1, minWidth: 0, maxWidth: "100%", marginLeft: 3 }}>
          <WorkspaceBadge name={line.workspace} theme={theme} />
          <Text style={{ flexShrink: 1, minWidth: 0, color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }} numberOfLines={1}>
            {line.workspace}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
