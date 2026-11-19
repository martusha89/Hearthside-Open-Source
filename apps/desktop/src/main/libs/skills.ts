import { app } from "electron";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { CatalogSkill, InstalledSkill, SkillSource, SkillTarget } from "@hearthside/ipc-contract";
import { deviceStatus, request } from "./control.js";
import { deleteMemoryFile, listMemory, writeMemoryFile } from "./memory";
import { readSkillNeeds } from "./skill-needs";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { DownloadTooBig, readCapped } from "./safe-fetch";

/**
 * Hearthside: skills. A skill is a folder with a SKILL.md (frontmatter: name,
 * description) plus optional scripts and references.
 *
 * - For one agent, a skill lives in its memory under skills/<name>/, so it
 *   follows the agent (Letta Cloud included).
 * - For every agent on this computer, it's copied to <userData>/skills/<name>
 *   and switched on with the runtime's skill_enable.
 *
 * Skills come from GitHub folders, including Letta's MIT-licensed collection
 * (letta-ai/skills).
 */

const CATALOG = { owner: "letta-ai", repo: "skills", ref: "main" };
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 60;
let catalogCache: { at: number; skills: CatalogSkill[] } | null = null;

type TreeEntry = { path: string; type: "blob" | "tree"; size?: number };

async function github<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Hearthside" } });
  if (response.status === 403 || response.status === 429) throw new Error("GitHub is limiting requests right now. Try again in a few minutes.");
  if (!response.ok) throw new Error(`GitHub said ${response.status} for ${url}.`);
  return (await response.json()) as T;
}

async function tree(source: Omit<SkillSource, "path">): Promise<TreeEntry[]> {
  const result = await github<{ tree: TreeEntry[] }>(
    `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`,
  );
  return result.tree;
}

async function raw(source: SkillSource, path: string): Promise<Buffer> {
  const response = await fetch(`https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(source.ref)}/${path.split("/").map(encodeURIComponent).join("/")}`);
  if (!response.ok) throw new Error(`Couldn't download ${path} (${response.status}).`);
  // The size GitHub listed isn't trusted: the download itself stops at the cap.
  try {
    return await readCapped(response, MAX_FILE_BYTES);
  } catch (error) {
    if (error instanceof DownloadTooBig) throw new Error(`${path} is bigger than Hearthside installs.`);
    throw error;
  }
}

/** The commit a branch or tag points at now, so every file comes from the same version. */
async function commitSha(source: Omit<SkillSource, "path">): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(source.ref)) return source.ref;
  const commit = await github<{ sha?: string }>(`https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref)}`);
  if (!commit.sha || !/^[0-9a-f]{40}$/i.test(commit.sha)) throw new Error("GitHub didn't say which version of the skill to download.");
  return commit.sha;
}



export function checkSkillFilePath(path: string): string {
  const bad = () => new Error(`A skill file has an unsafe name: ${path.slice(0, 120)}`);
  if (!path || path.length > 400 || /[\\\u0000-\u001f:*?"<>|]/.test(path) || path.startsWith("/")) throw bad();
  for (const part of path.split("/")) {
    if (!part || part === "." || part === ".." || /[. ]$/.test(part)) throw bad();
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(part)) throw bad();
  }
  return path;
}

/** name and description from a SKILL.md's frontmatter. */
export function readFrontmatter(text: string): { name: string | null; description: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!.toLowerCase()] = field[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return { name: fields.name || null, description: fields.description || null };
}

/** owner/repo/ref/path from a GitHub folder or SKILL.md link. */
export function parseGitHubUrl(url: string): SkillSource {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)(?:\/(.*?))?)?\/?$/.exec(url.trim());
  if (!match) throw new Error("That doesn't look like a GitHub folder link (https://github.com/owner/repo/tree/main/path).");
  let path = (match[4] ?? "").replace(/\/+$/, "");
  if (/(^|\/)SKILL\.md$/i.test(path)) path = path.replace(/\/?SKILL\.md$/i, "");
  return { owner: match[1]!, repo: match[2]!, ref: match[3] ?? "main", path };
}

