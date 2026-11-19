// Exact-version/hash, exact-contract transform of a COPY, never node_modules.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, existsSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { instrumentRecovery, recoveryPrelude } from './stream-recovery-diagnostics.mjs';
import { transformHiddenForkDisposal, transformHiddenForkDisposalTypes } from './hidden-fork-disposal.mjs';
import { transformLocalHiddenForkDisposal } from './local-hidden-fork-disposal.mjs';
import { transformRecallReliability } from './recall-reliability.mjs';
import { transformLocalTurnCancel } from './local-turn-cancel.mjs';
import { transformLocalContextInherit } from './local-context-inherit.mjs';
import { transformChannelDeliveryLiveness, deliveryPrelude } from './channel-delivery-liveness.mjs';
export const UPSTREAM_SHA256 = 'd32706d8852136c8a8a30ae4b587845417fbd1bfccc2b96d73675d1f25b09acc';
export const VERSION = '0.34.36';
export const MOD_TYPES_PATH = 'dist/types/mods/types.d.ts';
const here = dirname(fileURLToPath(import.meta.url));
export const outputDir = join(here, '..', 'build', 'patched-runtime');
/**
 * letta-code's own postinstall rewrites the first line of letta.js in place on
 * macOS and Linux when a supported Bun is installed (a shell shebang that
 * prefers Bun), which changes the file's hash and made this refuse a runtime
 * that is otherwise exactly the pinned one. Hearthside always starts the
 * runtime with Electron's Node and never through that line, so the published
 * first line is put back before the hash is checked: everything after it must
 * still match the pin byte for byte.
 */
