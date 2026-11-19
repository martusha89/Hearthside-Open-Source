import { useCallback, useEffect, useState } from "react";
import { folderName } from "../lib/format";
import MDContent from "../render/markdown";
import { composerKey, selectCwd, useAppStore } from "../store";
import { ChevronRightIcon, FileIcon, FolderIcon, Spinner } from "./icons";

/**
 * Hearthside: the agent's working folder. Read what it made; Markdown and
 * HTML can be seen rendered or as source. HTML is shown with scripts off.
 */

type Listing = { folders: string[]; files: string[] };

function Folder({ root, path, depth, selected, onOpen }: { root: string; path: string; depth: number; selected: string | null; onOpen: (path: string) => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    window.bridge
      .listDirectory(root, path)
      .then(setListing)
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  }, [root, path]);
  const indent = { paddingLeft: `${depth * 14 + 8}px` };
  if (error) return <p className="px-3 py-1 text-xs text-error" style={indent}>{error}</p>;
  if (!listing) return <Spinner className="my-1 h-3.5 w-3.5 text-muted" />;
  return (
    <ul>
      {listing.folders.map((folder) => {
        const child = path ? `${path}/${folder}` : folder;
        return (
          <li key={child}>
            <button type="button" onClick={() => setOpen((current) => ({ ...current, [child]: !current[child] }))} className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm text-ink-800 hover:bg-surface-tertiary" style={indent} aria-expanded={Boolean(open[child])}>
              <ChevronRightIcon className={`h-3 w-3 shrink-0 text-muted transition-transform ${open[child] ? "rotate-90" : ""}`} />
              <FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="truncate">{folder}</span>
            </button>
            {open[child] && <Folder root={root} path={child} depth={depth + 1} selected={selected} onOpen={onOpen} />}
          </li>
        );
      })}
      {listing.files.map((file) => {
        const child = path ? `${path}/${file}` : file;
        return (
          <li key={child}>
            <button type="button" onClick={() => onOpen(child)} className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm ${selected === child ? "bg-accent-light text-ink-900" : "text-ink-800 hover:bg-surface-tertiary"}`} style={{ paddingLeft: `${depth * 14 + 26}px` }}>
              <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
              <span className="truncate">{file}</span>
            </button>
          </li>
        );
      })}
      {listing.folders.length + listing.files.length === 0 && <li className="py-1 text-xs text-muted" style={indent}>(empty)</li>}
    </ul>
  );
}

export function FilesView() {
  const activeId = useAppStore((state) => state.activeId);
  const root = useAppStore((state) => selectCwd(state, composerKey(state)));
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"rendered" | "source">("rendered");

  const open = useCallback(
    (path: string) => {
      setSelected(path);
      setContent(null);
      setError(null);
      window.bridge
        .readWorkingFile(root, path)
        .then(setContent)
        .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
    },
    [root],
  );
  useEffect(() => {
    setSelected(null);
    setContent(null);
  }, [root]);

  const kind = selected?.match(/\.(md|markdown)$/i) ? "markdown" : selected?.match(/\.html?$/i) ? "html" : "text";
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface">
      <header className="app-drag flex h-12 shrink-0 items-center justify-center border-b border-border px-6">
        <span className="truncate text-sm font-medium text-ink-700" title={root}>
          Files in {folderName(root) || "the working folder"}
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="w-72 shrink-0 overflow-y-auto border-r border-border py-2" aria-label="Files">
          <Folder key={root} root={root} path="" depth={0} selected={selected} onOpen={open} />
        </nav>
        <section className="flex min-w-0 flex-1 flex-col">
          {!selected ? (
            <p className="p-6 text-sm text-muted">Choose a file to read it. The working folder is set in the message box.</p>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border px-4 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-800">{selected}</span>
                {kind !== "text" && (
                  <div className="flex gap-1 rounded-lg bg-surface-tertiary p-0.5 text-xs" role="tablist">
                    {(["rendered", "source"] as const).map((item) => (
                      <button key={item} type="button" role="tab" aria-selected={mode === item} onClick={() => setMode(item)} className={`rounded-md px-2 py-0.5 ${mode === item ? "bg-surface text-ink-900 shadow-soft" : "text-muted"}`}>
                        {item === "rendered" ? "Rendered" : "Source"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {error ? (
                  <p className="p-4 text-sm text-error">{error}</p>
                ) : content === null ? (
                  <Spinner className="m-4 h-4 w-4 text-muted" />
                ) : kind === "markdown" && mode === "rendered" ? (
                  <div className="mx-auto max-w-3xl px-6 py-4">
                    <MDContent text={content} />
                  </div>
                ) : kind === "html" && mode === "rendered" ? (
                  // No scripts, no forms, no navigation: just the page.
                  <iframe title={selected} sandbox="" srcDoc={content} className="h-full w-full bg-white" />
                ) : (
                  <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-relaxed text-ink-800">{content}</pre>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
