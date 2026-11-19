import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GptUsageReading, GptUsageSnapshot } from "@hearthside/ipc-contract";

/**
 * Hearthside: the readings of a ChatGPT plan's usage that Hearthside has
 * actually taken.
 *
 * ChatGPT reports only how full each window is right now — there is no history
 * endpoint — so a graph over time can only be the readings this computer saw
 * while Hearthside was open. They are kept here, exactly as reported, so the
 * graph never has to invent a past. Nothing else is stored: no tokens, no
 * account identifiers.
 *
 * Every reading belongs to a scope, which gpt-usage.ts derives from the
 * connection it was read on (see `readingsKey` there). Readings from two
 * connections are never combined, even when both plans are called
 * "chatgpt-plus-pro": one account's graph is not another's. When a plan is seen
 * to be disconnected its scope is retired — the next sign-in starts a fresh
 * history rather than continuing one that was somebody else's.
 */

type Row = { scope: string; label: string; at: string; usedPercent: number };

/**
 * Readings, which epoch each scope key is on (absent means the first), and
 * which ChatGPT sign-in era this computer is on (see `chatGptConnectionEra`).
 */
type Stored = { readings: Row[]; epochs?: Record<string, number>; era?: number };

/** Enough for a few weeks of readings per window without the file growing without bound. */
const PER_WINDOW = 240;
/** How many scopes keep their readings — a few accounts' worth, not every one ever seen. */
const MAX_SCOPES = 6;

let dirOverride: string | null = null;
let cache: Stored | null = null;

/** Tests: keep the file in a folder of their own. */
export function setGptUsageReadingsDir(dir: string | null): void {
  dirOverride = dir;
  cache = null;
}

function file(): string {
  return join(dirOverride ?? app.getPath("userData"), "gpt-usage-readings.json");
}

function isRow(value: unknown): value is Row {
  const row = value as Partial<Row> | null;
  return (
    !!row &&
    typeof row.scope === "string" &&
    typeof row.label === "string" &&
    typeof row.at === "string" &&
    Number.isFinite(Date.parse(row.at)) &&
    typeof row.usedPercent === "number" &&
    Number.isFinite(row.usedPercent)
  );
}

function epochs(stored: Stored): Record<string, number> {
  const raw = stored.epochs ?? {};
  return Object.fromEntries(
    Object.entries(raw).filter(([, epoch]) => typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0),
  );
}

function storedEra(stored: Partial<Stored>): number {
  const era = stored.era;
  return typeof era === "number" && Number.isInteger(era) && era >= 0 ? era : 0;
}

function load(): Stored {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as Stored;
    cache = { readings: (parsed.readings ?? []).filter(isRow), epochs: epochs(parsed), era: storedEra(parsed) };
  } catch {
    // A missing or unreadable file means no history, never an error for the person.
    cache = { readings: [], epochs: {}, era: 0 };
  }
  return cache;
}

/** The key of the scope a stored row belongs to, without its epoch. */
function keyOf(scope: string): string {
  return scope.split("#")[0] ?? scope;
}

/**
 * Keep the newest readings of each window, so one busy window can't crowd out
 * another, and only the most recently written scopes, so switching accounts
 * doesn't keep every history for ever. A scope's epoch is forgotten only once
 * nothing of its key is left to confuse with a later sign-in.
 */
