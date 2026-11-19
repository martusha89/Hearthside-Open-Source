import { request } from "./control.js";

/**
 * Hearthside: an agent's secrets (API keys and the like for its skills and
 * tools), kept by the runtime. Only the names ever reach the window.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

export async function listSecretNames(agentId: string): Promise<string[]> {
  const reply = await request<{ type: string; secrets?: Array<{ key: string }> }>("secret_list", { agent_id: agentId });
  return (reply.secrets ?? []).map((secret) => secret.key).sort();
}

export async function setSecret(agentId: string, name: string, value: string): Promise<string[]> {
  if (!NAME.test(name)) throw new Error("Use letters, numbers and underscores for the name, like SPOTIFY_TOKEN.");
  if (!value) throw new Error("The value is empty.");
  await request("secret_apply", { agent_id: agentId, set: { [name]: value }, unset: [] });
  return listSecretNames(agentId);
}

export async function removeSecret(agentId: string, name: string): Promise<string[]> {
  await request("secret_apply", { agent_id: agentId, set: {}, unset: [name] });
  return listSecretNames(agentId);
}
