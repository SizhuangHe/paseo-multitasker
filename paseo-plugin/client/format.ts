// Pure display helpers for the card components.
import { isErrorAsk, isHostAsk, isPermissionAsk } from "../shared/cards";
import type { QueueCard } from "../shared/rpc";

export {
  cardCounts,
  cardKind,
  cardTitle,
  hostAskLine,
  isHostAsk,
  isPermissionAsk,
  type CardCounts,
  type CardKind,
} from "../shared/cards";
export { elapsed } from "../shared/time";

export type CardStatus = "danger" | "warning" | "accent";

/** Dot color: an unresolved error → danger; other unresolved asks → warning; results only → accent. */
export function cardStatus(card: QueueCard): CardStatus {
  const open = card.asks.filter((ask) => !ask.resolved);
  if (open.some(isErrorAsk)) return "danger";
  if (card.receipts.some((receipt) => receipt.status === "failed" && !receipt.resolved) && open.length === 0) return "danger";
  if (open.length) return "warning";
  return "accent";
}

function openItems(card: QueueCard): { id: string }[] {
  return [...card.asks, ...card.results, ...card.receipts].filter((item) => !item.resolved);
}

/**
 * Only host asks are open: a card the host made (a permission request or a failed turn), or one the
 * user handed back while a permission request is still pending. It shows just those asks.
 */
export function hostOnly(card: QueueCard): boolean {
  const open = openItems(card);
  return open.length > 0 && open.every(isHostAsk);
}

/** Only permission requests are open: nothing to send or dismiss until they are answered. */
export function onlyPermissionsOpen(card: QueueCard): boolean {
  const open = openItems(card);
  return open.length > 0 && open.every(isPermissionAsk);
}

/** Home directory shown as ~. */
export function displayPath(path: string | null): string | null {
  if (!path) return null;
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~").replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

/** `#rrggbb` a moved toward b by t (0–1); a when either is not a 6-digit hex color. */
export function mix(a: string, b: string, t: number): string {
  const parse = (hex: string) => (/^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null);
  const from = parse(a);
  const to = parse(b);
  if (!from || !to) return a;
  return `#${from.map((v, i) => Math.round(v + (to[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

const HTTP_URL = /^https?:\/\/\S+$/i;

/** True only for http(s) URLs; javascript:, file:, custom protocols and anything else are never opened. */
export function isOpenableUrl(href: string): boolean {
  if (!HTTP_URL.test(href)) return false;
  let protocol: string;
  try {
    protocol = new URL(href).protocol;
  } catch (error) {
    // React Native's URL polyfill may not implement `protocol`; the strict pattern above
    // already limits the scheme to http(s), so only a parse failure on the web rejects here.
    return error instanceof TypeError ? false : true;
  }
  return protocol === "http:" || protocol === "https:";
}

export function isAbsolutePath(href: string): boolean {
  return href.startsWith("/") || href.startsWith("~/");
}

/** How a result link is shown: opened (http/https), copied (absolute path) or plain text. */
export function hrefKind(href: string | undefined): "url" | "path" | "text" {
  if (!href) return "text";
  if (isOpenableUrl(href)) return "url";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && isAbsolutePath(href)) return "path";
  return "text";
}