function prune(stored: Stored): Stored {
  const groups = new Map<string, Row[]>();
  for (const row of stored.readings) {
    const key = `${row.scope}\u0000${row.label}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const capped = [...groups.values()].flatMap((group) => group.slice(-PER_WINDOW));
  const newest = new Map<string, number>();
  for (const row of capped) newest.set(row.scope, Math.max(newest.get(row.scope) ?? 0, Date.parse(row.at)));
  const kept = new Set(
    [...newest.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SCOPES)
      .map(([scope]) => scope),
  );
  const keys = new Set([...kept].map(keyOf));
  return {
    // The era is about the connection, not about any one scope's rows, so it
    // survives pruning.
    ...stored,
    readings: capped.filter((row) => kept.has(row.scope)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    epochs: Object.fromEntries(Object.entries(epochs(stored)).filter(([key]) => keys.has(key))),
  };
}

function save(next: Stored): void {
  const path = file();
  mkdirSync(dirname(path), { recursive: true });
  // Written beside and renamed, so a crash mid-write can't leave half a file
  // and lose every earlier reading.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(next));
  renameSync(temporary, path);
  cache = next;
}

/** The ChatGPT subscription entries in the provider catalogues, local and Cloud. */
export const CHATGPT_PROVIDER_IDS = ["openai-codex-oauth", "codex"];
/** The names the runtime saves a ChatGPT OAuth connection under. */
export const CHATGPT_PROVIDER_NAMES = ["chatgpt-plus-pro", "openai-codex"];

/**
 * Which ChatGPT sign-in era this computer is on.
 *
 * Nothing ChatGPT reports identifies the account: a reading says how full the
 * windows are, not whose they are, and the provider list gives only the name
 * the runtime saved the connection under ("chatgpt-plus-pro"). So this counts
 * the connection changes Hearthside can see instead — every ChatGPT provider
 * connected or disconnected through this app moves the era on, and the scope
 * that readings and view handles are derived from moves with it.
 *
 * It is kept on disk beside the readings, because the whole point is to tell a
 * later sign-in from an earlier one, and a counter that started again at zero
 * when Hearthside restarted would hand the new sign-in the old one's history.
 *
 * This is a discriminator for the changes this app can observe, not an account
 * identity. A credential replaced where Hearthside never sees it happen — by
 * `letta` on the command line, or by somebody else on a server this app is only
 * a client of — looks exactly like the same connection, and the only honest
 * thing to say is that Hearthside cannot tell.
 */
export function chatGptConnectionEra(): number {
  return storedEra(load());
}

/**
 * A provider has just been connected or disconnected through this app. If it
 * was the ChatGPT one, the plan on the other end may be somebody else's from
 * now on, so the era moves on: the readings kept so far become unreachable
 * rather than continuing into the new sign-in's graph, and any view handle
 * already on screen stops matching. Reconnecting the same account pays the same
 * price — a fresh graph — because nothing here can tell the two apart.
 */
export function noteProviderConnectionChange(providerId: string, providerName?: string): void {
  const chatgpt =
    CHATGPT_PROVIDER_IDS.includes(providerId) || (!!providerName && CHATGPT_PROVIDER_NAMES.includes(providerName));
  if (!chatgpt) return;
  try {
    save({ ...load(), era: storedEra(load()) + 1 });
  } catch (error) {
    // Failing to write it would quietly leave the new sign-in on the old
    // scope, so say so; the reading itself is unaffected.
    console.warn(`[gpt-usage] couldn't record the connection change: ${error instanceof Error ? error.message : "error"}`);
  }
}

/** The scope readings go to and come from for this connection, right now. */
export function readingScope(key: string): string {
  return `${key}#${epochs(load())[key] ?? 0}`;
}

/**
 * Set this connection's history aside: its plan is not connected any more, so
 * whatever is read next belongs to a different sign-in. The readings are not
 * continued into it — the scope moves on and the old one falls away with age.
 */
export function retireReadingScope(key: string): void {
  const stored = load();
  const scope = readingScope(key);
  // Nothing has been read on this scope, so there is nothing to set aside.
  if (!stored.readings.some((row) => row.scope === scope)) return;
  try {
    save(prune({ ...stored, epochs: { ...epochs(stored), [key]: (epochs(stored)[key] ?? 0) + 1 } }));
  } catch (error) {
    console.warn(`[gpt-usage] couldn't retire this history: ${error instanceof Error ? error.message : "error"}`);
  }
}

/**
 * Keep what this reading says about each window that reported a percentage.
 * A window with no percentage is not recorded — an absent figure is not a zero.
 * A reading the runtime served from its own cache (the same `fetchedAt`) is
 * recorded once.
 */
export function recordGptUsageReading(scope: string, snapshot: GptUsageSnapshot): void {
  const at = new Date(snapshot.fetchedAt).toISOString();
  const fresh = snapshot.windows
    .filter((window) => window.usedPercent !== null)
    .map((window) => ({ scope, label: window.label, at, usedPercent: window.usedPercent as number }));
  if (fresh.length === 0) return;
  const stored = load();
  const already = new Set(stored.readings.map((row) => `${row.scope} ${row.label} ${row.at}`));
  const added = fresh.filter((row) => !already.has(`${row.scope} ${row.label} ${row.at}`));
  if (added.length === 0) return;
  try {
    save(prune({ ...stored, readings: [...stored.readings, ...added] }));
  } catch (error) {
    // The graph is worth less than the reading itself; usage still shows.
    console.warn(`[gpt-usage] couldn't keep this reading: ${error instanceof Error ? error.message : "error"}`);
  }
}

/** This connection's kept readings, oldest first. */
export function gptUsageReadings(scope: string): GptUsageReading[] {
  return load()
    .readings.filter((row) => row.scope === scope)
    .map(({ at, label, usedPercent }) => ({ at, label, usedPercent }));
}
