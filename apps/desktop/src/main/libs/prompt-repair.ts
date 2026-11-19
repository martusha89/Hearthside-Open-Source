import { createHash, randomUUID } from "node:crypto";
import type { MemoryOverview } from "@hearthside/ipc-contract";
import { upgradeCompanionPrompt } from "../../renderer/src/lib/companion-prompt";

export interface PromptRepairDependencies {
  readSystem(agentId: string): Promise<string | null>;
  listMemory(agentId: string): Promise<MemoryOverview>;
  writeMemoryFile(agentId: string, path: string, content: string): Promise<void>;
  updateSystem(agentId: string, system: string): Promise<void>;
}

/** Keep every file below the runtime's 20,000-character default without changing limits.
 * Large prompts use UTF-8/base64 parts so whitespace and split Unicode characters
 * survive Markdown/header parsing. The index records ordering and an integrity hash.
 */
export function promptBackupFiles(system: string, v2: boolean, id: string) {
  const folder = `prompt-backup-${id}`;
  const backupPath = v2 ? `${folder}/MEMORY.md` : `reference/${folder}.md`;
  const description = "Archived Companion system instructions; reference only, not active guidance";
  const header = v2 ? "" : `---\ndescription: "${description}"\n---\n`;
  const intro = `${header}# Archived Companion instructions\n\nReference only. Saved before an explicitly confirmed technical upgrade.\n\n`;
  if (intro.length + system.length <= 16_000) return [{ path: backupPath, content: intro + system }];
  const encoded = Buffer.from(system, "utf8").toString("base64");
  const parts: Array<{ path: string; content: string }> = [];
  for (let offset = 0; offset < encoded.length; offset += 12_000) {
    const name = `part-${String(parts.length + 1).padStart(3, "0")}`;
    const path = v2 ? `${folder}/${name}.md` : `reference/${folder}-${name}.md`;
    const metadata = v2 ? `name: "${name}"\n` : "";
    parts.push({ path, content: `---\n${metadata}description: "${description}; base64 archive part"\n---\n\n\`\`\`base64\n${encoded.slice(offset, offset + 12_000)}\n\`\`\`\n` });
  }
  const manifest = intro + "This archive is encoded to preserve the exact original UTF-8 bytes. It is not active guidance.\n\n"
    + "To restore: read every part in the order below, concatenate only the text inside their base64 fences (ignoring whitespace), then base64-decode the combined string. Do not decode parts separately. Verify the SHA-256 before using the result.\n\n"
    + `Original UTF-8 bytes: ${Buffer.byteLength(system, "utf8")}\nSHA-256: ${createHash("sha256").update(system, "utf8").digest("hex")}\n\n`
    + parts.map(part => { const file = part.path.slice(part.path.lastIndexOf("/") + 1); return `- [${file}](${file})`; }).join("\n") + "\n";
  return [{ path: backupPath, content: manifest }, ...parts];
}

/** Explicit, staged upgrade only. Never moves identity into memory or installs a default. */
export async function restoreCompanionPrompt(
  agentId: string, expectedSystem: string, expectedReplacement: string, confirmed: boolean,
  deps: PromptRepairDependencies,
) {
  if (!confirmed) throw new Error("Explicit confirmation is required. Nothing was changed.");
  const replacement = upgradeCompanionPrompt(expectedSystem);
  if (replacement === null) throw new Error("This is not a recognised Hearthside companion prompt. Nothing was changed.");
  if (replacement !== expectedReplacement) throw new Error("The proposed instructions changed. Refresh the preview before repairing.");
  if (replacement === expectedSystem) throw new Error("These Companion instructions are already current. Nothing was changed.");
  const assertCurrent = async () => {
    if (await deps.readSystem(agentId) !== expectedSystem) throw new Error("The system instructions changed. Refresh the preview before repairing.");
  };
  await assertCurrent();
  const overview = await deps.listMemory(agentId);
  if (!overview.enabled) throw new Error("Enable memory before repairing companion instructions.");
  const v2 = overview.files.some(file => file.path === "MEMORY.md");
  if (!v2 && !overview.files.some(file => /^(system|reference)\//.test(file.path))) {
    throw new Error("Cannot verify the active memory layout. Nothing was changed.");
  }
  const id = randomUUID();
  // Same-agent authored memory only; never a shared mount or active core file.
  // v2 indexes must have no frontmatter; v1 reference Markdown requires description.
  const archive = promptBackupFiles(expectedSystem, v2, id);
  const backupPath = archive[0]!.path;
  let attempted = false;
  try {
    for (const file of archive) {
      await assertCurrent();
      const current = await deps.listMemory(agentId);
      if (current.files.some(existing => existing.path.toLowerCase() === file.path.toLowerCase())) throw new Error(`Refusing to replace existing memory: ${file.path}`);
      attempted = true;
      await deps.writeMemoryFile(agentId, file.path, file.content);
    }
    await assertCurrent();
    await deps.updateSystem(agentId, replacement);
    return { backupPath, mode: "companion-custom" as const };
  } catch (error) {
    // No blind rollback over another client's edits or an uncertain write result.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}${attempted ? ` Repair did not complete. A backup may remain at: ${backupPath}. No rollback was attempted; refresh the agent before retrying.` : ""}`);
  }
}