const NODE_SHEBANG = '#!/usr/bin/env node';
const BUN_SHEBANG = `#!/bin/sh
":" //#; exec /usr/bin/env sh -c 'command -v bun >/dev/null && exec bun "$0" "$@" || exec node "$0" "$@"' "$0" "$@"`;
export function withPublishedShebang(source) {
  const head = Buffer.from(BUN_SHEBANG);
  if (source.length < head.length || !source.subarray(0, head.length).equals(head)) return source;
  return Buffer.concat([Buffer.from(NODE_SHEBANG), source.subarray(head.length)]);
}
export function transformRuntime(source, version) {
  source = withPublishedShebang(Buffer.isBuffer(source) ? source : Buffer.from(source));
  if (version !== VERSION || createHash('sha256').update(source).digest('hex') !== UPSTREAM_SHA256) throw new Error('Unsupported Letta runtime: refusing unvalidated policy transform');
  let text = source.toString('utf8');
  const replace = (from, to) => {
    if (text.split(from).length !== 2) throw new Error('Runtime policy contract mismatch');
    text = text.replace(from, to);
  };
  const replaceCount = (from, to, count) => {
    if (text.split(from).length !== count + 1) throw new Error('Runtime policy contract mismatch');
    text = text.split(from).join(to);
  };
  const replaceFirst = (from, to, count) => {
    if (text.split(from).length !== count + 1) throw new Error('Runtime policy contract mismatch');
    text = text.replace(from, to);
  };
  replace('function loadChannelAccounts(channelId) {', `function loadChannelAccounts(channelId) {
  const hhPath = getChannelAccountsPath(channelId);
  hhAccountBaselines.delete(hhPath);
  try {
    hhOriginalLoadChannelAccounts(channelId);
    // Legacy migration saves during load; retain that committed storage baseline
    // instead of replacing it with a hydrated in-memory credential snapshot.
    if (!hhAccountBaselines.has(hhPath)) {
      hhAccountBaselines.set(hhPath, (stores.get(channelId)?.accounts ?? []).map(hhStorageBaseline));
    }
  } catch (error) {
    stores.delete(channelId);
    hhAccountBaselines.delete(getChannelAccountsPath(channelId));
    throw error;
  }
}
function hhOriginalLoadChannelAccounts(channelId) {`);
  replace('  writeFileSync12(getChannelAccountsPath(channelId), `${JSON.stringify({ accounts: writeAccounts }, null, 2)}\n`, "utf-8");', `  const hhPath = getChannelAccountsPath(channelId);
  const hhMerged = hhPolicy.writeAccounts(hhPath, hhAccountBaselines.get(hhPath) ?? [], writeAccounts, "runtime-account-save", account => hhStorageBaseline(normalizeLoadedAccount(account)));
  hhAdoptCommittedAccounts(channelId, hhMerged, store.accounts);`);
  replace('    } catch {\n      stores.set(channelId, { accounts: [] });\n      return;\n    }',
    '    } catch {\n      throw new Error("Unable to read a valid channel policy document");\n    }');
  replace('function saveChannelAccounts(channelId) {', `function saveChannelAccounts(channelId) {
  const hhPreviousQueue = hhSecretWriteQueue;
  const hhWrites = [];
  hhSecretWriteQueue = hhWrites;
  try {
    hhOriginalSaveChannelAccounts(channelId);
    for (const write of hhWrites) queueSecretWrite(write());
  } catch (error) {
    // Upsert/remove mutate their cached store before saving. Invalidate it, rather
    // than exposing uncommitted mutations or restoring stale pre-conflict policy.
    stores.delete(channelId);
    hhAccountBaselines.delete(getChannelAccountsPath(channelId));
    throw error;
  } finally {
    hhSecretWriteQueue = hhPreviousQueue;
  }
}
function hhOriginalSaveChannelAccounts(channelId) {`);
  replace('        queueSecretWrite(setChannelSecret(cloned.channel, cloned.accountId, fieldPath, value));',
    '        hhSecretWriteQueue.push(() => setChannelSecret(cloned.channel, cloned.accountId, fieldPath, value));');
  replace('  saveChannelAccounts(channelId);\n  return cloneAccount(next);',
    '  saveChannelAccounts(channelId);\n  return getChannelAccount(channelId, account.accountId);');
  replace('  if (account && getCachedChannelCredentialsStoreMode() === "keyring") {\n    await Promise.all(getSecretFieldPaths(account).map((fieldPath) => deleteChannelSecret(channelId, accountId, fieldPath)));\n  }\n  return removeChannelAccount(channelId, accountId);',
    '  const removed = removeChannelAccount(channelId, accountId);\n  if (removed && account && getCachedChannelCredentialsStoreMode() === "keyring") {\n    await Promise.all(getSecretFieldPaths(account).map((fieldPath) => deleteChannelSecret(channelId, accountId, fieldPath)));\n  }\n  return removed;');
  replace('function clearChannelAccountStores() {\n  stores.clear();', 'function clearChannelAccountStores() {\n  hhAccountBaselines.clear();\n  stores.clear();');
  // Keep the generic MessageChannel description intact. The upstream conditional
  // scoped reply contract already permits reactions and no call when appropriate.
  replace('    allow_bots: "allowBots",\n    group_policy:', '    allow_bots: "allowBots",\n    hearthside_companion_policy: "hearthsideCompanionPolicy",\n    group_policy:');
  replace('  if (isDiscordChannelAccount(account) && account.allowedChannels) {\n    cloned.allowedChannels = Array.isArray(account.allowedChannels) ? [...account.allowedChannels] : { ...account.allowedChannels };\n  }',
    '  if (isDiscordChannelAccount(account) && account.allowedChannels) {\n    cloned.allowedChannels = Array.isArray(account.allowedChannels) ? [...account.allowedChannels] : { ...account.allowedChannels };\n  }\n  if (isDiscordChannelAccount(account) && account.hearthsideCompanionPolicy) cloned.hearthsideCompanionPolicy = { ...account.hearthsideCompanionPolicy };');
  // The Discord account builders list their fields explicitly, so a validated and
  // correctly mapped companion policy was accepted and then dropped before storage:
  // every save silently reverted the controls and policyState stayed "absent". Both
  // branches are disambiguated by the adjacent acknowledgeMessageReaction line.
  replace(`      allowBots: normalizedPatch.allowBots ?? existing.allowBots ?? false,
      acknowledgeMessageReaction: normalizedPatch.acknowledgeMessageReaction ?? existing.acknowledgeMessageReaction,`,
    `      allowBots: normalizedPatch.allowBots ?? existing.allowBots ?? false,
      hearthsideCompanionPolicy: normalizedPatch.hearthsideCompanionPolicy ?? existing.hearthsideCompanionPolicy,
      acknowledgeMessageReaction: normalizedPatch.acknowledgeMessageReaction ?? existing.acknowledgeMessageReaction,`);
  replace(`      allowBots: normalizedPatch.allowBots ?? false,
      acknowledgeMessageReaction: normalizedPatch.acknowledgeMessageReaction,`,
    `      allowBots: normalizedPatch.allowBots ?? false,
      hearthsideCompanionPolicy: normalizedPatch.hearthsideCompanionPolicy,
      acknowledgeMessageReaction: normalizedPatch.acknowledgeMessageReaction,`);
  replace('        if (!shouldAcceptDiscordInboundBotMessage({\n          message,\n          allowBots: config.allowBots,\n          botUserId: effectiveBotUserId,\n          wasExplicitlyMentioned: hasParsedBotMention && hasExplicitDiscordUserMention(message, effectiveBotUserId)\n        })) {', `        const hhExplicitBotMention = hasParsedBotMention && hasExplicitDiscordUserMention(message, effectiveBotUserId);
        const hhScopedIngress = hhPolicy.trustedScope(getChannelDir("discord"), config.accountId, message.channelId);
        if (!(hhScopedIngress
          ? hhPolicy.ingressEnvelope(getChannelDir("discord"), config.accountId, message, effectiveBotUserId, hasParsedBotMention, hhExplicitBotMention)
          : shouldAcceptDiscordInboundBotMessage({
              message,
              allowBots: config.allowBots,
              botUserId: effectiveBotUserId,
              wasExplicitlyMentioned: hhExplicitBotMention
            }))) {`);
  replace('        try {\n          await adapter.onMessage(inbound);\n        } catch (error4) {\n          console.error("[Discord] Error handling guild message:", error4);', `        inbound.hhSelfId = effectiveBotUserId;
        inbound.hhTrustedScope = hhScopedIngress;
        inbound.hhExplicitBotMention = hhExplicitBotMention;
        try {
          await adapter.onMessage(inbound);
        } catch (error4) {
          console.error("[Discord] Error handling guild message:", error4);`);
  replace('        if (!isThread && !wasMentioned && !isOpenChannel)\n          return;',
    '        if (!isThread && !wasMentioned && !isOpenChannel && !(hhScopedIngress && message.author?.bot))\n          return;');
  replace('        const normalizedEnvelopeText = wasMentioned ? normalizeDiscordMentionText(envelopeContent, botUserId) : envelopeContent;\n        const payload = resolveDiscordInboundPayload(message, normalizedEnvelopeText);',
    '        const normalizedEnvelopeText = wasMentioned ? normalizeDiscordMentionText(envelopeContent, botUserId) : envelopeContent;\n        const hhInboundText = hhScopedIngress && message.author?.bot && hhExplicitBotMention && !normalizedEnvelopeText ? envelopeContent : normalizedEnvelopeText;\n        const payload = resolveDiscordInboundPayload(message, hhInboundText);');
  // The adapter captures its startup account. Read the committed account store at
  // the FIRST admission gate, before stale mention-only can drop newly-open input.
  // Do not mutate the login/credential snapshot held by the long-lived client.
  replace('      client.on("messageCreate", async (message) => {\n        if (!adapter.onMessage)',
    '      client.on("messageCreate", async (message) => {\n        const config = hhDiscordAdmissionConfig(adapter.accountId);\n        if (!config) return;\n        if (!adapter.onMessage)');
  replace('      const handleReactionEvent = async (reaction, user, action3) => {\n        if (!adapter.onMessage)',
    '      const handleReactionEvent = async (reaction, user, action3) => {\n        const config = hhDiscordAdmissionConfig(adapter.accountId);\n        if (!config) return;\n        if (!adapter.onMessage)');
  replace('    const config = getChannelAccount(msg.channel, accountId);\n    const senderAccess',
    '    let config = getChannelAccount(msg.channel, accountId);\n    const senderAccess');
  replace('      if (!discordResult) {\n        return;\n      }\n      if (msg.chatType === "channel" && config.allowedChannels) {',
    '      if (!discordResult) {\n        return;\n      }\n      config = hhDiscordAdmissionConfig(accountId);\n      if (!config) return;\n      if (msg.chatType === "channel" && config.allowedChannels) {');
  // Scoped bot messages are conversation inputs, never native controls or slash commands.
  replace('    if (await deps.controls.tryHandleInbound(adapter, msg)) {',
    '    if (!(msg.channel === "discord" && msg.hhTrustedScope === true && msg.raw?.author?.bot) && await deps.controls.tryHandleInbound(adapter, msg)) {');
  replace('    if (await tryHandleChannelSlashCommand(adapter, msg, {',
    '    if (!(msg.channel === "discord" && msg.hhTrustedScope === true && msg.raw?.author?.bot) && await tryHandleChannelSlashCommand(adapter, msg, {');
  replace('      const isBareThreadMention = msg.isMention === true && !!msg.threadId && msg.text.trim().length === 0 && (!msg.attachments || msg.attachments.length === 0);',
    '      const isBareThreadMention = msg.isMention === true && !!msg.threadId && msg.text.trim().length === 0 && (!msg.attachments || msg.attachments.length === 0) && !(msg.hhTrustedScope === true && msg.raw?.author?.bot);');
  // Reserve only after sender ACLs, route policy, mute policy, command handling,
  // bare-mention rejection and async preparation. Reactions never create roots.
  replace('      deps.deliver({\n        route: discordResult.route,', `      if (msg.chatType === "channel" && !msg.reaction && (!hhAllowDiscordDelivery(msg, accountId) || !hhPolicy.admitTrusted(getChannelDir("discord"), accountId, msg.raw, msg.hhSelfId, msg.isMention === true, Date.now(), msg.hhTrustedScope === true, msg.hhExplicitBotMention === true))) return;
      deps.deliver({
        hhAdmission: msg.chatType === "channel" && !msg.reaction ? { accountId, raw: msg.raw, selfId: msg.hhSelfId, mentioned: msg.isMention === true, explicitlyMentioned: msg.hhExplicitBotMention === true, scoped: msg.hhTrustedScope === true, senderId: msg.senderId, chatId: msg.chatId, threadId: msg.threadId ?? null, parentChannelId: msg.parentChannelId ?? null, agentId: discordResult.route.agentId, conversationId: discordResult.route.conversationId } : undefined,
        route: discordResult.route,`);
  replace('  deliverOrBuffer(delivery) {\n    if (this.isReady()) {', `  deliverOrBuffer(delivery) {
    if (!hhQueuedDeliveryAllowed(delivery)) return;
    if (this.isReady()) {`);
  replace('      if (item) {\n        this.messageHandler(item);', '      if (item && hhQueuedDeliveryAllowed(item)) {\n        this.messageHandler(item);');
  replace('      const response = await this.client.submitInput({', `      if (!hhQueuedDeliveryAllowed(delivery)) {
        state2.pendingSourcesByClientMessageId.delete(delivery.clientMessageId);
        if (workAtSubmit && !state2.active) this.finishRejectedDelivery(state2, delivery);
        return false;
      }
      const response = await this.client.submitInput({`);
  replace('      content: delivery.content,\n      sources,', '      content: delivery.content,\n      sources,\n      hhAdmission: delivery.hhAdmission,');
  replaceFirst('    "inbound_debounce_ms"\n  ]);', '    "inbound_debounce_ms",\n    "hearthside_companion_policy"\n  ]);', 2);
  replaceFirst('&& (config.inbound_debounce_ms === undefined || typeof config.inbound_debounce_ms === "number" && Number.isFinite(config.inbound_debounce_ms) && config.inbound_debounce_ms >= 0 && config.inbound_debounce_ms <= 1e4);',
    '&& (config.inbound_debounce_ms === undefined || typeof config.inbound_debounce_ms === "number" && Number.isFinite(config.inbound_debounce_ms) && config.inbound_debounce_ms >= 0 && config.inbound_debounce_ms <= 1e4) && hhValidCompanionPolicy(config.hearthside_companion_policy);', 2);
  replace('        removeStaleRoutes: isBoolean2(config.remove_stale_routes) ? config.remove_stale_routes : undefined\n      };',
    '        removeStaleRoutes: isBoolean2(config.remove_stale_routes) ? config.remove_stale_routes : undefined,\n        hearthsideCompanionPolicy: config.hearthside_companion_policy\n      };');
  replaceFirst('        inbound_debounce_ms: account.inboundDebounceMs\n      };',
    '        inbound_debounce_ms: account.inboundDebounceMs,\n        hearthside_companion_policy: account.hearthsideCompanionPolicy\n      };', 4);
  replaceFirst('        inbound_debounce_ms: account.inboundDebounceMs\n      };',
    '        inbound_debounce_ms: account.inboundDebounceMs,\n        hearthside_companion_policy: account.hearthsideCompanionPolicy\n      };', 3);
  const prelude = `\n// Hearthside validated runtime policy v1; upstream ${UPSTREAM_SHA256}
import * as hhPolicy from "./hearthside-runtime-policy.mjs";
const hhAccountBaselines = new Map();
let hhSecretWriteQueue = [];
function hhDiscordAdmissionConfig(accountId) {
  try {
    const current = getChannelAccount("discord", accountId);
    return current && current.enabled !== false ? current : null;
  } catch { return null; }
}
function hhValidCompanionPolicy(value) {
  return value === undefined || !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => ["version", "ambient", "mentions"].includes(key)) &&
    value.version === 1 && typeof value.ambient === "boolean" && typeof value.mentions === "boolean";
}
function hhQueuedDeliveryAllowed(delivery) {
  const admission = delivery?.hhAdmission;
  if (!admission) return true;
  try {
    const current = hhDiscordAdmissionConfig(admission.accountId);
    const routeAgentId = delivery.route?.agentId ?? delivery.runtime?.agent_id;
    const routeConversationId = delivery.route?.conversationId ?? delivery.runtime?.conversation_id;
    if (!current || current.agentId !== admission.agentId || routeAgentId !== admission.agentId ||
      routeConversationId !== admission.conversationId ||
      evaluateChannelSenderAccess({ account: current, channelId: "discord", senderId: admission.senderId, chatType: "channel" }) !== "allow") return false;
    if (!hhPolicy.committedOwnerMatches(getChannelDir("discord"), admission.accountId, admission.agentId)) return false;
    if (!hhAllowDiscordDelivery({ channel: "discord", chatType: "channel", raw: admission.raw,
      senderId: admission.senderId, hhSelfId: admission.selfId, isMention: admission.mentioned, hhExplicitBotMention: admission.explicitlyMentioned,
      hhTrustedScope: admission.scoped }, admission.accountId)) return false;
    const route = loadRouteForInboundMessage({ channel: "discord", accountId: admission.accountId,
      chatId: admission.chatId, threadId: admission.threadId }, admission.accountId);
    if (!route || route.agentId !== admission.agentId || route.conversationId !== admission.conversationId) return false;
    return hhPolicy.admitCommitted(getChannelDir("discord"), admission.accountId, admission.raw,
      admission.selfId, admission.mentioned, admission.scoped, admission.explicitlyMentioned);
  } catch { return false; }
}
function hhAllowDiscordDelivery(msg, accountId) {
  // Async route/attachment preparation can span a committed policy change. Apply
  // native sender ACL, guild membership AND mention-mode rules again for ALL accounts.
  try {
    const current = hhDiscordAdmissionConfig(accountId);
    const raw = msg.raw;
    if (!current || !raw?.guildId || !raw.channelId) return false;
    if (evaluateChannelSenderAccess({ account: current, channelId: msg.channel,
      senderId: msg.senderId, chatType: msg.chatType }) !== "allow") return false;
    const isThread = typeof raw.channel?.isThread === "function" && raw.channel.isThread();
    const parentChannelId = raw.channel?.parentId ?? null;
    const mode = resolveDiscordChannelMode(raw.channelId, parentChannelId, isThread, current.allowedChannels);
    if (!isThread && msg.isMention !== true && mode !== "open" && !(msg.hhTrustedScope === true && raw.author?.bot)) return false;
    if (!isDiscordGuildChannelAllowed({ channelId: raw.channelId, parentChannelId, isThread, allowedChannels: current.allowedChannels })) return false;
    return msg.hhTrustedScope === true
      ? hhPolicy.ingressEnvelope(getChannelDir("discord"), accountId, raw, msg.hhSelfId, msg.isMention === true, msg.hhExplicitBotMention === true)
      : shouldAcceptDiscordInboundBotMessage({ message: raw, allowBots: current.allowBots,
          botUserId: msg.hhSelfId, wasExplicitlyMentioned: msg.isMention === true && hasExplicitDiscordUserMention(raw, msg.hhSelfId) });
  } catch { return false; }
}
function hhAdoptCommittedAccounts(channelId, committed, proposedCache) {
  const accounts = committed.map(stored => {
    const normalized = normalizeLoadedAccount(stored);
    applySecretPlaceholders(normalized);
    const prior = proposedCache.find(account => account.accountId === normalized.accountId && account.channel === normalized.channel);
    // Restore only hydrated keyring values for references that survived the commit.
    // Never copy policy or overwrite a newly committed plaintext credential.
    if (prior && getCachedChannelCredentialsStoreMode() === "keyring") {
      for (const [fieldPath, present] of Object.entries(getSecretRefs(normalized))) {
        const cached = getSecretValueFromAccount(prior, fieldPath);
        if (present === true && isSecretPlaceholder(getSecretValueFromAccount(normalized, fieldPath)) &&
            typeof cached === "string" && cached.length > 0 && !isSecretPlaceholder(cached)) {
          setSecretValueOnAccount(normalized, fieldPath, cached);
        }
      }
    }
    return normalized;
  });
  // Baselines describe committed storage, never hydrated credentials or the stale
  // proposal. Both getters and upsert's returned account now see merged policy.
  const baseline = committed.map(stored => hhStorageBaseline(normalizeLoadedAccount(stored)));
  stores.set(channelId, { accounts });
  hhAccountBaselines.set(getChannelAccountsPath(channelId), baseline);
}
function hhStorageBaseline(account) {
  const stored = hhCanonicalAccount(account);
  // Load-time placeholders are cache-only, not persisted credentials. Keeping
  // them in the baseline falsely conflicts with removal of a keyring account.
  for (const [fieldPath, present] of Object.entries(getSecretRefs(stored))) {
    if (present === true && isSecretPlaceholder(getSecretValueFromAccount(stored, fieldPath))) {
      deleteSecretValueFromAccount(stored, fieldPath);
    }
  }
  return stored;
}
function hhCanonicalAccount(account) {
  const cloned = cloneAccount(account);
  for (const [snakeKey, camelKey] of Object.entries(SNAKE_TO_CAMEL)) {
    const value = cloned[camelKey];
    delete cloned[camelKey];
    if (value !== undefined) cloned[snakeKey] = value;
  }
  return JSON.parse(JSON.stringify(cloned));
}
`;
  const firstLine = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
  return transformLocalContextInherit(transformLocalTurnCancel(transformChannelDeliveryLiveness(transformRecallReliability(transformLocalHiddenForkDisposal(transformHiddenForkDisposal(instrumentRecovery(text.slice(0, firstLine) + prelude + deliveryPrelude + recoveryPrelude + text.slice(firstLine))))))));
}
export function normalizePolicySource(text) {
  return text.replace(/\r\n/g, '\n');
}
export function prepareRuntime() {
  const require = createRequire(join(here, '..', 'package.json'));
  const upstream = require.resolve('@letta-ai/letta-code');
  const version = JSON.parse(readFileSync(join(dirname(upstream), 'package.json'), 'utf8')).version;
  const transformed = transformRuntime(readFileSync(upstream), version);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'letta.js'), transformed);
  const policySource = normalizePolicySource(readFileSync(join(here, 'runtime-policy.mjs'), 'utf8'));
  writeFileSync(join(outputDir, 'hearthside-runtime-policy.mjs'), policySource);
  copyFileSync(join(dirname(upstream), 'package.json'), join(outputDir, 'package.json'));
  for (const asset of ['assets', 'dist', 'scripts', 'skills', 'vendor', 'image-resize-worker.js', 'cursor-worker.js']) {
    if (existsSync(join(dirname(upstream), asset))) cpSync(join(dirname(upstream), asset), join(outputDir, asset), { recursive: true });
  }
  // Keep the shipped scoped API declarations in step with the source-owned capability.
  writeFileSync(join(outputDir, MOD_TYPES_PATH), transformHiddenForkDisposalTypes(readFileSync(join(dirname(upstream), MOD_TYPES_PATH), 'utf8')));
  // Unpackaged (dev, e2e, replay), the copy runs from build/, where Node can't see the
  // packages nested under the upstream's own node_modules: link them in. Hoisted ones
  // resolve by walking up to apps/desktop/node_modules. The packaged app never uses this:
  // after-pack stages the three files into the real letta-code folder.
  const nested = join(dirname(upstream), 'node_modules'), link = join(outputDir, 'node_modules');
  if (existsSync(nested) && !existsSync(link)) symlinkSync(nested, link, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify({ version, upstreamSha256: UPSTREAM_SHA256,
    artifactSha256: createHash('sha256').update(transformed).digest('hex'),
    policySha256: createHash('sha256').update(policySource).digest('hex') }));
  return outputDir;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) prepareRuntime();