/** Letta's skills collection: one entry per folder with a SKILL.md. */
export async function listCatalog(): Promise<CatalogSkill[]> {
  if (catalogCache && Date.now() - catalogCache.at < 30 * 60_000) return catalogCache.skills;
  const entries = await tree(CATALOG);
  const folders = entries
    .filter((entry) => entry.type === "blob" && /\/SKILL\.md$/.test(entry.path) && !entry.path.startsWith("."))
    .map((entry) => entry.path.replace(/\/SKILL\.md$/, ""));
  const skills = await Promise.all(
    folders.map(async (folder): Promise<CatalogSkill> => {
      const source = { ...CATALOG, path: folder };
      const text = await raw(source, `${folder}/SKILL.md`).then((buffer) => buffer.toString("utf8")).catch(() => "");
      const front = readFrontmatter(text);
      // The skill's own icon, as a data URL (the window only shows local images).
      const iconEntry =
        entries.find((entry) => entry.type === "blob" && entry.path.startsWith(`${folder}/assets/`) && /\.png$/i.test(entry.path) && (entry.size ?? 0) < 200_000) ??
        entries.find((entry) => entry.type === "blob" && entry.path.startsWith(`${folder}/assets/`) && /\.svg$/i.test(entry.path) && (entry.size ?? 0) < 100_000);
      const icon = iconEntry
        ? await raw(source, iconEntry.path)
            .then((buffer) => `data:${iconEntry.path.endsWith(".svg") ? "image/svg+xml" : "image/png"};base64,${buffer.toString("base64")}`)
            .catch(() => null)
        : null;
      return {
        source,
        name: front.name ?? folder.split("/").pop()!,
        description: front.description ?? "",
        group: folder.split("/")[0] ?? "",
        needs: readSkillNeeds(text),
        icon,
      };
    }),
  );
  skills.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  catalogCache = { at: Date.now(), skills };
  return skills;
}

/**
 * The skills an agent can use. Built-in and this-computer skills come from the
 * runtime's status; the agent's own skills are read straight from its memory,
 * because the runtime only re-scans memory for skills when the agent next works.
 */
export async function listSkills(agentId: string): Promise<InstalledSkill[]> {
  const [status, memory] = await Promise.all([
    deviceStatus({ agent_id: agentId, conversation_id: "default" }).catch(() => ({}) as Record<string, unknown>),
    listMemory(agentId).catch(() => null),
  ]);
  const reported = Array.isArray(status.current_available_skills) ? (status.current_available_skills as Array<Record<string, unknown>>) : [];
  const fromRuntime: InstalledSkill[] = reported
    .map((skill) => ({
      id: String(skill.id ?? skill.name),
      name: String(skill.name ?? skill.id),
      description: String(skill.description ?? ""),
      path: String(skill.path ?? ""),
      source: (["bundled", "global", "agent", "project"].includes(String(skill.source)) ? skill.source : "global") as InstalledSkill["source"],
    }))
    .filter((skill) => skill.source !== "agent");
  const fromMemory: InstalledSkill[] = (memory?.files ?? []).flatMap((file) => {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    if (!match) return [];
    return [{ id: `agent:${match[1]}`, name: match[1]!, description: file.description ?? "", path: file.path, source: "agent" as const, needs: readSkillNeeds(file.content ?? "") }];
  });
  for (const skill of fromRuntime) {
    // This computer's skills: read their SKILL.md from disk for what they need.
    const file = skill.path.endsWith("SKILL.md") ? skill.path : join(skill.path, "SKILL.md");
    if (skill.source === "global" && existsSync(file)) skill.needs = readSkillNeeds(readFileSync(file, "utf8"));
  }
  const names = new Set(fromMemory.map((skill) => skill.name));
  return [...fromMemory, ...fromRuntime.filter((skill) => !(skill.source === "global" && names.has(skill.name)))];
}

function safeName(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  // Windows strips trailing dots and interprets device names specially. Check
  // these on every OS so a downloaded skill is safe to move between computers.
  if (!clean || clean.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) {
    throw new Error("This skill has no safe folder name.");
  }
  return clean;
}

function strictlyInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Download a skill folder from GitHub and give it to one agent or to every agent here. */
export async function installSkill(input: { source?: SkillSource; url?: string; target: SkillTarget; agentId: string }): Promise<{ name: string }> {
  const chosen = input.source ?? (input.url ? parseGitHubUrl(input.url) : null);
  if (!chosen) throw new Error("Choose a skill or paste a GitHub link.");
  // Pinned to one commit: the listing and every file come from the same version.
  const source: SkillSource = { ...chosen, ref: await commitSha(chosen) };
  const prefix = source.path ? `${source.path}/` : "";
  const files = (await tree(source)).filter(
    (entry) => entry.type === "blob" && entry.path.startsWith(prefix) && (entry.size ?? 0) <= MAX_FILE_BYTES,
  );
  const skillFile = files.find((entry) => entry.path === `${prefix}SKILL.md`);
  if (!skillFile) throw new Error("There's no SKILL.md in that folder, so it isn't a skill.");
  if (files.length > MAX_FILES) throw new Error(`That skill has ${files.length} files; Hearthside installs skills with up to ${MAX_FILES}.`);
  const front = readFrontmatter((await raw(source, skillFile.path)).toString("utf8"));
  const name = safeName(front.name ?? source.path.split("/").pop() ?? source.repo);
  if (!front.description) throw new Error("This skill's SKILL.md has no description, which the runtime requires.");

  // Every name is checked before anything is downloaded or written, for both places a skill can go.
  for (const entry of files) checkSkillFilePath(entry.path.slice(prefix.length));
  const downloaded = await Promise.all(files.map(async (entry) => ({ path: entry.path.slice(prefix.length), data: await raw(source, entry.path) })));

  if (input.target === "agent") {
    // Text files only in memory (it's a git-backed notebook, not a file store).
    for (const file of downloaded) {
      const text = file.data.toString("utf8");
      if (text.includes("\u0000")) continue;
      await writeMemoryFile(input.agentId, `skills/${name}/${file.path}`, text);
    }
  } else {
    const skillsRoot = resolve(app.getPath("userData"), "skills");
    const root = resolve(skillsRoot, name);
    if (!strictlyInside(skillsRoot, root)) throw new Error("Skill folder must stay inside the skills directory.");
    // Validate every downloaded path before removing an existing installation.
    for (const file of downloaded) {
      if (!strictlyInside(root, resolve(root, file.path))) throw new Error("A skill file is outside its folder.");
    }
    rmSync(root, { recursive: true, force: true });
    for (const file of downloaded) {
      const target = normalize(join(root, file.path));
      if (!strictlyInside(root, target)) throw new Error("A skill file is outside its folder.");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.data);
    }
    await request("skill_enable", { skill_path: root });
  }
  return { name };
}

/** The folder a listed skill lives in, which is the name the runtime linked it under. */
export function skillLinkName(skill: Pick<InstalledSkill, "name" | "path">): string {
  const folder = /(?:^|[\\/])SKILL\.md$/i.test(skill.path) ? dirname(skill.path) : skill.path;
  const name = folder.split(/[\\/]/).filter(Boolean).pop();
  return name && name !== "." && name !== ".." ? name : skill.name;
}

export async function removeSkill(input: { agentId: string; skill: InstalledSkill }): Promise<void> {
  const { skill } = input;
  if (skill.source === "agent") {
    const memory = await listMemory(input.agentId);
    const folder = `skills/${skill.name}/`;
    const paths = memory.files.map((file) => file.path).filter((path) => path.startsWith(folder));
    for (const path of paths.sort((a, b) => b.length - a.length)) await deleteMemoryFile(input.agentId, path);
  } else if (skill.source === "global") {
    // The runtime removes a skill by the name of its link, which is the name
    // of the folder it was installed in ("my-skill"), not the name its
    // SKILL.md gives it ("My Skill"). Asked for the latter, it answered
    // "Skill not found" for any skill whose two names differ.
    const link = skillLinkName(skill);
    // What the runtime lists is the link, not the folder it points at. Find
    // that folder before the link goes: Hearthside's own copy is deleted only
    // when this skill's link really led to it, never because a name matched.
    const skillsRoot = resolve(app.getPath("userData"), "skills");
    const listed = /(?:^|[\\/])SKILL\.md$/i.test(skill.path) ? dirname(skill.path) : skill.path;
    let copy: string | null = null;
    try {
      const real = realpathSync(listed);
      if (strictlyInside(realpathSync(skillsRoot), real)) copy = real;
    } catch {
      // Not on disk (or not readable): there is nothing of ours to delete.
    }
    await request("skill_disable", { name: link });
    if (copy) rmSync(copy, { recursive: true, force: true });
  } else {
    throw new Error("Built-in skills come with the runtime and can't be removed.");
  }
}

/** Which programs are installed on this computer (where the agent runs its commands). */
export async function checkPrograms(names: string[]): Promise<Record<string, boolean>> {
  const finder = process.platform === "win32" ? "where" : "which";
  const results = await Promise.all(
    names.map(
      (name) =>
        new Promise<[string, boolean]>((resolve) => {
          execFile(finder, [name], { windowsHide: true, timeout: 5_000 }, (error) => resolve([name, !error]));
        }),
    ),
  );
  return Object.fromEntries(results);
}
