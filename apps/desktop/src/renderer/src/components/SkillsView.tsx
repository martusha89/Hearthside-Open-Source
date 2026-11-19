import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store";
import MDContent from "../render/markdown";
import type { CatalogSkill, InstalledSkill, SkillNeeds, SkillTarget } from "../types";
import { ChevronRightIcon, Spinner } from "./icons";
import { BackToChat } from "./BackToChat";
import { CompanionPageHeader } from "./CompanionPageHeader";

/**
 * Hearthside: the agent's skills. Skills teach an agent how to do something
 * (use Spotify, read PDFs, set its avatar…). Add them from Letta's collection
 * or from any GitHub folder with a SKILL.md, for this agent or for every agent
 * on this computer.
 */

const SOURCE_LABEL: Record<InstalledSkill["source"], string> = {
  agent: "This agent",
  global: "All agents on this computer",
  bundled: "Built in",
  project: "From the working folder",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hearthside: what a skill needs (programs on this computer, API keys) and its own setup steps. */
function Needs({ needs, installed }: { needs?: SkillNeeds; installed: Record<string, boolean> }) {
  if (!needs || (needs.programs.length === 0 && needs.secrets.length === 0 && !needs.setup)) return null;
  return (
    <div className="mt-1.5 grid gap-1 text-[11px]">
      {(needs.programs.length > 0 || needs.secrets.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 text-muted">
          <span>Needs:</span>
          {needs.programs.map((program) => (
            <span
              key={program}
              className={`rounded-md px-1.5 py-0.5 font-mono ${installed[program] ? "bg-success/10 text-success" : "bg-warning/10 text-ink-700"}`}
              title={installed[program] ? "Installed on this computer" : "Not found on this computer. See How to set it up."}
            >
              {program} {installed[program] === undefined ? "" : installed[program] ? "✓" : "· not installed"}
            </span>
          ))}
          {needs.secrets.map((secret) => (
            <span key={secret} className="rounded-md bg-surface-tertiary px-1.5 py-0.5 font-mono text-ink-700" title="Add it in Agent settings → Secrets">
              {secret}
            </span>
          ))}
        </div>
      )}
      {needs.setup && (
        <details>
          <summary className="cursor-pointer text-accent hover:underline">How to set it up</summary>
          <div className="mt-1 rounded-lg bg-surface-tertiary px-3 py-2 text-xs text-ink-800">
            <MDContent text={needs.setup} />
          </div>
        </details>
      )}
    </div>
  );
}

function SkillIcon({ icon, name }: { icon: string | null; name: string }) {
  return icon ? (
    <img src={icon} alt="" className="h-9 w-9 shrink-0 rounded-lg object-contain" />
  ) : (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-tertiary text-sm font-semibold uppercase text-muted">{name.slice(0, 1)}</span>
  );
}

/** A skill in one line; click to see what it does and what it needs. */
function SkillRow({
  icon,
  name,
  description,
  meta,
  needs,
  programs,
  action,
}: {
  icon: string | null;
  name: string;
  description: string;
  meta?: string;
  needs?: SkillNeeds;
  programs: Record<string, boolean>;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const missing = (needs?.programs ?? []).some((program) => programs[program] === false);
  return (
    <div className="min-w-0 rounded-xl border border-border px-3 py-2" data-testid="skill-row">
      <div className="flex min-w-0 items-center gap-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={open} aria-label={`${name} details`} onClick={() => setOpen(!open)}>
          <SkillIcon icon={icon} name={name} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-ink-900">{name}</span>
              {missing && <span className="shrink-0 rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] text-ink-700">needs setup</span>}
            </span>
            {!open && <span className="block truncate text-xs text-muted">{description}</span>}
          </span>
          <ChevronRightIcon className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        {action}
      </div>
      {open && (
        <div className="mt-1.5 grid gap-1 pl-12">
          <p className="text-xs text-muted">{description}</p>
          {meta && <p className="text-[11px] text-muted-light">{meta}</p>}
          <Needs needs={needs} installed={programs} />
        </div>
      )}
    </div>
  );
}

/** Hearthside: a section that folds, remembering whether it was left open. */
function useFold(key: string, initial: boolean): [boolean, () => void] {
  const storageKey = `hearthside.skills.${key}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved === null ? initial : saved === "open";
    } catch {
      return initial;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(storageKey, open ? "closed" : "open");
    } catch {
      // Not remembered; fine.
    }
  };
  return [open, toggle];
}

function FoldHeader({ title, count, open, onToggle, as: Heading = "h2" }: { title: string; count: number | null; open: boolean; onToggle: () => void; as?: "h2" | "span" }) {
  return (
    <button type="button" className="flex items-center justify-between gap-2 text-left" aria-expanded={open} onClick={onToggle}>
      <Heading className={Heading === "h2" ? "text-sm font-semibold text-ink-900" : "text-xs font-medium text-ink-700"}>
        {title}
        {count !== null && <span className="ml-1.5 font-normal text-muted">{count}</span>}
      </Heading>
      <ChevronRightIcon className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

function TargetChoice({ value, onChange, local }: { value: SkillTarget; onChange: (target: SkillTarget) => void; local: boolean }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-ink-700">
      <label className="flex cursor-pointer items-center gap-1.5">
        <input type="radio" className="accent-[var(--color-accent)]" checked={value === "agent"} onChange={() => onChange("agent")} />
        For this agent (kept in its memory)
      </label>
      {local && (
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="radio" className="accent-[var(--color-accent)]" checked={value === "computer"} onChange={() => onChange("computer")} />
          For all agents on this computer
        </label>
      )}
    </div>
  );
}

export function SkillsView() {
  const agentId = useAppStore((state) => state.agentId);
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === state.agentId)?.name ?? "Your agent");
  const local = useAppStore((state) => state.connection?.status === "ready" && state.connection.backend === "local");
  const [installed, setInstalled] = useState<InstalledSkill[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogSkill[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [target, setTarget] = useState<SkillTarget>("agent");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [idea, setIdea] = useState("");
  const [programs, setPrograms] = useState<Record<string, boolean>>({});
  const conversations = useAppStore((state) => state.conversations);
  const openChat = useAppStore((state) => state.openChat);
  const setDraft = useAppStore((state) => state.setDraft);
  const send = useAppStore((state) => state.send);

  /** Hearthside: the agent writes a skill into its own memory, in the main chat. */
  const askAgent = async () => {
    const main = conversations.find((conversation) => conversation.main);
    if (!main || !idea.trim()) return;
    openChat(main.id);
    const message = [
      "Please create a new skill for yourself.",
      `What it should help with: ${idea.trim()}`,
      "Put it in your memory as skills/<short-name>/SKILL.md, starting with frontmatter that has a name and a one-line description of when to use it, then clear step-by-step instructions. Add helper files next to it only if they're really needed.",
      "If the skill needs a script or a program, say which. If you write a script, run it once to check it works, and if you can't test it, tell me plainly rather than guessing.",
      "Tell me briefly what you made.",
    ].join("\n\n");
    setDraft(message);
    setIdea("");
    await send(message);
  };

  const refresh = useCallback(async () => {
    if (!agentId) return;
    try {
      setInstalled(await window.bridge.listSkills(agentId));
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
    window.bridge
      .listSkillCatalog()
      .then(setCatalog)
      .catch((failure: unknown) => setCatalogError(errorText(failure)));
  }, [refresh]);

  const install = async (key: string, input: { source?: CatalogSkill["source"]; url?: string }) => {
    if (!agentId) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const { name } = await window.bridge.installSkill({ ...input, target, agentId });
      setNotice(`Added "${name}" ${target === "agent" ? `for ${agentName}` : "for all agents on this computer"}.`);
      if (input.url) setUrl("");
      await refresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (skill: InstalledSkill) => {
    if (!agentId) return;
    setBusy(skill.id);
    setError(null);
    setNotice(null);
    try {
      await window.bridge.removeSkill({ agentId, skill });
      setNotice(`Removed "${skill.name}".`);
      await refresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  // Check once which programs the listed skills need are installed here.
  useEffect(() => {
    const names = [...new Set([...(catalog ?? []), ...(installed ?? [])].flatMap((skill) => skill.needs?.programs ?? []))].filter((name) => !(name in programs));
    if (names.length === 0) return;
    void window.bridge.checkPrograms(names.slice(0, 20)).then((found) => setPrograms((current) => ({ ...current, ...found }))).catch(() => undefined);
  }, [catalog, installed]); // eslint-disable-line react-hooks/exhaustive-deps

  const installedNames = useMemo(() => new Set((installed ?? []).map((skill) => skill.name)), [installed]);
  const visibleCatalog = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (catalog ?? []).filter((skill) => terms.every((term) => `${skill.name} ${skill.description}`.toLowerCase().includes(term)));
  }, [catalog, query]);
  const yours = (installed ?? []).filter((skill) => skill.source !== "bundled");
  const builtIn = (installed ?? []).filter((skill) => skill.source === "bundled");
  const [addedOpen, toggleAdded] = useFold("added", true);
  const [collectionOpen, toggleCollection] = useFold("collection", false);
  // Searching shows the results even when the collection is folded.
  const collectionShown = collectionOpen || query.trim().length > 0;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface">
      <CompanionPageHeader title="Skills" leading={<BackToChat />} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-6 px-6 py-6">
          <p className="text-sm text-muted">
            Skills teach {agentName} how to do things, like reading PDFs, using Spotify or keeping an avatar. They're loaded only when
            needed, so adding one doesn't fill up the context.
          </p>
          {(error || notice) && (
            <p role={error ? "alert" : "status"} className={`rounded-xl px-3.5 py-2.5 text-sm ${error ? "bg-error-light text-error" : "bg-accent-subtle text-ink-800"}`}>
              {error ?? notice}
            </p>
          )}

          <section className="grid gap-2">
            <FoldHeader title="Added skills" count={installed ? yours.length : null} open={addedOpen} onToggle={toggleAdded} />
            {!installed && <Spinner className="h-4 w-4 text-muted" />}
            {addedOpen && installed && yours.length === 0 && <p className="text-sm text-muted">None yet. Add one below.</p>}
            {addedOpen && yours.map((skill) => (
              <SkillRow
                key={skill.id}
                icon={null}
                name={skill.name}
                description={skill.description}
                meta={SOURCE_LABEL[skill.source]}
                needs={skill.needs}
                programs={programs}
                action={
                  (skill.source === "agent" || skill.source === "global") && (
                    <button type="button" className="button-secondary shrink-0" disabled={busy !== null} onClick={() => void remove(skill)}>
                      {busy === skill.id && <Spinner className="h-3.5 w-3.5" />}
                      Remove
                    </button>
                  )
                }
              />
            ))}
            {addedOpen && builtIn.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs text-muted hover:text-ink-700">{builtIn.length} built-in skills</summary>
                <ul className="mt-2 grid gap-1 pl-3">
                  {builtIn.map((skill) => (
                    <li key={skill.id} className="text-xs text-ink-700">
                      <span className="font-medium">{skill.name}</span> <span className="text-muted">{skill.description}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="grid gap-3">
            <h2 className="text-sm font-semibold text-ink-900">Add a skill</h2>
            <TargetChoice value={target} onChange={setTarget} local={local} />
            <div className="grid gap-1.5">
              <label htmlFor="skill-url" className="text-xs font-medium text-ink-700">
                From a GitHub link
              </label>
              <div className="flex gap-2">
                <input
                  id="skill-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://github.com/owner/repo/tree/main/path-to-skill"
                  className="field min-w-0 flex-1 font-mono text-xs"
                />
                <button type="button" className="button-primary shrink-0" disabled={!url.trim() || busy !== null} onClick={() => void install("url", { url })}>
                  {busy === "url" && <Spinner className="h-3.5 w-3.5" />}
                  Add
                </button>
              </div>
              <p className="text-[11px] text-muted">A folder with a SKILL.md. Only add skills from people you trust: a skill can run commands.</p>
            </div>

            <div className="grid gap-1.5">
              <label htmlFor="skill-idea" className="text-xs font-medium text-ink-700">
                Ask {agentName} to make one
              </label>
              <div className="flex gap-2">
                <input
                  id="skill-idea"
                  value={idea}
                  onChange={(event) => setIdea(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && void askAgent()}
                  placeholder="For example: how to plan my week with me on Sunday evenings"
                  className="field min-w-0 flex-1 text-sm"
                />
                <button type="button" className="button-secondary shrink-0" disabled={!idea.trim()} onClick={() => void askAgent()}>
                  Ask
                </button>
              </div>
              <p className="text-[11px] text-muted">{agentName} writes it into its memory in the main chat. You'll see it here afterwards.</p>
            </div>

            <div className="grid gap-2">
              <FoldHeader title="Letta's collection" count={catalog ? catalog.length : null} open={collectionShown} onToggle={toggleCollection} as="span" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" className="field text-sm" />
              {collectionShown && !catalog && !catalogError && <Spinner className="h-4 w-4 text-muted" />}
              {catalogError && <p className="text-xs text-error">{catalogError}</p>}
              {collectionShown && (
                <a className="text-[11px] text-muted hover:underline" href="https://github.com/letta-ai/skills" target="_blank" rel="noreferrer">
                  From github.com/letta-ai/skills (MIT)
                </a>
              )}
              {collectionShown && (
              <div className="grid gap-1.5">
                {visibleCatalog.map((skill) => {
                  const key = `${skill.source.repo}/${skill.source.path}`;
                  const added = installedNames.has(skill.name);
                  return (
                    <SkillRow
                      key={key}
                      icon={skill.icon}
                      name={skill.name}
                      description={skill.description}
                      needs={skill.needs}
                      programs={programs}
                      action={
                        <button
                          type="button"
                          className="button-secondary shrink-0"
                          disabled={added || busy !== null}
                          onClick={() => void install(key, { source: skill.source })}
                        >
                          {busy === key && <Spinner className="h-3.5 w-3.5" />}
                          {added ? "Added" : "Add"}
                        </button>
                      }
                    />
                  );
                })}
                {query.trim() && catalog && visibleCatalog.length === 0 && <p className="text-sm text-muted">No skills match "{query.trim()}".</p>}
              </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
