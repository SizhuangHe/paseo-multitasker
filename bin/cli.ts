// agent-queue CLI: a thin wrapper over core for manual use and backfill.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { computeStats, formatDecisions, parseDuration, Queue, QueueInputError, selectDecisions, selectTracks, soleItem } from "../core/index.ts";
import type { Card, DoneBy, Host, SessionIdentity, SessionSnapshot, Stats, Track } from "../core/index.ts";

const USAGE = `usage: agent-queue <command> [options]

  add       [identity] [--title T --cwd P --provider P --model M] [--replaces CARD_ID]   card JSON on stdin
  resolve   [identity] (--card CARD_ID [--card ...] | --all)   --item and --ask are aliases
  track     [identity | --no-parent] --title T [--child REF] [--started-at ISO]
  return    --track ID --status returned|failed --conclusion TEXT
  list      [--done] [--json]
  tracks    [--all] [--older-than 48h|2d] [--json]   running ones, or every state with --all; newest first
  track drop ID [--note TEXT]   close a running track as failed, no receipt card
  stats     [--since YYYY-MM-DD] [--json]   cards per day, wait by close path, stale cards and tracks, picks vs recommendation, close origin
  decisions [--since YYYY-MM-DD] [--topic TEXT] [--json]   closed asks newest first: when, question, what was picked
  inferred  [--json]   inferred agent endings newest first: when, session, question, outcome, final tail
  show      CARD_ID
  snooze    CARD_ID
  done      CARD_ID [--by user|agent]

identity: --host paseo --session ID, or env AGENT_QUEUE_SESSION=<host>:<id>
--db PATH (or env AGENT_QUEUE_DB) selects another database file.
For --host paseo, missing session details are read from \`paseo inspect\`.
add: one card per item ({topic, timeline, ask | result | receipt}); the older asks / results / receipts
lists become one card each. An open card of the session with the same short (result label, receipt
title) is updated in place; --replaces CARD_ID closes that card and puts the new one in its place.
--replace (no value) is accepted and ignored, for agents on the older guide.`;

const options = {
  db: { type: "string" },
  host: { type: "string" },
  session: { type: "string" },
  title: { type: "string" },
  cwd: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  card: { type: "string", multiple: true },
  item: { type: "string", multiple: true },
  ask: { type: "string", multiple: true },
  all: { type: "boolean" },
  replace: { type: "boolean" },
  replaces: { type: "string" },
  child: { type: "string" },
  "no-parent": { type: "boolean" },
  "started-at": { type: "string" },
  track: { type: "string" },
  status: { type: "string" },
  conclusion: { type: "string" },
  done: { type: "boolean" },
  json: { type: "boolean" },
  by: { type: "string" },
  running: { type: "boolean" }, // `tracks --running` is the default, accepted so older invocations still parse
  "older-than": { type: "string" },
  note: { type: "string" },
  since: { type: "string" },
  topic: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>["values"];

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
}

function parseHost(value: string): Host {
  if (value === "paseo") return value;
  fail(`unknown host "${value}" (paseo)`);
}

function identityFrom(values: Values): SessionIdentity {
  if (values.host || values.session) {
    if (!values.host || !values.session) fail("give both --host and --session");
    return { host: parseHost(values.host), sessionId: values.session };
  }
  const env = process.env.AGENT_QUEUE_SESSION;
  if (env) {
    const at = env.indexOf(":");
    if (at > 0) return { host: parseHost(env.slice(0, at)), sessionId: env.slice(at + 1) };
  }
  fail("no session: pass --host/--session or set AGENT_QUEUE_SESSION=<host>:<id>");
}

interface PaseoInspect {
  Id?: string;
  Name?: string | null;
  Cwd?: string | null;
  Provider?: string | null;
  Model?: string | null;
}

