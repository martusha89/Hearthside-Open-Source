// Source-owned policy, bundled into the hash-pinned runtime copy. No dependency writes.
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A lock older than this with no live owner was left behind by a crash, not held. */
const STALE_LOCK_MS = 60_000;
function lockOwnerAlive(lock) {
  try {
    const owner = JSON.parse(fs.readFileSync(join(lock, 'owner.json'), 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    if (owner.pid === process.pid) return true;
    process.kill(owner.pid, 0); // Existence check only; throws when the process is gone.
    return true;
  } catch (error) {
    return error?.code === 'EPERM'; // Alive, but not ours to signal.
  }
}
export function locked(path, work) {
  fs.mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.hearthside-write-lock`;
  const take = () => fs.mkdirSync(lock);
  try { take(); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    // Contention fails closed. A lock whose owner is gone and that is old enough
    // not to be mid-write is a crash's leftover: clear it, or no save ever works again.
    let age = 0;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { age = 0; }
    if (lockOwnerAlive(lock) || age < STALE_LOCK_MS) {
      const busy = new Error('EEXIST: another channel policy write is in progress; try again');
      busy.code = 'EEXIST';
      throw busy;
    }
    // Claim the leftover by renaming it: if another process cleared and retook the
    // lock meanwhile, the rename fails and their fresh lock is left alone.
    const claimed = `${lock}.stale.${randomUUID()}`;
    try { fs.renameSync(lock, claimed); } catch { const busy = new Error('EEXIST: another channel policy write is in progress; try again'); busy.code = 'EEXIST'; throw busy; }
    fs.rmSync(claimed, { recursive: true, force: true });
    take();
  }
  try {
    fs.writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return work();
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
export function atomicJson(path, data) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, path);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return copy(fallback);
    // JSON.parse diagnostics can include credential-bearing document fragments.
    // Never attach the original error/cause or filename to protocol-visible errors.
    throw new Error('Unable to read a valid channel policy document');
  }
}
function merge(base, proposed, current) {
  if (equal(base, proposed)) return copy(current);
  if (equal(base, current) || equal(proposed, current)) return copy(proposed);
  if (record(base) && record(proposed) && record(current)) {
    const result = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(proposed), ...Object.keys(current)])) {
      const value = merge(base[key], proposed[key], current[key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  throw new Error('Concurrent channel account change: reload before retry');
}
function accountMap(accounts) {
  if (!Array.isArray(accounts)) throw new Error('Invalid accounts document');
  const map = new Map();
  for (const account of accounts) {
    if (!record(account) || typeof account.accountId !== 'string' || !account.accountId || map.has(account.accountId)) throw new Error('Invalid account identity');
    map.set(account.accountId, account);
  }
  return map;
}
function policy(accounts) {
  return accounts.map(a => ({ accountId: a.accountId, enabled: a.enabled,
    allowed_channels: a.allowed_channels ?? a.allowedChannels, allow_bots: a.allow_bots ?? a.allowBots,
    hearthside_companion_policy: a.hearthside_companion_policy ?? a.hearthsideCompanionPolicy }));
}
export function writeAccounts(path, baseline, proposed, reason = 'runtime-account-save', normalize = value => value) {
  return locked(path, () => {
    const disk = readJson(path, { accounts: [] });
    if (!record(disk)) throw new Error('Invalid accounts document');
    accountMap(disk.accounts); // Validate before invoking vendor normalization.
    const before = accountMap(disk.accounts.map(normalize)), base = accountMap(baseline), next = accountMap(proposed);
    const result = new Map(before);
    for (const id of new Set([...base.keys(), ...next.keys()])) {
      const merged = merge(base.get(id), next.get(id), before.get(id));
      if (merged === undefined) result.delete(id); else result.set(id, merged);
    }
    const accounts = [...result.values()];
    atomicJson(path, { ...disk, accounts });
    console.info(JSON.stringify({ event: 'hearthside.accounts.write', pid: process.pid, reason,
      beforePolicy: policy(disk.accounts), afterPolicy: policy(accounts) }));
    return accounts;
  });
}

const snowflake = id => typeof id === 'string' && /^[1-9]\d+$/.test(id);
const LOOP_WINDOW_MS = 120_000;
const LOOP_COOLDOWN_MS = 30_000;
const LOOP_MAX_BOT_INPUTS = 12;
function policyState(directory, accountId) {
  const doc = readJson(join(directory, 'accounts.json'), null);
  const account = doc?.accounts?.find(a => a.accountId === accountId);
  if (!account) return { status: 'missing' };
  if (account.enabled === false) return { status: 'invalid', account };
  const present = Object.hasOwn(account, 'hearthside_companion_policy') || Object.hasOwn(account, 'hearthsideCompanionPolicy');
  const value = account?.hearthside_companion_policy ?? account?.hearthsideCompanionPolicy;
  if (!present) return { status: 'absent', account };
  if (!record(value) || Object.keys(value).some(key => !['version', 'ambient', 'mentions'].includes(key)) ||
    value.version !== 1 || typeof value.ambient !== 'boolean' || typeof value.mentions !== 'boolean') return { status: 'invalid', account };
  return { status: 'valid', account, value };
}
function legacyConfig(directory, accountId, channelId) {
  try {
    const config = readJson(join(directory, 'hearthside-trusted-ingress.json'), null);
    return config?.version === 1 && config.enabled === true && config.accountId === accountId &&
      Array.isArray(config.channelIds) && config.channelIds.every(snowflake) && config.channelIds.includes(channelId) &&
      Array.isArray(config.botIds) && config.botIds.length > 0 && config.botIds.every(snowflake) ? config : null;
  } catch { return null; }
}
function channelMode(account, message) {
  const allowed = account.allowed_channels ?? account.allowedChannels;
  const gate = message.channel?.isThread?.() ? message.channel.parentId ?? message.channelId : message.channelId;
  return Array.isArray(allowed) ? (allowed.includes(gate) ? 'mention-only' : null) : allowed?.[gate] ?? allowed?.['*'];
}
/**
 * The native room rules for a person's message: an unconfigured account defaults to
 * mention-only, a configured account that omits this room (or maps it to anything but
 * open/mention-only) stays muted, and threads keep their unmentioned default. The
 * permissive default must never authorize bot participation, so bots never come here.
 */
function humanRoomAdmitted(account, message, mentioned) {
  let mode = channelMode(account, message);
  const allowed = account.allowed_channels ?? account.allowedChannels;
  if (mode == null && (!allowed || (Array.isArray(allowed) ? allowed.length === 0 : record(allowed) && Object.keys(allowed).length === 0))) mode = 'mention-only';
  if (!['open', 'mention-only'].includes(mode)) return false;
  return mode === 'open' || mentioned || message.channel?.isThread?.() === true;
}
export function trustedScope(directory, accountId, channelId) {
  try {
    const state = policyState(directory, accountId);
    if (state.status === 'invalid') return true; // managed and fail-closed, never fall through to allow_bots
    if (state.status === 'missing') return true;
    if (state.status === 'valid') return typeof channelId === 'string';
    return legacyConfig(directory, accountId, channelId) !== null;
  } catch { return true; }
}
export function committedOwnerMatches(directory, accountId, agentId) {
  try {
    const state = policyState(directory, accountId);
    if (!state.account) return false;
    return (state.account.agent_id ?? state.account.agentId) === agentId;
  } catch { return false; }
}
export function ingressEnvelope(directory, accountId, message, selfId, mentioned = false, explicitlyMentioned = mentioned) {
  try {
    if (!message?.author?.id || typeof message.author.bot !== 'boolean' || !selfId || message.author.id === selfId || message.webhookId || message.system ||
      ![0, 19].includes(message.type)) return false;
    if (!message.author.bot) return true;
    const state = policyState(directory, accountId);
    // Managed bots require positive room authorization even for explicit mentions.
    // Enforce this at ingress, before auto-thread creation, as well as at delivery.
    if (state.status === 'valid') return !!message.guildId && ['open', 'mention-only'].includes(channelMode(state.account, message)) &&
      (explicitlyMentioned ? state.value.mentions : state.value.ambient);
    if (state.status !== 'absent') return false;
    const legacy = legacyConfig(directory, accountId, message.channelId);
    return !!message.guildId && !!legacy && legacy.botIds.includes(message.author.id);
  } catch { return false; }
}
/** Re-read the committed account. Mention-only remains strict for humans; ambient is a bot-only exception. */
export function admitCommitted(directory, accountId, message, selfId, mentioned, wasScoped = false, explicitlyMentioned = mentioned) {
  try {
    const state = policyState(directory, accountId);
    const found = state.status === 'valid' ? state : null;
    if (!found && state.status === 'absent' && legacyConfig(directory, accountId, message?.channelId)) {
      if (!ingressEnvelope(directory, accountId, message, selfId, mentioned, explicitlyMentioned) || !message.guildId) return false;
      // The legacy bot opt-in bounds which BOTS may speak. A person's message keeps the
      // same native room authorization it has when no opt-in file exists; the bot-shaped
      // room check below would otherwise mute people in unconfigured rooms.
      if (!message.author.bot) return humanRoomAdmitted(state.account, message, mentioned);
      if (!snowflake(message.id)) return false;
      const mode = channelMode(state.account, message);
      return ['open', 'mention-only'].includes(mode) && (mode !== 'mention-only' || mentioned);
    }
    if (!found) {
      if (state.status !== 'absent') return false;
      if (!wasScoped) return true;
      // The opt-in went away while this input was in flight. A bot admitted by the
      // scoped envelope loses its only basis; a person's admission never rested on it.
      return message?.author?.bot === false && ingressEnvelope(directory, accountId, message, selfId, mentioned, explicitlyMentioned);
    }
    if (!ingressEnvelope(directory, accountId, message, selfId, mentioned, explicitlyMentioned)) return false;
    if (!message.guildId || !snowflake(message.id)) return false;
    if (!message.author.bot) return humanRoomAdmitted(found.account, message, mentioned);
    return ['open', 'mention-only'].includes(channelMode(found.account, message));
  } catch { return false; }
}
function legacyStateInvalid(old) {
  return !!old && (!snowflake(old.lastId) || !Number.isSafeInteger(old.rootAt) || !Number.isSafeInteger(old.lastAt) ||
    !Number.isInteger(old.turns) || old.turns < 0 || old.turns > 3 || typeof old.closed !== 'boolean');
}
/**
 * Record the human root that later bounds trusted-bot turns. Best effort by design:
 * the caller has already admitted this person's message, so an unusable id, a bad
 * clock, a stale/queued message or an unwritable state file must leave the delivery
 * alone and simply seed nothing. Preconditions stay exactly those the bot turns
 * relied on before, so a failure here can never widen bot admission.
 */
function seedHumanRoot(directory, accountId, message, mentioned, now) {
  try {
    if (!snowflake(message.id) || !Number.isSafeInteger(now)) return false;
    if (!Number.isSafeInteger(message.createdTimestamp) || message.createdTimestamp <= 0 ||
      message.createdTimestamp > now || now - message.createdTimestamp >= 60_000) return false;
    const stateAccount = policyState(directory, accountId).account;
    if (!stateAccount || stateAccount.enabled === false) return false;
    const mode = channelMode(stateAccount, message);
    if (!['open', 'mention-only'].includes(mode) || (mode === 'mention-only' && !mentioned)) return false;
    const path = join(directory, 'hearthside-trusted-ingress-state.json');
    return locked(path, () => {
      const state = readJson(path, { version: 1, exchanges: {} });
      if (state.version !== 1 || !record(state.exchanges)) return false;
      const key = JSON.stringify([accountId, message.channelId]), old = state.exchanges[key];
      if (legacyStateInvalid(old)) return false;
      if (old && BigInt(message.id) <= BigInt(old.lastId)) return false; // Duplicate/out-of-order: never re-root.
      if (old && now < old.lastAt) { old.closed = true; atomicJson(path, state); return false; }
      state.exchanges[key] = { rootAt: message.createdTimestamp, lastAt: message.createdTimestamp, lastId: message.id, turns: 0, closed: false };
      atomicJson(path, state);
      return true;
    });
  } catch { return false; }
}
function admitLegacy(directory, accountId, message, selfId, mentioned, now) {
  if (!ingressEnvelope(directory, accountId, message, selfId, mentioned) || !message.guildId) return false;
  const stateAccount = policyState(directory, accountId).account;
  if (!stateAccount || stateAccount.enabled === false) return false;
  // admitCommitted already applied this person's native room authorization. Seeding is
  // bookkeeping for later bot turns, not a condition of letting them through.
  if (!message.author.bot) { seedHumanRoot(directory, accountId, message, mentioned, now); return true; }
  if (!snowflake(message.id) || !Number.isSafeInteger(now)) return false;
  const mode = channelMode(stateAccount, message);
  if (!['open', 'mention-only'].includes(mode) || (mode === 'mention-only' && !mentioned)) return false;
  const path = join(directory, 'hearthside-trusted-ingress-state.json');
  return locked(path, () => {
    const state = readJson(path, { version: 1, exchanges: {} });
    if (state.version !== 1 || !record(state.exchanges)) return false;
    const key = JSON.stringify([accountId, message.channelId]), old = state.exchanges[key];
    if (legacyStateInvalid(old)) return false;
    if (old && BigInt(message.id) <= BigInt(old.lastId)) return false;
    if (old && now < old.lastAt) { old.closed = true; atomicJson(path, state); return false; }
    if (!old) return false;
    old.lastId = message.id;
    if (now < old.lastAt || now < old.rootAt || now - old.lastAt >= 60_000 || now - old.rootAt >= 900_000 || old.turns >= 3) old.closed = true;
    if (old.closed) { atomicJson(path, state); return false; }
    old.turns++; old.lastAt = now; if (old.turns >= 3) old.closed = true; atomicJson(path, state); return true;
  });
}
function reserveLoop(directory, accountId, message, now) {
  if (!message.author.bot) return true;
  if (!Number.isSafeInteger(now)) return false;
  const path = join(directory, 'hearthside-companion-loop-state.json');
  return locked(path, () => {
    const state = readJson(path, { version: 1, channels: {} });
    if (state.version !== 1 || !record(state.channels)) return false;
    const key = JSON.stringify([accountId, message.channelId]);
    let old = state.channels[key];
    if (old && (!snowflake(old.lastId) || !Number.isSafeInteger(old.windowAt) || !Number.isSafeInteger(old.lastAt) ||
      !Number.isInteger(old.count) || old.count < 0 || old.count > LOOP_MAX_BOT_INPUTS ||
      (old.blockedUntil !== null && !Number.isSafeInteger(old.blockedUntil)))) return false;
    if (old && BigInt(message.id) <= BigInt(old.lastId)) return false;
    if (old && now < old.lastAt) return false;
    if (old && old.blockedUntil !== null && now < old.blockedUntil) { old.lastId = message.id; state.channels[key] = old; atomicJson(path, state); return false; }
    if (!old || now - old.windowAt >= LOOP_WINDOW_MS) old = { windowAt: now, lastAt: now, lastId: message.id, count: 0, blockedUntil: null };
    if (old.blockedUntil !== null) old = { windowAt: now, lastAt: now, lastId: message.id, count: 0, blockedUntil: null };
    old.lastId = message.id; old.lastAt = now;
    if (old.count >= LOOP_MAX_BOT_INPUTS) { old.blockedUntil = now + LOOP_COOLDOWN_MS; state.channels[key] = old; atomicJson(path, state); return false; }
    old.count++;
    state.channels[key] = old;
    atomicJson(path, state);
    return true;
  });
}
export function admitTrusted(directory, accountId, message, selfId, mentioned, now = Date.now(), wasScoped = false, explicitlyMentioned = mentioned) {
  try {
    if (!admitCommitted(directory, accountId, message, selfId, mentioned, wasScoped, explicitlyMentioned)) return false;
    const state = policyState(directory, accountId);
    if (state.status === 'missing') return false;
    if (state.status === 'absent') return legacyConfig(directory, accountId, message.channelId)
      ? admitLegacy(directory, accountId, message, selfId, mentioned, now) : true;
    return state.status === 'valid' ? reserveLoop(directory, accountId, message, now) : false;
  }
  catch { return false; }
}
