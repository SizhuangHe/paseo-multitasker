// How long ago something was, the way every row in the plugin reads it. Pure, shared by both screens.

/** "now", "40m", "3h", "2d". */
export function elapsed(fromIso: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(fromIso));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