/** Full agent id and session details from the local Paseo daemon; null when it cannot answer. */
function inspectPaseo(sessionId: string): PaseoInspect | null {
  try {
    const out = execFileSync("paseo", ["inspect", sessionId, "--json"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out) as PaseoInspect;
  } catch {
    return null;
  }
}

function resolveSession(identity: SessionIdentity, values: Values): { identity: SessionIdentity; snapshot: SessionSnapshot } {
  const snapshot: SessionSnapshot = {
    sessionTitle: values.title ?? null,
    cwd: values.cwd ?? null,
    provider: values.provider ?? null,
    model: values.model ?? null,
  };
  if (identity.host !== "paseo") return { identity, snapshot };
  const needsLookup = !snapshot.sessionTitle || !snapshot.cwd || !snapshot.provider || !snapshot.model;
  const info = needsLookup || identity.sessionId.length < 36 ? inspectPaseo(identity.sessionId) : null;
  if (!info) return { identity, snapshot };
  return {
    identity: { host: "paseo", sessionId: info.Id ?? identity.sessionId },
    snapshot: {
      sessionTitle: snapshot.sessionTitle ?? info.Name ?? null,
      cwd: snapshot.cwd ?? info.Cwd ?? null,
      provider: snapshot.provider ?? info.Provider ?? null,
      model: snapshot.model ?? info.Model ?? null,
    },
  };
}

function readStdinJson(): unknown {
  const raw = readFileSync(0, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`stdin is not valid JSON: ${(error as Error).message}`);
  }
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** What the card holds: its one item (`ask: <short>`), or the open item counts of an older multi-item card. */
function itemSummary(card: Card): string {
  const sole = soleItem(card);
  if (sole?.kind === "ask") return `ask: ${sole.item.short ?? sole.item.question}`;
  if (sole?.kind === "result") return `result: ${sole.item.label}`;
  if (sole?.kind === "receipt") return `receipt: ${sole.item.title}`;
  const open = (items: { resolved: boolean }[]) => items.filter((item) => !item.resolved).length;
  return [
    open(card.asks) ? `${open(card.asks)} ask` : "",
    open(card.results) ? `${open(card.results)} result` : "",
    open(card.receipts) ? `${open(card.receipts)} receipt` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function cardLine(card: Card): string {
  return [card.id, card.firstReadyAt, `${card.host}:${card.sessionId.slice(0, 8)}`, card.topic ?? card.sessionTitle ?? "-", itemSummary(card)].join("\t");
}

/** Running: how long ago it started; ended: how long it ran. */
function trackRow(track: Track, now = Date.now()): string[] {
  const end = track.endedAt ? Date.parse(track.endedAt) : now;
  const duration = span((end - Date.parse(track.startedAt)) / 60_000);
  return [track.id, track.state, track.endedAt ? `ran ${duration}` : `${duration} ago`, track.parentSessionId?.slice(0, 8) ?? "-", track.childRef ? track.childRef.slice(0, 8) : "-", track.title];
}

function table(rows: string[][], gap = "  "): string {
  const widths: number[] = [];
  for (const row of rows) row.slice(0, -1).forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i < row.length - 1 ? cell.padEnd(widths[i]) : cell)).join(gap).trimEnd()).join("\n");
}

