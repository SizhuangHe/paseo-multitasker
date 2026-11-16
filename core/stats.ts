// Usage numbers over the queue's cards and tracks. Pure: the CLI reads the store and formats.
import { soleItem } from "./store.ts";
import type { Card, Track } from "./types.ts";

/** The machine's own time zone: the day a card was filed on is the user's local day. */
export const STATS_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const CARD_KINDS = ["ask", "permission", "receipt", "result", "empty"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const CLOSE_PATHS = ["agent", "user", "superseded", "discussed"] as const;
export type ClosePath = (typeof CLOSE_PATHS)[number];

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The `closing` record a card may carry (version 9 of the store); cards without it are skipped. */
interface ClosingLike {
  via?: string;
  picks?: { recommended?: boolean }[];
  compact?: boolean;
  view?: string;
  batch?: boolean;
}

export interface DayRow {
  day: string;
  filed: Record<CardKind, number> & { total: number };
  closed: { user: number; agent: number; superseded: number };
}

export interface WaitRow {
  path: ClosePath;
  /** A card kind, or `all`. */
  kind: CardKind | "all";
  n: number;
  medianMin: number;
  p90Min: number;
  maxMin: number;
}

export interface OpenRow {
  id: string;
  waitHours: number;
  topic: string | null;
  line: string;
}

export interface TrackRow {
  id: string;
  ageHours: number;
  title: string;
  parent: string | null;
}

export interface Stats {
  since: string | null;
  timeZone: string;
  cards: { total: number; open: number; done: number };
  days: DayRow[];
  waits: WaitRow[];
  openOver24h: OpenRow[];
  tracks: { running: number; runningOver48h: TrackRow[] };
  closing: {
    cardsWithClosing: number;
    via: Record<string, number>;
    sends: number;
    picks: number;
    picksRecommended: number;
    /** Picks that took the recommended option, over all picks of sends; null with no picks. */
    recommendedShare: number | null;
  };
  /**
   * Send closes by what they chose against the recommendation. A send is on an ask with a recommended
   * option when any ask of the card names one (or a pick is marked recommended). Of those: all picks
   * recommended = `recommended`; any other pick = `other`; no picks = `replyOnly`.
   */
  picks: { n: number; recommended: number; other: number; replyOnly: number; noRecommendation: number };
  /** Closes with a closing record, by where they came from; `unrecorded` = the field is absent. */
  origin: {
    n: number;
    compact: { phone: number; desktop: number; unrecorded: number };
    view: { tree: number; columns: number; list: number; unrecorded: number };
    batch: number;
  };
}

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: STATS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD of an instant on the local calendar. */
export function dayKey(iso: string): string {
  return dayFormat.format(new Date(iso));
}

/**
 * permission = an ask carries the host's `permission` request, or every ask has a `perm:` id (host asks
 * filed before the field existed); a legacy card of agent asks with one `perm:` ask counts as an ask.
 * Else ask, result, receipt by what the card holds.
 */
export function cardKind(card: Card): CardKind {
  if (card.asks.some((a) => a.permission) || (card.asks.length && card.asks.every((a) => a.id.startsWith("perm:")))) return "permission";
  if (card.asks.length) return "ask";
  if (card.results.length) return "result";
  if (card.receipts.length) return "receipt";
  return "empty";
}

/** Linear interpolation between ranks, as usage.md computed it. */
export function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const k = (sorted.length - 1) * q;
  const f = Math.floor(k);
  const c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

function closePaths(card: Card): ClosePath[] {
  const paths: ClosePath[] = [];
  if (card.supersededBy) paths.push("superseded");
  else if (card.doneBy) paths.push(card.doneBy);
  if (card.discussingAt) paths.push("discussed");
  return paths;
}

function cardLine(card: Card): string {
  const sole = soleItem(card);
  if (sole?.kind === "ask") return `ask: ${sole.item.short ?? sole.item.question}`;
  if (sole?.kind === "result") return `result: ${sole.item.label}`;
  if (sole?.kind === "receipt") return `receipt: ${sole.item.title}`;
  return card.action;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeStats(
  allCards: Card[],
  allTracks: Track[],
  options: { since?: string | null; now?: Date } = {},
): Stats {
  const since = options.since ?? null;
  const now = (options.now ?? new Date()).getTime();
  const cards = since ? allCards.filter((c) => dayKey(c.firstReadyAt) >= since) : allCards;

  const days = new Map<string, DayRow>();
  const dayRow = (day: string): DayRow => {
    let row = days.get(day);
    if (!row) {
      const filed = { total: 0 } as DayRow["filed"];
      for (const kind of CARD_KINDS) filed[kind] = 0;
      row = { day, filed, closed: { user: 0, agent: 0, superseded: 0 } };
      days.set(day, row);
    }
    return row;
  };

  const waits = new Map<string, number[]>();
  const closing = { cardsWithClosing: 0, via: {} as Record<string, number>, sends: 0, picks: 0, picksRecommended: 0 };
  const picks = { n: 0, recommended: 0, other: 0, replyOnly: 0, noRecommendation: 0 };
  const origin = {
    n: 0,
    compact: { phone: 0, desktop: 0, unrecorded: 0 },
    view: { tree: 0, columns: 0, list: 0, unrecorded: 0 },
    batch: 0,
  };
  const openOver24h: OpenRow[] = [];

  for (const card of cards) {
    const kind = cardKind(card);
    const filed = dayRow(dayKey(card.firstReadyAt)).filed;
    filed[kind] += 1;
    filed.total += 1;

    if (card.state === "open") {
      const wait = now - Date.parse(card.firstReadyAt);
      if (wait > 24 * HOUR) {
        openOver24h.push({ id: card.id, waitHours: round1(wait / HOUR), topic: card.topic, line: cardLine(card) });
      }
      continue;
    }
    if (!card.doneAt) continue;
    const closed = dayRow(dayKey(card.doneAt)).closed;
    if (card.supersededBy) closed.superseded += 1;
    else if (card.doneBy) closed[card.doneBy] += 1;

    const waitMin = (Date.parse(card.doneAt) - Date.parse(card.firstReadyAt)) / MINUTE;
    for (const path of closePaths(card)) {
      for (const key of [`${path}/all`, `${path}/${kind}`]) {
        const list = waits.get(key);
        if (list) list.push(waitMin);
        else waits.set(key, [waitMin]);
      }
    }

    const info = (card as Card & { closing?: ClosingLike | null }).closing;
    if (info?.via) {
      closing.cardsWithClosing += 1;
      closing.via[info.via] = (closing.via[info.via] ?? 0) + 1;
      if (info.via === "send") {
        closing.sends += 1;
        for (const pick of info.picks ?? []) {
          closing.picks += 1;
          if (pick.recommended) closing.picksRecommended += 1;
        }
        const list = info.picks ?? [];
        if (card.asks.some((a) => a.recommended !== undefined) || list.some((p) => p.recommended)) {
          picks.n += 1;
          if (!list.length) picks.replyOnly += 1;
          else if (list.every((p) => p.recommended)) picks.recommended += 1;
          else picks.other += 1;
        } else picks.noRecommendation += 1;
      }
      origin.n += 1;
      origin.compact[info.compact === undefined ? "unrecorded" : info.compact ? "phone" : "desktop"] += 1;
      const view = info.view === "tree" || info.view === "columns" || info.view === "list" ? info.view : "unrecorded";
      origin.view[view] += 1;
      if (info.batch) origin.batch += 1;
    }
  }

  const waitRows: WaitRow[] = [];
  for (const path of CLOSE_PATHS) {
    for (const kind of ["all", ...CARD_KINDS] as const) {
      const list = waits.get(`${path}/${kind}`);
      if (!list) continue;
      waitRows.push({
        path,
        kind,
        n: list.length,
        medianMin: round1(percentile(list, 0.5)),
        p90Min: round1(percentile(list, 0.9)),
        maxMin: round1(Math.max(...list)),
      });
    }
  }

  const running = allTracks.filter((t) => t.state === "running");
  const runningOver48h = running
    .map((t) => ({ id: t.id, ageHours: round1((now - Date.parse(t.startedAt)) / HOUR), title: t.title, parent: t.parentSessionId?.slice(0, 8) ?? null }))
    .filter((t) => t.ageHours > 48)
    .sort((a, b) => b.ageHours - a.ageHours);

  return {
    since,
    timeZone: STATS_TIME_ZONE,
    cards: {
      total: cards.length,
      open: cards.filter((c) => c.state === "open").length,
      done: cards.filter((c) => c.state === "done").length,
    },
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    waits: waitRows,
    openOver24h: openOver24h.sort((a, b) => b.waitHours - a.waitHours),
    tracks: { running: running.length, runningOver48h },
    closing: {
      ...closing,
      recommendedShare: closing.picks ? round1((closing.picksRecommended / closing.picks) * 100) : null,
    },
    picks,
    origin,
  };
}

/** `48h`, `2d` or `30m` in milliseconds; null when it is none of those. */
export function parseDuration(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([mhd])$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * { m: MINUTE, h: HOUR, d: 24 * HOUR }[match[2] as "m" | "h" | "d"];
}

/** Tracks newest first; `running` keeps only running ones, `olderThanMs` only those started longer ago. */
export function selectTracks(
  tracks: Track[],
  options: { running?: boolean; olderThanMs?: number; now?: Date } = {},
): Track[] {
  const now = (options.now ?? new Date()).getTime();
  return tracks
    .filter((t) => !options.running || t.state === "running")
    .filter((t) => options.olderThanMs === undefined || now - Date.parse(t.startedAt) > options.olderThanMs)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
