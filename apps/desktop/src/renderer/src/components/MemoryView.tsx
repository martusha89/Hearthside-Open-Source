// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { relativeTime } from "../lib/format";
import { clashingPath, directoryOf, fileName, isIndexFile, newFilePath, withHeader } from "../lib/memory";
import { HistoryImportDialog } from "./HistoryImportDialog";
import MDContent from "../render/markdown";
import { useAppStore } from "../store";
import { MemoryWeb } from "./MemoryWeb";
import { BackToChat } from "./BackToChat";
import type { MemoryCommit, MemoryFile } from "../types";
import { ChevronRightIcon, HistoryIcon, PlusIcon, RefreshIcon, Spinner } from "./icons";
import { CompanionPageHeader } from "./CompanionPageHeader";

const api = window.bridge;

/** What the right-hand pane is doing with the selected file. */
type MemoryTarget = { agentId: string; epoch: number; file: MemoryFile };
type Mode =
  | { kind: "view" }
  // `original` is the whole file as loaded, header included. null while loading.
  | { kind: "edit"; target: MemoryTarget; original: string | null; draft: string }
  | { kind: "new"; path: string; description: string; draft: string }
  | {
      kind: "history";
      target: MemoryTarget;
      commits: MemoryCommit[] | null;
      /** The whole current file, to tell which version is the live one. */
      current: string;
      sha: string | null;
      content: string | null;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const COLLAPSED_KEY = "hearthside:memoryCollapsedFolders";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function FileList({
  files,
  selected,
  onSelect,
}: {
  files: MemoryFile[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const groups = useMemo(() => {
    const byDirectory = new Map<string, MemoryFile[]>();
    for (const file of files) {
      const directory = directoryOf(file.path);
      byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file]);
    }
    return [...byDirectory.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);

  // Hearthside: folders can be collapsed; remembered between visits.
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggle = (directory: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Storage unavailable: collapsing still works for this session.
      }
      return next;
    });
  };
  const selectedDirectory = selected ? directoryOf(selected) : null;

  return (
    <div className="grid gap-2">
      {groups.length > 1 && (
        <div className="flex justify-end gap-2 px-1 text-[11px] text-muted">
          <button type="button" className="hover:text-ink-800" onClick={() => setCollapsed(new Set())}>
            Expand all
          </button>
          <button
            type="button"
            className="hover:text-ink-800"
            onClick={() => setCollapsed(new Set(groups.map(([directory]) => directory).filter(Boolean)))}
          >
            Collapse all
          </button>
        </div>
      )}
      {groups.map(([directory, group]) => {
        const isOpen = !directory || !collapsed.has(directory) || directory === selectedDirectory;
        // Hearthside: a folder's MEMORY.md is its overview: the folder row opens it.
        const index = directory ? group.find((file) => file.path === `${directory}/MEMORY.md`) : undefined;
        const shown = index ? group.filter((file) => file !== index) : group;
        return (
          <div key={directory}>
            {directory && (
              <div className={`flex w-full items-center rounded-md font-mono text-[11px] ${index && selected === index.path ? "bg-ink-900/8 text-ink-900" : "text-muted"}`}>
                <button
                  type="button"
                  onClick={() => toggle(directory)}
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? "Collapse" : "Expand"} ${directory}`}
                  className="rounded-md p-1.5 hover:bg-ink-900/5 hover:text-ink-800"
                >
                  <ChevronRightIcon className={`h-3 w-3 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                </button>
                <button
                  type="button"
                  onClick={() => (index ? onSelect(index.path) : toggle(directory))}
                  title={index ? `${directory}/ overview (its MEMORY.md)` : undefined}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pr-1.5 text-left hover:bg-ink-900/5 hover:text-ink-800"
                >
                  <span className="min-w-0 flex-1 truncate">{directory}/</span>
                  <span className="shrink-0">{shown.length}</span>
                </button>
              </div>
            )}
            {isOpen && (
              <div className="flex flex-col gap-0.5">
                {shown.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => onSelect(file.path)}
                    title={file.description ?? file.path}
                    className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${directory ? "pl-6" : ""} ${selected === file.path ? "bg-ink-900/8 text-ink-900" : "text-ink-800 hover:bg-ink-900/5"}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{fileName(file.path)}</span>
                    {/* Hearthside: every folder has its own MEMORY.md; label it so it doesn't look copied. */}
                    {isIndexFile(file.path) && (
                      <span className="shrink-0 rounded bg-surface-tertiary px-1.5 py-0.5 text-[10px] text-muted" title={directory ? `What's in ${directory}/` : "What's in this memory"}>
                        overview
                      </span>
                    )}
                    {file.system && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Always in the agent's context" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function History({
  mode,
  onPick,
  onRestore,
  busy,
}: {
  mode: Extract<Mode, { kind: "history" }>;
  onPick: (sha: string) => void;
  onRestore: (content: string) => void;
  busy: boolean;
}) {
  if (!mode.commits) {
    return (
      <div className="flex justify-center py-10">
        <Spinner className="h-5 w-5 text-muted" />
      </div>
    );
  }
  if (mode.commits.length === 0) {
    return <p className="py-6 text-sm text-muted">This file has no saved history yet.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <div className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto">
        {mode.commits.map((commit) => (
          <button
            key={commit.sha}
            type="button"
            onClick={() => onPick(commit.sha)}
            className={`rounded-lg px-2.5 py-1.5 text-left transition-colors ${mode.sha === commit.sha ? "bg-ink-900/8" : "hover:bg-ink-900/5"}`}
          >
            <span className="block truncate text-sm text-ink-900">{commit.message}</span>
            <span className="block truncate text-xs text-muted">
              {relativeTime(commit.timestamp)}
              {commit.author ? ` by ${commit.author}` : ""}
            </span>
          </button>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {mode.sha === null ? (
          <p className="py-6 text-sm text-muted">Choose a version to see the file at that point.</p>
        ) : mode.content === null ? (
          <div className="flex justify-center py-10">
            <Spinner className="h-5 w-5 text-muted" />
          </div>
        ) : (
          <>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-tertiary p-3 font-mono text-xs text-ink-800">
              {mode.content || "(empty)"}
            </pre>
            <div>
              <button
                type="button"
                className="button-secondary"
                disabled={busy || mode.content === mode.current}
                onClick={() => onRestore(mode.content ?? "")}
              >
                {mode.content === mode.current ? "This is the current version" : "Restore this version"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const WIDTH_KEY = "hearthside:memoryFilesWidth";
const clampWidth = (width: number) => Math.round(Math.min(640, Math.max(180, width)));

function loadWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return stored ? clampWidth(stored) : 260;
  } catch {
    return 260;
  }
}

function saveWidth(width: number): number {
  const clamped = clampWidth(width);
  try {
    localStorage.setItem(WIDTH_KEY, String(clamped));
  } catch {
    // Storage unavailable: the width still applies for this session.
  }
  return clamped;
}

export function MemoryView() {
  const agent = useAppStore((state) => state.agents.find((item) => item.id === state.agentId));
  const [importOpen, setImportOpen] = useState(false);
  const memory = useAppStore((state) => state.memory);
  const epoch = useAppStore((state) => state.backendEpoch);
  const loadMemory = useAppStore((state) => state.loadMemory);
  const saveMemoryFile = useAppStore((state) => state.saveMemoryFile);
  const deleteMemoryFile = useAppStore((state) => state.deleteMemoryFile);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState(loadWidth);
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = listWidth;
    const onMove = (move: PointerEvent) => setListWidth(clampWidth(startWidth + move.clientX - startX));
    const onUp = (up: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      saveWidth(startWidth + up.clientX - startX);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  // Hearthside: the memory web is the default view; Files is the editor.
  const [tab, setTab] = useState<"web" | "files">("web");
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The navigation waiting on the user's answer to "discard your changes?".
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  // Hearthside: keep the file list current when the agent (or a dream) changes memory.
  useEffect(() => window.bridge.onEvent((event) => {
    if (event.type === "memory.updated") void loadMemory();
  }), [loadMemory]);

  const files = memory?.files ?? [];
  const target = mode.kind === "edit" || mode.kind === "history" ? mode.target : null;
  // An edit/history session owns its original file, never the current fallback.
  const file = target?.file ?? (
    files.find((item) => item.path === selectedPath) ??
    files.find((item) => item.path === "MEMORY.md") ?? files[0]);
  const agentId = agent?.id;
  const targetMissing = target && (target.agentId !== agentId || target.epoch !== epoch ||
    !files.some((item) => item.path === target.file.path));
  const targetError = targetMissing ? "The original memory file is no longer available. Your edit has not been saved." : null;

  const hasUnsavedEdit =
    (mode.kind === "edit" && mode.original !== null && mode.draft !== mode.original) ||
    (mode.kind === "new" &&
      (mode.draft.length > 0 || mode.path.length > 0 || mode.description.length > 0));

  const leaveNow = (next: () => void) => {
    setPendingLeave(null);
    setError(null);
    setConfirmingDelete(false);
    next();
  };

  /** Run a navigation, asking first if it would throw away an edit. */
  const leave = (next: () => void) => {
    if (hasUnsavedEdit) setPendingLeave(() => next);
    else leaveNow(next);
  };

  // The file list carries each file's body only. Editing and history work on
  // the whole file, so it is loaded when either one opens.
  const loading =
    (mode.kind === "edit" && mode.original === null) ||
    (mode.kind === "history" && mode.commits === null);
  const loadingKind = loading ? mode.kind : null;
  const loadingPath = loading ? file?.path : undefined;
  useEffect(() => {
    if (!agentId || !loadingPath || !loadingKind || !target || targetMissing) return;
    let cancelled = false;
    const load =
      loadingKind === "edit"
        ? api.readMemoryFile(agentId, loadingPath).then((original): Mode => ({
            kind: "edit",
            target,
            original,
            draft: original,
          }))
        : Promise.all([
            api.listMemoryHistory(agentId, loadingPath),
            api.readMemoryFile(agentId, loadingPath),
          ]).then(([commits, current]): Mode => ({
            kind: "history",
            target,
            commits,
            current,
            sha: null,
            content: null,
          }));
    load
      .then((next) => {
        if (!cancelled) setMode(next);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(errorMessage(failure));
        setMode({ kind: "view" });
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, loadingKind, loadingPath, target, targetMissing]);

  const pickVersion = (sha: string) => {
    if (!agentId || !file || mode.kind !== "history" || targetMissing) return;
    setMode({ ...mode, sha, content: null });
    api
      .readMemoryFileAt(agentId, file.path, sha)
      .then((content) =>
        setMode((current) =>
          current.kind === "history" && current.target === mode.target && current.sha === sha ? { ...current, content } : current,
        ),
      )
      .catch((failure: unknown) => setError(errorMessage(failure)));
  };

  const run = async (action: () => Promise<void>, after: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      after();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (mode.kind === "edit" && file) {
      void run(
        // With the text the editor loaded, so a file changed underneath is not overwritten.
        () => saveMemoryFile(mode.target.file.path, mode.draft, mode.original === null ? mode.target : { ...mode.target, original: mode.original }),
        () => setMode({ kind: "view" }),
      );
    } else if (mode.kind === "new") {
      const path = newFilePath(mode.path);
      const clash = clashingPath(files.map((item) => item.path), path);
      if (clash) {
        setError(clash === path ? `${path} already exists.` : `${clash} already exists, and on this computer ${path} would be the same file. Choose another name.`);
        return;
      }
      void run(
        () => saveMemoryFile(path, withHeader(path, mode.description, mode.draft)),
        () => {
          setSelectedPath(path);
          setMode({ kind: "view" });
        },
      );
    }
  };

  const editing = mode.kind === "edit" || mode.kind === "new";

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface">
      <CompanionPageHeader
        title="Memory world"
        leading={<BackToChat onNavigate={leave} />}
        trailing={<div role="tablist" aria-label="Memory view" className="flex gap-1 rounded-xl bg-surface-tertiary p-1">
          {(["web", "files"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              onClick={() => leave(() => setTab(item))}
              className={`rounded-lg px-3 py-1 text-xs transition-colors ${tab === item ? "bg-surface font-medium text-ink-900 shadow-soft" : "text-ink-600 hover:text-ink-900"}`}
            >
              {item === "web" ? "World" : "Files"}
            </button>
          ))}
        </div>}
      />

      {tab === "web" && agentId ? (
        <MemoryWeb
          agentId={agentId}
          files={files}
          loading={!memory || memory.loading}
          error={memory?.error}
          onOpenFile={(path) => {
            setSelectedPath(path);
            setMode({ kind: "view" });
            setTab("files");
          }}
        />
      ) : (
      <div className="flex min-h-0 flex-1">
        <div className="relative flex shrink-0 flex-col border-r border-border" style={{ width: listWidth }}>
          {/* Hearthside: drag the edge to make the file list wider or narrower. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file list"
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") setListWidth((width) => saveWidth(width - 20));
              if (event.key === "ArrowRight") setListWidth((width) => saveWidth(width + 20));
            }}
            className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-accent/30 focus-visible:bg-accent/30"
          />
          <div className="flex items-center gap-1 px-2.5 py-2.5">
            <button
              type="button"
              className="button-secondary flex-1"
              disabled={!memory?.enabled}
              onClick={() =>
                leave(() => setMode({ kind: "new", path: "", description: "", draft: "" }))
              }
            >
              <PlusIcon className="h-3.5 w-3.5" />
              New file
            </button>
            <button
              type="button"
              aria-label="Refresh"
              title="Refresh"
              onClick={() => void loadMemory()}
              className="rounded-lg p-2 text-muted hover:bg-ink-900/8 hover:text-ink-800 transition-colors"
            >
              {memory?.loading ? <Spinner className="h-4 w-4" /> : <RefreshIcon className="h-4 w-4" />}
            </button>
          </div>
          {/* Hearthside: past ChatGPT/Claude conversations, into history/. */}
          <button
            type="button"
            disabled={!memory?.enabled || !agent}
            onClick={() => setImportOpen(true)}
            className="mx-2.5 mb-2 rounded-lg px-2 py-1 text-left text-xs text-accent hover:bg-accent-subtle disabled:opacity-50"
          >
            Import past conversations…
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
            <FileList
              files={files}
              selected={mode.kind === "new" ? null : (file?.path ?? null)}
              onSelect={(path) =>
                leave(() => {
                  setSelectedPath(path);
                  setMode({ kind: "view" });
                })
              }
            />
          </div>
          {files.some((item) => item.system) && (
            <p className="flex items-center gap-2 border-t border-border px-3.5 py-2.5 text-xs text-muted">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              Always in the companion's context
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {memory?.error ? (
            <div className="p-6 text-sm text-error" role="alert">
              {memory.error}
            </div>
          ) : !memory || (memory.loading && files.length === 0) ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="h-5 w-5 text-muted" />
            </div>
          ) : !memory.enabled ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <h2 className="text-lg font-semibold text-ink-900">No memory files</h2>
              <p className="mt-2 max-w-sm text-sm text-muted">
                This companion does not use file-based memory, so there is nothing to show here.
              </p>
            </div>
          ) : mode.kind === "new" ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-ink-700">File path</span>
                <input
                  autoFocus
                  value={mode.path}
                  onChange={(event) => setMode({ ...mode, path: event.target.value })}
                  placeholder="project-notes.md"
                  spellCheck={false}
                  className="field font-mono"
                />
                <span className="text-xs text-muted">
                  A file in a new folder needs that folder to have its own MEMORY.md index.
                </span>
              </label>
              {!isIndexFile(newFilePath(mode.path)) && (
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-ink-700">Description (required)</span>
                  <input
                    value={mode.description}
                    onChange={(event) => setMode({ ...mode, description: event.target.value })}
                    placeholder="One line that tells the companion when to read this file"
                    className="field"
                  />
                </label>
              )}
              <textarea
                value={mode.draft}
                onChange={(event) => setMode({ ...mode, draft: event.target.value })}
                placeholder="What should the companion remember?"
                spellCheck={false}
                className="field min-h-0 flex-1 resize-none font-mono text-[13px] leading-relaxed"
              />
            </div>
          ) : !file ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <h2 className="text-lg font-semibold text-ink-900">Nothing remembered yet</h2>
              <p className="mt-2 max-w-sm text-sm text-muted">
                The companion writes memory files as they work. You can also add one yourself.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm text-ink-900">{file.path}</div>
                  {file.description && (
                    <div className="truncate text-xs text-muted">{file.description}</div>
                  )}
                </div>
                {mode.kind === "view" && file.kind === "markdown" && (
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => agentId && setMode({ kind: "edit", target: { agentId, epoch, file }, original: null, draft: "" })}
                  >
                    Edit
                  </button>
                )}
                {mode.kind !== "edit" && (
                  <button
                    type="button"
                    className="button-secondary"
                    aria-pressed={mode.kind === "history"}
                    onClick={() =>
                      setMode(
                        mode.kind === "history"
                          ? { kind: "view" }
                          : { kind: "history", target: { agentId: agentId!, epoch, file }, commits: null, current: "", sha: null, content: null },
                      )
                    }
                  >
                    <HistoryIcon className="h-3.5 w-3.5" />
                    {mode.kind === "history" ? "Close history" : "History"}
                  </button>
                )}
                {mode.kind === "view" &&
                  (confirmingDelete ? (
                    <>
                      <button
                        type="button"
                        className="button-secondary text-error"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => deleteMemoryFile(file.path),
                            () => {
                              setSelectedPath(null);
                              setConfirmingDelete(false);
                            },
                          )
                        }
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => setConfirmingDelete(false)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => setConfirmingDelete(true)}
                    >
                      Delete
                    </button>
                  ))}
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
                {mode.kind === "edit" && mode.original === null ? (
                  <div className="flex justify-center py-10">
                    <Spinner className="h-5 w-5 text-muted" />
                  </div>
                ) : mode.kind === "edit" ? (
                  <textarea
                    autoFocus
                    value={mode.draft}
                    onChange={(event) => setMode({ ...mode, draft: event.target.value })}
                    spellCheck={false}
                    className="field min-h-0 flex-1 resize-none font-mono text-[13px] leading-relaxed"
                  />
                ) : mode.kind === "history" ? (
                  <History
                    mode={mode}
                    busy={busy}
                    onPick={pickVersion}
                    onRestore={(content) =>
                      void run(
                        () => saveMemoryFile(mode.target.file.path, content, mode.target),
                        () => setMode({ kind: "view" }),
                      )
                    }
                  />
                ) : file.kind === "image" ? (
                  <p className="text-sm text-muted">This is an image file. It cannot be shown here.</p>
                ) : (
                  <div className="mx-auto w-full max-w-3xl">
                    {file.content.trim() ? (
                      <MDContent text={file.content} />
                    ) : (
                      <p className="text-sm text-muted">This file is empty.</p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {(editing || error || targetError) && (
            <div className="flex items-center gap-3 border-t border-border px-5 py-3">
              <p className="min-w-0 flex-1 break-words text-xs text-error" role="alert">
                {error ?? targetError}
              </p>
              {editing && (
                <>
                  {/* Hearthside: say why Save is greyed out. */}
                  {mode.kind === "new" && (!mode.path.trim() || (!isIndexFile(newFilePath(mode.path)) && !mode.description.trim())) && (
                    <span className="text-xs text-muted">
                      {!mode.path.trim() ? "Give the file a name." : "Add a description: Letta needs one line saying when to read this file."}
                    </span>
                  )}
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={busy}
                    onClick={() => leave(() => setMode({ kind: "view" }))}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="button-primary"
                    disabled={
                      busy || Boolean(targetMissing) ||
                      (mode.kind === "new" &&
                        (!mode.path.trim() ||
                          (!isIndexFile(newFilePath(mode.path)) && !mode.description.trim()))) ||
                      (mode.kind === "edit" && (mode.original === null || mode.draft === mode.original))
                    }
                    onClick={save}
                  >
                    {busy && <Spinner className="h-3.5 w-3.5" />}
                    Save
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      )}

      {agent && <HistoryImportDialog agentId={agent.id} agentName={agent.name} open={importOpen} onOpenChange={setImportOpen} />}
      <Dialog.Root open={pendingLeave !== null} onOpenChange={(open) => !open && setPendingLeave(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface p-5 shadow-elevated focus:outline-none"
          >
            <Dialog.Title className="text-base font-semibold text-ink-900">
              Discard your changes?
            </Dialog.Title>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="button-secondary" onClick={() => setPendingLeave(null)}>
                Keep editing
              </button>
              <button
                type="button"
                className="button-primary"
                onClick={() => pendingLeave && leaveNow(pendingLeave)}
              >
                Discard
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