/** Minutes as `42m`, `3.1h` or `2.4d`. */
function span(minutes: number): string {
  if (minutes < 120) return `${minutes.toFixed(1)}m`;
  if (minutes < 2880) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

function formatStats(s: Stats): string {
  const out: string[] = [];
  out.push(`Cards ${s.cards.total} (open ${s.cards.open}, done ${s.cards.done}) ${s.since ? `filed since ${s.since}` : "all time"}, days in ${s.timeZone}`);
  out.push("", "Per day: filed by kind, closed by who");
  out.push(
    table([
      ["day", "filed", "ask", "permission", "receipt", "result", "empty", "|", "user", "agent", "superseded"],
      ...s.days.map((d) => [d.day, d.filed.total, d.filed.ask, d.filed.permission, d.filed.receipt, d.filed.result, d.filed.empty, "|", d.closed.user, d.closed.agent, d.closed.superseded].map(String)),
    ]),
  );
  out.push("", "Close paths: wait = done - first ready");
  out.push(table([["path", "kind", "n", "median", "p90", "max"], ...s.waits.map((w) => [w.path, w.kind, String(w.n), span(w.medianMin), span(w.p90Min), span(w.maxMin)])]));
  out.push("", `Open for more than 24 h: ${s.openOver24h.length}`);
  if (s.openOver24h.length) out.push(table(s.openOver24h.map((o) => [o.id, `${o.waitHours}h`, o.topic ?? "-", o.line])));
  out.push("", `Tracks: ${s.tracks.running} running, ${s.tracks.runningOver48h.length} for more than 48 h`);
  if (s.tracks.runningOver48h.length) out.push(table(s.tracks.runningOver48h.map((t) => [t.id, `${t.ageHours}h`, t.parent ?? "-", t.title])));
  const c = s.closing;
  out.push("", c.cardsWithClosing ? `Closed from the queue: ${c.cardsWithClosing} cards (${Object.entries(c.via).map(([via, n]) => `${via} ${n}`).join(", ")})` : "Closed from the queue: no closing records");
  if (c.picks) out.push(`Sends: ${c.sends}; picks on them ${c.picks}, recommended ${c.picksRecommended} (${c.recommendedShare}%)`);
  const p = s.picks;
  out.push("", "Picks on sends");
  if (!s.closing.sends) out.push("no closing records");
  else {
    out.push(`Sends on asks with a recommended option: ${p.n}; on asks without one: ${p.noRecommendation}`);
    if (p.n) out.push(table([["picked", "n"], ["the recommended option", String(p.recommended)], ["another option", String(p.other)], ["reply only, no pick", String(p.replyOnly)]]));
  }
  const o = s.origin;
  out.push("", "Close origin");
  if (!o.n) out.push("no closing records");
  else {
    out.push(table([
      ["closes", String(o.n), "batch", String(o.batch)],
      ["layout", `phone ${o.compact.phone}`, `desktop ${o.compact.desktop}`, `unrecorded ${o.compact.unrecorded}`],
      ["view", `tree ${o.view.tree}`, `columns ${o.view.columns}`, `list ${o.view.list}`, `unrecorded ${o.view.unrecorded}`],
    ]));
  }
  return out.join("\n");
}

/** YYYY-MM-DD naming a real day: 2026-02-31 and 2026-13-45 would otherwise parse and match nothing. */
function isCalendarDate(value: string): boolean {
  const day = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

function needPositional(positionals: string[], name: string): string {
  const value = positionals[1];
  if (!value) fail(`missing ${name}`);
  return value;
}

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return command || values.help ? 0 : 2;
  }
  const queue = new Queue(values.db ? { path: values.db } : {});
  try {
    switch (command) {
      case "add": {
        const stdin = readStdinJson();
        const input = values.replaces && stdin && typeof stdin === "object" ? { ...stdin, replaces: values.replaces } : stdin;
        const { identity, snapshot } = resolveSession(identityFrom(values), values);
        print(queue.add(identity, snapshot, input));
        return 0;
      }
      case "resolve": {
        const { identity } = resolveSession(identityFrom(values), values);
        const cards = [...(values.card ?? []), ...(values.item ?? []), ...(values.ask ?? [])];
        print(queue.resolve(identity, { cards, ...(values.all ? { all: true } : {}) }));
        return 0;
      }
      case "track": {
        if (positionals[1] === "drop") {
          print(queue.dropTrack(needPositional(positionals.slice(1), "track id"), values.note));
          return 0;
        }
        if (!values.title) fail("missing --title");
        const host = values["no-parent"] ? parseHost(values.host ?? "paseo") : identityFrom(values).host;
        const parent = values["no-parent"] ? null : resolveSession(identityFrom(values), values).identity.sessionId;
        let child = values.child;
        if (child && host === "paseo") child = inspectPaseo(child)?.Id ?? child;
        print(queue.track(host, parent, { title: values.title, ...(child ? { childRef: child } : {}) }, values["started-at"] ? { startedAt: values["started-at"] } : {}));
        return 0;
      }
      case "return": {
        if (!values.track) fail("missing --track");
        if (values.status !== "returned" && values.status !== "failed") fail("--status returned|failed");
        const track = queue.getTrack(values.track);
        if (!track) fail(`unknown track ${values.track}`);
        const target = track.parentSessionId ?? track.childRef;
        const snapshot = target && track.host === "paseo" ? resolveSession({ host: "paseo", sessionId: target }, values).snapshot : {};
        print(queue.returnTrack(track.id, { status: values.status, conclusion: values.conclusion ?? "" }, snapshot));
        return 0;
      }
      case "list": {
        const cards = queue.list({ state: values.done ? "done" : "open" });
        if (values.json) print(cards);
        else if (cards.length) for (const card of cards) process.stdout.write(`${cardLine(card)}\n`);
        else process.stdout.write(values.done ? "No closed cards.\n" : "No open cards.\n");
        return 0;
      }
      case "tracks": {
        const olderThanMs = values["older-than"] === undefined ? undefined : parseDuration(values["older-than"]);
        if (olderThanMs === null) fail("--older-than takes 30m, 48h or 2d");
        const tracks = selectTracks(queue.listTracks({ state: "all" }), { running: !values.all, ...(olderThanMs === undefined ? {} : { olderThanMs }) });
        if (values.json) print(tracks);
        else if (tracks.length) process.stdout.write(`${table(tracks.map((track) => trackRow(track)))}\n`);
        return 0;
      }
      case "stats": {
        if (values.since !== undefined && !isCalendarDate(values.since)) fail("--since takes YYYY-MM-DD");
        const stats = computeStats([...queue.list({ state: "open" }), ...queue.list({ state: "done" })], queue.listTracks({ state: "all" }), {
          since: values.since ?? null,
        });
        if (values.json) print(stats);
        else process.stdout.write(`${formatStats(stats)}\n`);
        return 0;
      }
      case "decisions": {
        if (values.since !== undefined && !isCalendarDate(values.since)) fail("--since takes YYYY-MM-DD");
        const rows = selectDecisions(queue.list({ state: "done" }), { since: values.since ?? null, topic: values.topic ?? null });
        if (values.json) print(rows);
        else if (rows.length) process.stdout.write(`${formatDecisions(rows)}\n`);
        return 0;
      }
      case "inferred": {
        const rows = queue.inferredLog();
        if (values.json) print(rows);
        else if (rows.length) {
          const line = (text: string) => [...text.replace(/\s+/g, " ").trim()].slice(-120).join("");
          process.stdout.write(`${table(rows.map((r) => [r.firstSeenAt.slice(0, 16).replace("T", " "), r.sessionId.slice(0, 8), r.hasQuestion ? "?" : "-", r.outcome ?? "open", line(r.finalTail)]))}\n`);
        }
        return 0;
      }
      case "show": {
        const card = queue.get(needPositional(positionals, "CARD_ID"));
        if (!card) fail("unknown card");
        print(card);
        return 0;
      }
      case "snooze":
        print(queue.snooze(needPositional(positionals, "CARD_ID")));
        return 0;
      case "done": {
        const by = (values.by ?? "user") as DoneBy;
        if (by !== "user" && by !== "agent") fail("--by user|agent");
        print(queue.done(needPositional(positionals, "CARD_ID"), by));
        return 0;
      }
      default:
        fail(`unknown command "${command}"\n\n${USAGE}`);
    }
  } finally {
    queue.close();
  }
}

// A reader that stops early (`| head`) closes the pipe; that is not a failure.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
  process.exit(0);
});

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof QueueInputError) {
    process.stderr.write(`agent-queue: invalid input\n${error.issues.map((issue) => `  - ${issue}`).join("\n")}\n`);
    process.exitCode = 2;
  } else if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
    process.stderr.write(`agent-queue: ${(error as Error).message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`agent-queue: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
