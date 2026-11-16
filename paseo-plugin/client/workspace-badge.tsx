// The workspace badge: the workspace's first letter in its hue, on a faint tint of that hue.
import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import { workspaceHue, workspaceInitial } from "../shared/workspace-badge";
import { mix } from "./format";

/** Dark when the page surface is dark; the palette has a value for each theme. */
function isDark(theme: PluginTheme): boolean {
  const hex = theme.colors.surface0;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

export function WorkspaceBadge({ name, theme, size = 16 }: { name: string; theme: PluginTheme; size?: number }) {
  const hue = workspaceHue(name);
  const color = isDark(theme) ? hue.dark : hue.light;
  return (
    <View
      accessible={false}
      style={{ width: size, height: size, borderRadius: 4, alignItems: "center", justifyContent: "center", backgroundColor: mix(theme.colors.surface0, color, 0.16) }}
    >
      <Text style={{ color, fontSize: Math.round(size * 0.625), lineHeight: size, fontWeight: "600", textAlign: "center" }}>{workspaceInitial(name)}</Text>
    </View>
  );
}
