import { createHash } from "node:crypto";
import { gatewayRequest } from "../channel-gateway";
import { channelBot, channelChatMode, connectionKey } from "../settings";

type Row = Record<string, unknown>;
export async function recoveryChannelRequest(type: string, body: Row): Promise<Row> {
  const reply = await gatewayRequest<Row>(type, body);
  if (reply.type !== `${type}_response` || reply.success !== true || reply.error) throw new Error("Channel inventory could not be verified.");
  return reply;
}
export function channelBinding(account: Row): { agentId: string; conversationId: string } {
  const config = account.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Channel binding configuration is unavailable.");
  const value = config as Row;
  const binding = value.binding;
  const source = binding && typeof binding === "object" && !Array.isArray(binding) ? binding as Row : value;
  return { agentId: typeof source.agent_id === "string" ? source.agent_id : "", conversationId: typeof source.conversation_id === "string" ? source.conversation_id : "default" };
}
export function channelConfigFingerprint(account: Row): string {
  channelBinding(account); // Reject missing configuration, never hash an empty substitute.
  const config = { ...account.config as Row };
  delete config.binding; delete config.agent_id; delete config.conversation_id;
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(config))).digest("hex");
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value) || value.some((v) => !v || typeof v !== "object" || Array.isArray(v))) throw new Error("Channel inventory response is incomplete.");
  return value;
}
/** Captures bindings even before a bot has any chat routes; never stores bot credentials. */
export async function captureChannelInventory(agentId: string) {
  const routes: Row[] = [], bots: Row[] = [];
  const channels = rows((await recoveryChannelRequest("channels_list", {})).channels);
  for (const channel of channels) {
    const channelId = channel.channel_id;
    if (typeof channelId !== "string" || !channelId) throw new Error("Channel identity is missing.");
    const allRoutes = rows((await recoveryChannelRequest("channel_routes_list", { channel_id: channelId })).routes);
    const ownedRoutes = allRoutes.filter((r) => r.agent_id === agentId);
    const used = new Set(ownedRoutes.map((r) => r.account_id));
    for (const route of ownedRoutes) {
      if (typeof route.account_id !== "string" || typeof route.chat_id !== "string" || typeof route.conversation_id !== "string") throw new Error("Source route identity is incomplete.");
      routes.push({ channelId, accountId: route.account_id, chatId: route.chat_id, conversationId: route.conversation_id, threadId: route.thread_id ?? null, enabled: route.enabled !== false });
    }
    const accounts = rows((await recoveryChannelRequest("channel_accounts_list", { channel_id: channelId })).accounts);
    for (const account of accounts) {
      const binding = channelBinding(account);
      if (binding.agentId !== agentId && !used.has(account.account_id)) continue;
      if (typeof account.account_id !== "string" || typeof account.running !== "boolean" || typeof account.enabled !== "boolean" || !Array.isArray(account.allowed_users) || typeof account.dm_policy !== "string") throw new Error("Source listener state is incomplete.");
      // Hearthside's own owner travels with the runtime binding it must agree with,
      // so a restored backup says which companion the bot belonged to. The token
      // fingerprint is deliberately left out: nothing about a credential is captured.
      const record = channelBot(account.account_id);
      bots.push({ channelId, accountId: account.account_id, name: account.display_name, dmPolicy: account.dm_policy, allowedUsers: account.allowed_users, chatMode: channelChatMode(account.account_id), connection: connectionKey(), enabled: account.enabled, running: account.running, binding, ownerAgentId: record?.agentId ?? null, claimed: Boolean(record?.agentId), configFingerprint: channelConfigFingerprint(account) });
    }
  }
  return { routes, bots };
}
