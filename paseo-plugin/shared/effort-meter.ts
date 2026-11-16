// How the effort meter fills: a 4-bar signal-strength glyph, one bar more per level. Pure, so the tile, the
// detail and the tests share it.

/** The meter's bar count. */
export const METER_BARS = 4;

/** Filled bars for an effort label (case and spacing ignored): low 1, medium 2, high 3, xhigh or max 4; unknown or missing 3. */
export function effortBars(effort: string | null | undefined): number {
  const key = (effort ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (key === "low" || key === "minimal") return 1;
  if (key === "medium" || key === "med") return 2;
  if (key === "high") return 3;
  if (key === "xhigh" || key === "extrahigh" || key === "max" || key === "maximum") return 4;
  return 3;
}
