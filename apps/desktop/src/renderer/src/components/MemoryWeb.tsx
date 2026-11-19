// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { type DiffFile, parseUnifiedDiff } from "../lib/diff";
import { relativeTime } from "../lib/format";
import { buildHeatmap, localDateKey } from "../lib/heatmap";
import { buildMemoryGraph, kindOf } from "../lib/memory-graph";
import { contextLabel, isSkill } from "../lib/memory-cosmos-layout";
import type { MemoryGraph as Graph } from "../lib/memory-graph";
import type { MemoryCommit, MemoryFile } from "../types";
import { MemoryGraph, MemoryLoading } from "./MemoryGraph";
import { afterMemoryPaint } from "../lib/after-memory-paint";
import { memoryWebCoverage } from "../lib/memory-loading-state";
import { Spinner } from "./icons";
import Markdown from "../render/markdown";
import "./memory-web.css";

function memoryTitle(file: MemoryFile): string {
  const heading = file.content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || (file.path.split("/").pop() ?? file.path)
    .replace(/\.md$/i, "").replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function MemorySkillBadge({ file }: { file: Pick<MemoryFile, "path" | "system"> }) {
  return isSkill({ id: file.path, kind: kindOf(file) }) ? <div className="memory-eyebrow">Skill</div> : null;
}

/** Subscribe before fetching; only the newest live request may update provenance. */
export function watchLatestMemoryChange(
  load: () => Promise<MemoryCommit[]>,
  subscribe: (refresh: () => void) => () => void,
  onChange: (commit: MemoryCommit | null) => void,
): () => void {
  let cancelled = false;
  let latestRequest = 0;
  const refresh = () => {
    if (cancelled) return;
    const request = ++latestRequest;
    onChange(null);
    void load().then((history) => {
      if (!cancelled && request === latestRequest) onChange([...history].sort((a, b) => b.timestamp - a.timestamp)[0] ?? null);
    }).catch(() => {
      if (!cancelled && request === latestRequest) onChange(null);
    });
  };
  const unsubscribe = subscribe(refresh);
  refresh();
  return () => { cancelled = true; unsubscribe(); };
}

type MemoryNavigation = { selected: string | null; category: string | null };
type MemoryNavigationAction = { type: "select"; path: string | null } | { type: "category"; category: string | null } | { type: "reset" };
export function memoryNavigation(state: MemoryNavigation, action: MemoryNavigationAction): MemoryNavigation {
  if (action.type === "reset") return { selected: null, category: null };
  if (action.type === "category") return { selected: action.category === null ? state.selected : null, category: action.category };
  return { selected: action.path, category: action.path === null ? state.category : null };
}

/** Category membership comes only from the same real-file graph used by the scene. */
export function MemoryCategoryBreakdown({ graph, category, onSelect }: {
  graph: Graph; category: string; onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const listId = useId();
  const members = graph.nodes.filter(node => node.group === category);
  const matches = members.filter(node => `${node.title ?? node.label} ${node.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const lastPage = Math.max(0, Math.ceil(matches.length / 40) - 1);
  const currentPage = Math.min(page, lastPage);
  return <section className="memory-category-scroll" aria-label="Category memories">
    <p className="memory-eyebrow">Memory category</p>
    <h2 className="memory-activity-title">{category || "Other memory"}</h2>
    <p className="memory-activity-summary">{members.length} real memory {members.length === 1 ? "file" : "files"}</p>
    <button type="button" className="memory-category-expand" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}>{expanded ? "Hide memories" : "Show memories"} ({members.length})</button>
    {expanded && <div id={listId}>
      <input className="memory-category-search" aria-label="Search category memories" placeholder="Find a title or path…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
      <p className="memory-category-count" aria-live="polite">{matches.length} matching files</p>
      <div className="memory-category-files">
        {matches.slice(currentPage * 40, (currentPage + 1) * 40).map(node => <button type="button" key={node.id} onClick={() => onSelect(node.id)}>
          <strong>{node.title || node.label}</strong><span>{node.id}</span><small>{contextLabel(node)}</small>
        </button>)}
        {matches.length === 0 && <p>No matching memories.</p>}
      </div>
      {lastPage > 0 && <nav className="memory-category-pages" aria-label="Category memory pages">
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous memories</button>
        <span>Page {currentPage + 1} of {lastPage + 1}</span>
        <button type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next memories</button>
      </nav>}
    </div>}
  </section>;
}

const ACTIVITY_LIMIT = 1000;
const HEATMAP_WEEKS = 26;
const LEVEL_FILL = [
  "var(--color-bg-300)",
  "color-mix(in srgb, var(--color-accent) 30%, var(--color-bg-300))",
  "color-mix(in srgb, var(--color-accent) 55%, var(--color-bg-300))",
  "color-mix(in srgb, var(--color-accent) 80%, var(--color-bg-300))",
  "var(--color-accent)",
];

/** "5m ago", "just now", or a date for older changes. */
function ago(timestamp: number, now: number): string {
  const relative = relativeTime(timestamp, now);
  if (relative === "now") return "just now";
  return /^\d+[mhd]$/.test(relative) ? `${relative} ago` : relative;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Heatmap({
  commits,
  day,
  onDay,
}: {
  commits: MemoryCommit[];
  day: string | null;
  onDay: (day: string | null) => void;
}) {
  const map = useMemo(() => buildHeatmap(commits.map((commit) => commit.timestamp), new Date(), HEATMAP_WEEKS), [commits]);
  const cell = 11;
  const gap = 3;
  const left = 26;
  const top = 14;
  return (
    <div>
      {/* Scales to the panel width so the current week is never cut off. */}
      <svg
        viewBox={`0 0 ${left + HEATMAP_WEEKS * (cell + gap)} ${top + 7 * (cell + gap)}`}
        className="block h-auto w-full"
        role="grid"
        aria-label="Memory changes per day"
      >
        {map.months.map((month) => (
          <text key={`${month.week}-${month.label}`} x={left + month.week * (cell + gap)} y={9} fontSize={9} fill="var(--color-muted)">
            {month.label}
          </text>
        ))}
        {["Mon", "Wed", "Fri"].map((label, index) => (
          <text key={label} x={0} y={top + (index * 2) * (cell + gap) + cell - 2} fontSize={9} fill="var(--color-muted)">
            {label}
          </text>
        ))}
        {map.weeks.map((week, w) =>
          week.map((entry, d) =>
            entry.inRange ? (
              <rect
                key={entry.date}
                role={entry.count > 0 ? "button" : "gridcell"}
                tabIndex={entry.count > 0 ? 0 : undefined}
                aria-pressed={entry.count > 0 ? day === entry.date : undefined}
                onKeyDown={(event) => {
                  if (entry.count > 0 && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    onDay(day === entry.date ? null : entry.date);
                  }
                }}
                aria-label={`${entry.date}: ${entry.count} change${entry.count === 1 ? "" : "s"}`}
                x={left + w * (cell + gap)}
                y={top + d * (cell + gap)}
                width={cell}
                height={cell}
                rx={2.5}
                fill={LEVEL_FILL[entry.level]}
                stroke={day === entry.date ? "var(--color-ink-900)" : "none"}
                strokeWidth={1.5}
                className={entry.count > 0 ? "cursor-pointer" : undefined}
                onClick={() => entry.count > 0 && onDay(day === entry.date ? null : entry.date)}
              >
                <title>{`${entry.date}: ${entry.count} change${entry.count === 1 ? "" : "s"}`}</title>
              </rect>
            ) : null,
          ),
        )}
      </svg>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
        <span>
          {map.total} change{map.total === 1 ? "" : "s"} in the last 6 months
        </span>
        <span className="flex items-center gap-1">
          Less
          {LEVEL_FILL.map((fill) => (
            <span key={fill} className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: fill }} />
          ))}
          More
        </span>
      </div>
    </div>
  );
}

function DiffView({ files }: { files: DiffFile[] }) {
  if (files.length === 0) return <p className="text-xs text-muted">No file changes in this commit.</p>;
  return (
    <div className="grid gap-3">
      {files.map((file) => (
        <div key={file.path} className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between gap-2 bg-surface-tertiary px-2.5 py-1.5">
            <span className="truncate font-mono text-[11px] text-ink-800">{file.path}</span>
            <span className="shrink-0 font-mono text-[11px]">
              <span className="text-success">+{file.added}</span> <span className="text-error">−{file.removed}</span>
            </span>
          </div>
          <pre className="max-h-80 overflow-auto text-[11px] leading-relaxed">
            {file.lines.map((line, index) => (
              <div
                key={index}
                className={
                  line.kind === "add"
                    ? "bg-success-light px-2.5 text-ink-900"
                    : line.kind === "del"
                      ? "bg-error-light px-2.5 text-ink-800"
                      : line.kind === "hunk"
                        ? "px-2.5 text-muted"
                        : "px-2.5 text-ink-700"
                }
              >
                <span className="select-none pr-2 text-muted">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                {line.text || " "}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

// Kept beside the dream summary, independently of the filtered/paginated recent list.
export function DreamChanges({ expanded, diff, error }: { expanded: boolean; diff: DiffFile[] | null; error: string | null }) {
  if (!expanded) return null;
  return <div className="mt-3" role="region" aria-label="Latest dream changes">
    {error ? <p role="alert" className="text-xs text-error">{error}</p> : diff === null ? (
      <Spinner className="h-4 w-4 text-muted" />
    ) : diff.length === 0 ? (
      <p className="text-xs text-muted">No file changes in this dream commit.</p>
    ) : <DiffView files={diff} />}
  </div>;
}

/** Hearthside: dreams (reflection) merge into memory as "merge(reflection): <summary>". */
const DREAM = /^merge\(reflection\):\s*/i;
export function isDream(commit: MemoryCommit): boolean {
  return DREAM.test(commit.message);
}
export function dreamSummary(commit: MemoryCommit): string {
  return commit.message.replace(DREAM, "") || "A dream";
}

/**
 * Hearthside's memory web: the graph of memory files on the left; activity
 * (heatmap, commits, diffs) or the selected file on the right.
 */
type MemoryWebProps = {
  agentId: string;
  files: MemoryFile[];
  onOpenFile: (path: string) => void;
  loading?: boolean;
  error?: string | null;
};

export function MemoryWeb({ loading = false, error, ...props }: MemoryWebProps) {
  const { files, agentId } = props;
  const [prepared, setPrepared] = useState<{ files: MemoryFile[]; agentId: string; graph: Graph } | null>(null);
  const [failure, setFailure] = useState<{ files: MemoryFile[]; message: string } | null>(null);
  useEffect(() => {
    if (loading || error) return;
    return afterMemoryPaint(() => {
      try { setPrepared({ files, agentId, graph: buildMemoryGraph(files, { hideRootIndex: true }) }); setFailure(null); }
      catch { setFailure({ files, message: "Could not prepare the memory globe. Open Files to browse your memories." }); }
    });
  }, [files, agentId, loading, error]);
  const message = error || (failure?.files === files ? failure.message : null);
  const preparing = prepared?.files !== files || prepared.agentId !== agentId;
  const { covered, busy, status } = memoryWebCoverage({ loading, preparing, message, prepared: prepared?.agentId === agentId });
  return <div className="memory-web-loading-shell">
    {prepared?.agentId === agentId && <div key={prepared.agentId} className="memory-web-content" inert={covered} aria-hidden={covered || undefined} aria-busy={busy || undefined}><MemoryWebContent {...props} files={prepared.files} graph={prepared.graph} /></div>}
    {message ? <div className="memory-loading" role="alert">{message}</div> : status && <MemoryLoading label={status} />}
  </div>;
}

export function MemoryWebContent({ agentId, files, onOpenFile, graph }: MemoryWebProps & { graph: Graph }) {
  const hiddenIndexCount = files.length - graph.nodes.length;
  const [{ selected, category }, navigate] = useReducer(memoryNavigation, { selected: null, category: null });
  const setSelected = useCallback((path: string | null) => navigate({ type: "select", path }), []);
  const exploreCategory = useCallback((name: string | null) => {
    navigate({ type: "category", category: name });
    if (name !== null) setPanelOpen(true);
  }, []);
  const resetNavigation = () => navigate({ type: "reset" });
  const [commits, setCommits] = useState<MemoryCommit[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [sha, setSha] = useState<string | null>(null);
  const [dreamPreview, setDreamPreview] = useState(false);
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dreamsOnly, setDreamsOnly] = useState(false);

  const [panelOpen, setPanelOpen] = useState(true);
  const panelId = useId();
  const activityRequest = useRef(0);
  const selectMemory = useCallback((path: string | null) => {
    setSelected(path);
    if (path) setPanelOpen(true);
  }, [setSelected]);

  useEffect(() => {
    let cancelled = false;
    setCommits(null);
    setError(null);
    navigate({ type: "reset" });
    setSha(null);
    setDay(null);
    setDreamsOnly(false);
    const loadActivity = () => {
      const request = ++activityRequest.current;
      void window.bridge.listMemoryActivity(agentId, ACTIVITY_LIMIT).then((history) => {
        if (!cancelled && request === activityRequest.current) {
          setCommits([...history].sort((a, b) => b.timestamp - a.timestamp));
          setError(null);
        }
      }).catch((failure: unknown) => {
        if (!cancelled && request === activityRequest.current) setError(errorMessage(failure));
      });
    };
    loadActivity();
    // Refresh when the agent (or a dream) changes memory, or a turn ends.
    const unsubscribe = window.bridge.onEvent((event) => {
      if (event.type === "memory.updated" || event.type === "turn.finished") loadActivity();
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [agentId]);

  useEffect(() => {
    setDiffError(null);
    if (!sha) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiff(null);
    window.bridge
      .readMemoryCommitDiff(agentId, sha)
      .then((text) => !cancelled && setDiff(parseUnifiedDiff(text)))
      .catch((failure: unknown) => !cancelled && setDiffError(errorMessage(failure)));
    return () => {
      cancelled = true;
    };
  }, [agentId, sha]);

  const highlighted = useMemo(() => new Set(diff?.map((file) => file.path) ?? []), [diff]);
  const visibleCommits = (commits ?? []).filter(
    (commit) => (!day || localDateKey(new Date(commit.timestamp)) === day) && (!dreamsOnly || isDream(commit)),
  );
  const lastDream = (commits ?? []).find(isDream) ?? null;
  const dreamCount = (commits ?? []).filter(isDream).length;
  const selectedFile = files.find((file) => file.path === selected) ?? null;
  useEffect(() => {
    if (selected !== null && !graph.nodes.some(node => node.id === selected)) setSelected(null);
  }, [graph, selected, setSelected]);
  const [fileChange, setFileChange] = useState<{ agentId: string; path: string; commit: MemoryCommit | null } | null>(null);
  useEffect(() => {
    if (!selected || typeof window.bridge.listMemoryHistory !== "function") return;
    const path = selected;
    // Primitive effect dependencies below avoid refetching for array identity changes.
    return watchLatestMemoryChange(
      () => window.bridge.listMemoryHistory(agentId, path),
      (refresh) => window.bridge.onEvent((event) => {
        if (event.type === "memory.updated" || event.type === "turn.finished") refresh();
      }),
      (commit) => setFileChange({ agentId, path, commit }),
    );
  }, [agentId, selected, selectedFile?.content, selectedFile?.description, selectedFile?.system, selectedFile?.size]);
  const lastFileChange = fileChange?.agentId === agentId && fileChange.path === selected ? fileChange.commit : null;
  const now = Date.now();
  const connections = selectedFile ? graph.edges
    .filter((edge) => edge.source === selectedFile.path || edge.target === selectedFile.path)
    .map((edge) => files.find((file) => file.path === (edge.source === selectedFile.path ? edge.target : edge.source)))
    .filter((file): file is MemoryFile => Boolean(file)) : [];

  return (
    <div className="memory-atlas-shell"><div className="memory-atlas">
      <section className="memory-map" aria-label="Memory atlas">
        <header className="memory-atlas-header">
          <div className="memory-heading"><h2>Memory</h2><p className="memory-total">{files.length} files</p></div>
          <button type="button" className="memory-panel-toggle" aria-expanded={panelOpen} aria-controls={panelId} onClick={() => setPanelOpen(!panelOpen)}>
            {panelOpen ? "Hide sidebar" : selectedFile ? "Show memory details" : category !== null ? "Show category memories" : "Show activity"}
          </button>
        </header>
        <div className="memory-canvas">
          {files.length === 0 ? (
            <p className="p-6 text-sm text-muted">No memory files yet. The agent writes them as it learns.</p>
          ) : graph.nodes.length === 0 ? (
            <p className="p-6 text-sm text-muted">The memory index is available in Files. Other memory files will appear here.</p>
          ) : (
            <MemoryGraph graph={graph} selected={selected} highlighted={highlighted} onSelect={selectMemory} category={category} onCategoryChange={exploreCategory} />
          )}
        </div>
        <footer className="memory-legend">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5"><span className="memory-key memory-key-core" />Always in context</span>
            <span className="flex items-center gap-1.5"><span className="memory-key memory-key-retrieved" />Retrieved when needed</span>
            <span className="flex items-center gap-1.5"><span className="memory-key memory-key-skill" />Skills</span>
          </div>
          <div className="memory-legend-summary">
            <span>{files.filter((file) => file.system).length} core (always in context) · {files.filter((file) => !file.system).length} retrieved when needed</span>
            <span className="text-muted">{graph.nodes.length} {selectedFile ? "total graph files" : "shown"}{hiddenIndexCount > 0 ? ` · ${hiddenIndexCount} index hidden (in Files)` : ""}</span>
          </div>
        </footer>
      </section>

      <aside id={panelId} className="memory-panel" hidden={!panelOpen} aria-label={selectedFile ? "Memory detail" : category !== null ? "Memory category" : "Memory activity"}>
        <nav className="memory-panel-tabs" aria-label="Memory sidebar">
          <button type="button" aria-pressed={!selectedFile && category === null} onClick={resetNavigation}>Activity</button>
          {selectedFile ? <span className="memory-panel-current" aria-current="page">Details</span> : category !== null && <span className="memory-panel-current" aria-current="page">Category</span>}
          {(selectedFile || category !== null) && <button type="button" onClick={resetNavigation}>All memories</button>}
        </nav>
        {selectedFile ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <span className={`memory-status ${selectedFile.system ? "memory-status-core" : ""}`}>{selectedFile.system ? "Always in context" : "Retrieved when needed"}</span>
                <h2 className="memory-detail-title">{memoryTitle(selectedFile)}</h2>
                <MemorySkillBadge file={selectedFile} />
                {selectedFile.description && <p className="memory-description">{selectedFile.description}</p>}
                <p className="memory-path">{selectedFile.path}</p>
                {lastFileChange && <p className="memory-file-history" title={new Date(lastFileChange.timestamp).toLocaleString()}>Last change · {ago(lastFileChange.timestamp, now)}{lastFileChange.author ? ` · ${lastFileChange.author}` : ""}</p>}
              </div>
            </div>
            <div className="memory-detail-scroll">
              <article className="memory-prose"><Markdown text={selectedFile.content.replace(/^\s*#\s+[^\r\n]+\r?\n(?:\s*\r?\n)*/, "") || "(empty)"} allowImages={false} /></article>
              <section className="memory-connections" aria-label="Connected memories">
                <h3>Connected memories <span>{connections.length}</span></h3>
                {connections.length > 0 ? connections.map((file) => (
                  <button key={file.path} type="button" onClick={() => setSelected(file.path)}>
                    <span>{memoryTitle(file)}</span><small>{file.path}</small>
                  </button>
                )) : <p>No links to other memories yet.</p>}
              </section>
            </div>
            <div className="border-t border-border px-4 py-3">
              <button type="button" className="button-primary" onClick={() => onOpenFile(selectedFile.path)}>
                Open in editor
              </button>
            </div>
          </div>
        ) : category !== null ? (
          <MemoryCategoryBreakdown key={category} graph={graph} category={category} onSelect={selectMemory} />
        ) : (
          <div className="memory-activity-scroll">
            <div className="border-b border-border px-4 py-3">
              <p className="memory-eyebrow">Memory activity</p>
              <h2 className="memory-activity-title">Recent changes</h2>
              <p className="memory-activity-summary">{commits === null ? "Loading memory history…" : `${commits.length === ACTIVITY_LIMIT ? "Latest " : ""}${commits.length} recorded changes · ${dreamCount} dreams`}</p>
              {commits === null ? (
                error ? <p className="text-xs text-error">{error}</p> : <Spinner className="h-4 w-4 text-muted" />
              ) : (
                <Heatmap commits={commits} day={day} onDay={(next) => { setDay(next); setSha(null); }} />
              )}
            </div>
            {lastDream && (
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-ink-700">☾ Last dream · {ago(lastDream.timestamp, now)}</span>
                  <button
                    type="button"
                    className="text-[11px] text-accent hover:underline"
                    onClick={() => setDreamsOnly(!dreamsOnly)}
                    aria-pressed={dreamsOnly}
                  >
                    {dreamsOnly ? "Show all changes" : `Dreams only (${dreamCount})`}
                  </button>
                </div>
                <p className="mt-1 line-clamp-3 text-sm text-ink-800">{dreamSummary(lastDream)}</p>
                <button type="button" className="mt-1 text-xs text-accent hover:underline" aria-expanded={dreamPreview && sha === lastDream.sha} onClick={() => {
                  setSha(dreamPreview && sha === lastDream.sha ? null : lastDream.sha);
                  setDreamPreview(true);
                }}>
                  {dreamPreview && sha === lastDream.sha ? "Hide what it changed" : "Show what it changed"}
                </button>
                <DreamChanges expanded={dreamPreview && sha === lastDream.sha} diff={diff} error={diffError} />
              </div>
            )}
            <div className="min-w-0">
              {error && commits !== null && <p role="alert" className="px-4 py-3 text-xs text-error">{error}</p>}
              {day && (
                <button type="button" className="w-full px-4 pt-2 text-left text-xs text-accent hover:underline" onClick={() => setDay(null)}>
                  Showing {day} · show all
                </button>
              )}
              {commits !== null && visibleCommits.length === 0 && <p className="px-4 py-6 text-center text-xs text-muted">No memory changes yet.</p>}
              <ul className="py-1">
                {visibleCommits.slice(0, 200).map((commit) => (
                  <li key={commit.sha}>
                    <button
                      type="button"
                      onClick={() => {
                        setSha(!dreamPreview && sha === commit.sha ? null : commit.sha);
                        setDreamPreview(false);
                      }}
                      className={`flex w-full items-start gap-2.5 px-4 py-2 text-left transition-colors ${sha === commit.sha ? "bg-accent-light" : "hover:bg-surface-tertiary"}`}
                    >
                      {isDream(commit) ? (
                        <span className="mt-0.5 shrink-0 text-sm leading-none text-accent" aria-label="Dream">☾</span>
                      ) : (
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sha === commit.sha ? "bg-accent" : "bg-ink-400"}`} />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink-900">
                          {isDream(commit) ? `Dream: ${dreamSummary(commit)}` : commit.message || "(no message)"}
                        </span>
                        <span className="block text-xs text-muted">
                          {ago(commit.timestamp, now)}{commit.author ? ` · ${commit.author}` : ""}
                        </span>
                      </span>
                    </button>
                    {!dreamPreview && sha === commit.sha && (
                      <div className="px-4 pb-3">
                        {diffError ? <p role="alert" className="text-xs text-error">{diffError}</p> : diff === null ? (
                          <Spinner className="h-4 w-4 text-muted" />
                        ) : diff.length === 0 && isDream(commit) ? (
                          <p className="text-xs text-muted">No file changes in this dream commit.</p>
                        ) : (
                          <DiffView files={diff} />
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </aside>
    </div></div>
  );
}
