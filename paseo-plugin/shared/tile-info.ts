// What the agent tile shows beyond the title and body, pure so the client, the Tree's height estimate and the
// tests share it: the footer's times and whether the chip row exists.
import { managerTileLine } from "./agent-line.ts";
import type { AgentNode } from "./agent-tree.ts";
import { elapsed } from "./time.ts";

/** The chip row exists: a model or effort to name, or, on Columns (`workspace`), the workspace and parent that end the row. */
export function hasTileChips(node: AgentNode, workspace = false): boolean {
  const line = managerTileLine(node.agent, node.host);
  return workspace || line.model !== null || line.effort !== null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** `14:05` today (the machine's zone), `Mon 14` within the last six days, else `Nov 3`. */
export function clockTime(iso: string, nowMs: number): string {
  const at = new Date(iso);
  const now = new Date(nowMs);
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (at.getTime() >= midnight) return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.getTime() >= midnight - 6 * DAY_MS) return `${WEEKDAYS[at.getDay()]} ${at.getDate()}`;
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

/** How long something has run: `45s`, `46m`, `2h 5m`, `3d 4h`. */
export function duration(fromIso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** The footer's right side as parts: Working `start` and `span`, Needs you `span` (the wait), Done `ago`. */
export interface TileTimes {
  start: string | null;
  span: string | null;
  ago: string | null;
}

export function tileTimes(node: AgentNode, nowMs: number): TileTimes {
  const state = node.status.state;
  if (state === "working") return { start: clockTime(node.since, nowMs), span: duration(node.since, nowMs), ago: null };
  if (state === "needs_you") return { start: null, span: elapsed(node.since, nowMs), ago: null };
  const since = elapsed(node.since, nowMs);
  return { start: null, span: null, ago: since === "now" ? "now" : `${since} ago` };
}

/** The times as the footer's one muted text: `since 10:48 · 12m`, `5h`, `10h ago`. */
export function timesText(times: TileTimes): string {
  const parts = [times.start ? `since ${times.start}` : null, times.span, times.ago].filter((part): part is string => part !== null);
  return parts.join(" · ");
}
