import type { ToolsetInfo, ToolsetPreference } from "@hearthside/ipc-contract";
import { deviceStatus, request } from "./control.js";
import { listConversations } from "./runtime";

/**
 * Hearthside: which built-in tool set an agent uses. The runtime keeps the
 * choice per chat; Hearthside sets it for the agent's main chat and its other
 * chats together, and reads it back from the main chat.
 */

const scope = (agentId: string, conversationId = "default") => ({ agent_id: agentId, conversation_id: conversationId });

export async function getToolset(agentId: string): Promise<ToolsetInfo> {
  const status = await deviceStatus(scope(agentId));
  const options = Array.isArray(status.available_toolsets) ? (status.available_toolsets as Array<Record<string, unknown>>) : [];
  return {
    preference: (typeof status.current_toolset_preference === "string" ? status.current_toolset_preference : "auto") as ToolsetPreference,
    current: typeof status.current_toolset === "string" ? status.current_toolset : null,
    options: options.map((option) => ({
      id: String(option.id) as ToolsetPreference,
      name: String(option.display_name ?? option.id),
      description: String(option.description ?? ""),
    })),
  };
}

export async function setToolset(agentId: string, preference: ToolsetPreference): Promise<ToolsetInfo> {
  const chats = await listConversations(agentId).catch(() => []);
  const ids = ["default", ...chats.filter((chat) => !chat.main).map((chat) => chat.id)];
  for (const conversationId of ids) {
    await request("update_toolset", { runtime: scope(agentId, conversationId), toolset_preference: preference });
  }
  return getToolset(agentId);
}
