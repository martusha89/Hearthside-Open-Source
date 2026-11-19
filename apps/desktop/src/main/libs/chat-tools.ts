import { execFile } from "node:child_process";
import type { ChatRow, MessageSearchResult } from "@hearthside/ipc-contract";
import { runtimeChildEnv } from "../runtime/child-env";
import { resolveLettaCli } from "../runtime/paths";
import { cloudAuth } from "./cloud-providers";
import { getConnectionConfig } from "./settings";

/**
 * Hearthside: search inside an agent's messages (the runtime's
 * `letta messages search`, the same search agents use for recall), and turn a
 * chat into a Markdown file.
 */

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const cloud = getConnectionConfig().backend === "cloud";
      const extra: Record<string, string> = {};
      if (cloud) {
        const auth = await cloudAuth();
        extra.LETTA_API_KEY = auth.token;
        extra.LETTA_BASE_URL = auth.baseUrl;
      }
      execFile(
        process.execPath,
        [resolveLettaCli(), "--backend", cloud ? "api" : "local", ...args],
        { env: runtimeChildEnv(extra), windowsHide: true, timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim().split("\n").pop() || error.message));
          else resolve(stdout);
        },
      );
    })().catch(reject);
  });
}

export async function searchMessages(agentId: string, query: string): Promise<MessageSearchResult[]> {
  const output = await runCli(["messages", "search", "--query", query, "--agent", agentId, "--limit", "30"]);
  const start = output.indexOf("[");
  const parsed = start >= 0 ? (JSON.parse(output.slice(start)) as Array<Record<string, unknown>>) : [];
  return parsed
    .map((item) => {
      const content = item.content ?? item.reasoning ?? item.text ?? "";
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join(" ") : "";
      const conversation = typeof item.conversation_id === "string" && item.conversation_id && item.conversation_id !== "default" ? item.conversation_id : `main:${agentId}`;
      return {
        messageId: String(item.message_id ?? item.id ?? ""),
        conversationId: conversation,
        role: String(item.message_type ?? "").replace(/_message$/, ""),
        text: text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim(),
        date: typeof item.created_at === "string" ? item.created_at : typeof item.date === "string" ? item.date : null,
      };
    })
    .filter((result) => result.text);
}

/** A chat as readable Markdown. */
export function chatToMarkdown(title: string, agentName: string, rows: readonly ChatRow[], note?: string): string {
  const lines = [`# ${title || "Chat"}`, "", `With ${agentName}, exported from Hearthside on ${new Date().toLocaleString()}.`, "", ...(note ? [`> ${note}`, ""] : [])];
  for (const row of rows) {
    switch (row.kind) {
      case "user":
        lines.push("**You:**", "", row.text, "");
        break;
      case "assistant":
        lines.push(`**${agentName}:**`, "", row.text, "");
        break;
      case "reasoning":
        lines.push(`> *Thinking:* ${row.text.replace(/\n/g, "\n> ")}`, "");
        break;
      case "tool_call":
        lines.push(`*${agentName} used ${row.toolName}${row.result?.isError ? " (failed)" : ""}.*`, "");
        break;
      case "compaction":
        lines.push("---", "", "*Earlier messages were summarised:*", "", row.summary, "", "---", "");
        break;
    }
  }
  return lines.join("\n");
}
