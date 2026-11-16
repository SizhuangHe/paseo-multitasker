// The workspace badge: a small tinted square with the workspace's first letter, so workspaces tell apart
// at a glance. Its hue means identity, not state, so the palette keeps clear of the status hues (amber,
// green, red). Pure, so the screen and the tests share it.

export interface BadgeHue {
  name: string;
  /** The letter's color on the light theme and on the dark one; the tint is this hue faded into the surface. */
  light: string;
  dark: string;
}

export const BADGE_HUES: readonly BadgeHue[] = [
  // Spaced in OKLCH hue (about 200, 250, 295, 340 degrees) plus an achromatic slate.
  { name: "cyan", light: "#006774", dark: "#00bcc5" },
  { name: "blue", light: "#005ab5", dark: "#67b0f9" },
  { name: "violet", light: "#6c46b6", dark: "#b7a0fb" },
  { name: "pink", light: "#9c2e7f", dark: "#e88fcb" },
  { name: "slate", light: "#515f6e", dark: "#9faebf" },
];

/** A stable hue for a workspace name (djb2 over its UTF-16 units, modulo the palette). */
export function workspaceHue(name: string): BadgeHue {
  let hash = 5381;
  for (let i = 0; i < name.length; i += 1) hash = (Math.imul(hash, 33) + name.charCodeAt(i)) >>> 0;
  return BADGE_HUES[hash % BADGE_HUES.length];
}

/** The badge letter: the first letter or digit, uppercased, of the name's last path segment (`~/code/foo` → `F`). */
export function workspaceInitial(name: string): string {
  const segment = name.split("/").filter(Boolean).at(-1) ?? name;
  const first = /[\p{L}\p{N}]/u.exec(segment);
  return first ? first[0].toUpperCase() : "?";
}
