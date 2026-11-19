import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gatewayRequest as request } from "./channel-gateway";
import { resolveRuntimeHome } from "../runtime/paths";

/**
 * Hearthside: taking back a person's approval on a bot.
 *
 * Approving someone's pairing code writes them into the runtime's "approved"
 * list for that bot, and the runtime lets anyone on that list through whatever
 * the bot's policy or allowed-person list says afterwards. So narrowing a bot
 * to "Just me", or removing someone from the allowed people, changed what the
 * window showed and not who could get through.
 *
 * The pinned runtime (0.34.36) has no command that takes one person off that
 * list: it only empties it when the whole bot is deleted. What it does have is
 * the list itself, kept as a small file beside the bot's other channel files,
 * and two behaviours this relies on (both pinned by
 * channel-approvals-contract.test.ts, so an upgrade that changes them fails a
 * test rather than quietly bringing the old problem back):
 *
 *  - it reads that file again, replacing what it holds in memory, whenever it
 *    is asked who is waiting to be approved (`channel_pairings_list`);
 *  - it writes the file whole each time its own copy changes.
 *
 * So a person is taken off by rewriting the file without them and then asking
 * the runtime who is waiting, which makes it adopt the file. The runtime may
 * have written its own copy in between (someone new asking for a code), which
 * would put the person back, so the file is read once more afterwards and the
 * whole thing repeated if they are there again. If it still hasn't stuck, this
 * says so instead of reporting a change that didn't happen.
 */

type Wire = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The id the runtime files an approval under when it predates per-bot accounts. */
const LEGACY_ACCOUNT_ID = "__legacy_migrated__";
const ATTEMPTS = 3;

/** Where the runtime keeps who is waiting and who has been approved on a channel. */
export function pairingStorePath(channelId: string): string {
  const { home } = resolveRuntimeHome();
  // Named .yaml by the runtime, but what it writes and reads is JSON.
  return join(home ?? homedir(), ".letta", "channels", channelId, "pairing.yaml");
}

type Store = { approved: Wire[] } & Wire;

/** The runtime's list as it is on disk, or null when it has never written one. */
function readStore(path: string): Store | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Hearthside couldn't read who has been approved on this bot, so nobody's approval was taken back. Try again in a moment.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hearthside couldn't read who has been approved on this bot, so nobody's approval was taken back. Try again in a moment.");
  }
  const store = parsed as Wire;
  const approved = store.approved === undefined || store.approved === null ? [] : store.approved;
  if (!Array.isArray(approved) || approved.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error("Hearthside couldn't read who has been approved on this bot, so nobody's approval was taken back. Try again in a moment.");
  }
  return { ...store, approved: approved as Wire[] };
}

const onBot = (entry: Wire, accountId: string) => (str(entry.accountId) || LEGACY_ACCOUNT_ID) === accountId;

/** The people approved on one bot, as the runtime has them on disk. */
export function approvedSenders(channelId: string, accountId: string): string[] {
  const store = readStore(pairingStorePath(channelId));
  return store ? store.approved.filter((entry) => onBot(entry, accountId)).map((entry) => str(entry.senderId)).filter(Boolean) : [];
}

/**
 * Take back the approval of everyone on this bot that `revoke` picks out.
 * Returns the people whose approval was taken back. Other bots' approvals, and
 * the requests still waiting, are left exactly as they were.
 *
 * Call it from inside the bot's queue (channel-locks.ts): approving a request
 * is what adds to this list, and it goes through the same queue.
 */
export async function revokeApprovals(channelId: string, accountId: string, revoke: (senderId: string) => boolean): Promise<string[]> {
  const path = pairingStorePath(channelId);
  const targeted = (store: Store) => store.approved.filter((entry) => onBot(entry, accountId) && revoke(str(entry.senderId)));
  const revoked = new Set<string>();
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const store = readStore(path);
    const going = store ? targeted(store) : [];
    if (store && going.length) {
      for (const entry of going) revoked.add(str(entry.senderId));
      // Atomic replacement: the runtime ignores a list it can't parse.
      const temp = `${path}.hearthside-${process.pid}-${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify({ ...store, approved: store.approved.filter((entry) => !going.includes(entry)) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
      }
    }
    // Sync even if there was nothing to write. An earlier attempt may have
    // replaced the file but failed before the runtime adopted it.
    await request<Wire>("channel_pairings_list", { channel_id: channelId, account_id: accountId });
    // The runtime's copy is now whatever the file held when it read it. If it
    // had saved its older copy in between, they are back in the file: go again.
    const after = readStore(path);
    if (!after || targeted(after).length === 0) return [...revoked];
  }
  throw new Error("Hearthside couldn't take back that approval: the channel service kept putting it back. Try again in a moment; until then that person can still message this bot.");
}
