import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraph as Graph } from "../lib/memory-graph";
import { contextLabel, directMemoryNeighborhood } from "../lib/memory-cosmos-layout";
import { MemoryCosmosRenderer } from "../lib/memory-cosmos-renderer";
import "./memory-cosmos.css";
import { afterMemoryPaint } from "../lib/after-memory-paint";
import { globeDrawingState } from "../lib/memory-loading-state";

export function MemoryLoading({ label }: { label: string }) {
  return <div className="memory-loading" role="status" aria-live="polite"><span className="memory-loading-ring" aria-hidden="true" /><span>{label}</span></div>;
}

/** Real files and real links, surrounded by decorative (non-semantic) atmosphere. */
export function MemoryGraph({ graph, selected, highlighted, onSelect, category: controlledCategory, onCategoryChange }: {
  graph: Graph;
  selected: string | null;
  highlighted: ReadonlySet<string>;
  onSelect: (path: string | null) => void;
  category?: string | null;
  onCategoryChange?: (category: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const renderer = useRef<MemoryCosmosRenderer | null>(null);
  const [localCategory, setLocalCategory] = useState<string | null>(null);
  const category = controlledCategory === undefined ? localCategory : controlledCategory;
  const callbacks = useRef({ onSelect, selected, onCategoryChange });
  callbacks.current = { onSelect, selected, onCategoryChange };
  const setCategory = (name: string | null) => {
    setLocalCategory(name);
    callbacks.current.onCategoryChange?.(name);
  };
  const cameraState = useRef<{ graph: Graph; selected: string | null; category: string | null } | null>(null);
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);
  const [backend, setBackend] = useState<"webgl" | "software" | "unavailable">("webgl");
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [page, setPage] = useState(0);
  const choose = (id: string) => {
    // Selection shows actual cross-category links, not just region membership.
    setCategory(null); setHoveredCategory(null);
    callbacks.current.onSelect(callbacks.current.selected === id ? null : id);
  };
  const explore = (name: string) => {
    setCategory(name); setHoveredCategory(null); setQuery(""); setPage(0);
    callbacks.current.onSelect(null);
  };
  const [settled, setSettled] = useState<Graph | null>(null);
  // The overlay covers only the first draw; a replacement graph keeps the drawn globe visible, marked busy.
  const { pending, stale } = globeDrawingState({ hasNodes: graph.nodes.length > 0, settled, graph });
  const currentState = useRef({ selected, highlighted, category, hoveredCategory });
  currentState.current = { selected, highlighted, category, hoveredCategory };
  useEffect(() => {
    if (!host.current || !labels.current || graph.nodes.length === 0) return;
    let cancelled = false;
    let view: MemoryCosmosRenderer | null = null;
    setBackend("webgl");
    const cancel = afterMemoryPaint(() => {
      if (cancelled || !host.current || !labels.current) return;
      try {
        view = new MemoryCosmosRenderer(host.current, labels.current, graph, {
          select: choose, category: explore, hoverCategory: setHoveredCategory,
          backend: name => { if (!cancelled) { setBackend(name); if (name === "unavailable") setSettled(graph); } },
          ready: () => { if (!cancelled) setSettled(graph); },
          browseCategory: name => { explore(name); setListOpen(true); },
        });
        renderer.current = view;
        view.update(currentState.current);
        if (currentState.current.selected !== null) view.revealSelection(currentState.current.selected);
        else view.focus(currentState.current.category);
      } catch {
        view?.dispose(); renderer.current = null;
        if (!cancelled) { setBackend("unavailable"); setSettled(graph); }
      }
    });
    return () => { cancelled = true; cancel(); view?.dispose(); renderer.current = null; cameraState.current = null; };
  }, [graph]); // callbacks use refs so selecting a file never rebuilds the scene.
  useEffect(() => {
    renderer.current?.update({ selected, highlighted, category, hoveredCategory });
  }, [graph, selected, highlighted, category, hoveredCategory]);
  useEffect(() => {
    const previous = cameraState.current;
    cameraState.current = { graph, selected, category };
    // One camera transition per navigation, including returning from file details.
    if (selected !== null) {
      if (previous?.graph !== graph || previous.selected !== selected) renderer.current?.revealSelection(selected);
    } else if (previous?.graph !== graph || previous.selected !== null || previous.category !== category) {
      renderer.current?.focus(category);
    }
  }, [graph, selected, category]);
  useEffect(() => {
    if (category !== null && !graph.nodes.some(node => node.group === category)) {
      setLocalCategory(null);
      callbacks.current.onCategoryChange?.(null);
    }
  }, [graph, category]);

  const matches = useMemo(() => graph.nodes.filter(node => (category === null || node.group === category) && `${node.title ?? ""} ${node.id}`.toLowerCase().includes(query.trim().toLowerCase())), [graph, category, query]);
  const focusedCount = useMemo(() => directMemoryNeighborhood(graph.edges, selected).size, [graph, selected]);
  const reset = () => {
    setCategory(null); setHoveredCategory(null); setQuery(""); setPage(0); onSelect(null);
    if (selected === null && category === null) renderer.current?.focus(null);
  };
  const shown = matches.slice(page * 60, (page + 1) * 60);
  useEffect(() => { setPage(0); }, [graph, category, query]);

  return <div className="memory-cosmos" data-renderer={backend}>
    <div className="memory-cosmos-toolbar">
      <div className="memory-cosmos-navigation">
        {category !== null || selected !== null ? <button type="button" onClick={reset}>← All memories</button> : <span className="memory-cosmos-heading">Memory cosmos</span>}
        <select aria-label="Explore memory category" value={category === null ? "all" : `category:${category}`} onChange={event => event.target.value === "all" ? reset() : explore(event.target.value.slice(9))}>
          <option value="all">All regions</option>
          {graph.groups.map(group => <option key={group} value={`category:${group}`}>{group || "Other memory"} · {graph.nodes.filter(node => node.group === group).length}</option>)}
        </select>
      </div>
      <div className="memory-cosmos-controls">
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => renderer.current?.zoom(1.3)}>+</button>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => renderer.current?.zoom(1 / 1.3)}>−</button>
        <button type="button" aria-label="Fit to screen" onClick={() => selected !== null ? renderer.current?.revealSelection(selected) : renderer.current?.focus(category)}>Fit</button>
        <button type="button" aria-label="Reset memory view" onClick={reset}>Reset</button>
      </div>
    </div>
    <div ref={host} className="memory-cosmos-stage" tabIndex={0} role="group" aria-label={`Memory cosmos: ${graph.nodes.length} files, ${graph.edges.length} links. Arrow keys orbit; plus and minus zoom; Home resets. Use Browse files for a complete accessible list.`} onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "Home", "Escape"].includes(event.key)) event.preventDefault();
      if (event.key === "ArrowLeft") renderer.current?.orbit(-.12, 0);
      if (event.key === "ArrowRight") renderer.current?.orbit(.12, 0);
      if (event.key === "ArrowUp") renderer.current?.orbit(0, -.12);
      if (event.key === "ArrowDown") renderer.current?.orbit(0, .12);
      if (event.key === "+" || event.key === "=") renderer.current?.zoom(1.2);
      if (event.key === "-") renderer.current?.zoom(1 / 1.2);
      if (event.key === "Home" || event.key === "Escape") reset();
    }}>
      <div ref={labels} className="memory-cosmos-labels" aria-busy={stale || undefined} />
      {pending && <MemoryLoading label="Drawing memory globe…" />}
      {graph.nodes.length === 0 && <p className="memory-cosmos-empty">No memory files to show.</p>}
      {backend === "unavailable" && <p className="memory-cosmos-empty">Graphics unavailable. Browse all files below.</p>}
    <div className="memory-cosmos-footnote">
      <span>{selected !== null ? `${focusedCount} memories in focus · ${graph.edges.filter(edge => edge.source === selected || edge.target === selected).length} real connections` : category !== null ? `${category || "Other memory"} · ${matches.length} files` : `${graph.nodes.length} files · ${graph.edges.length} real links`}<small>{selected !== null ? "Selected memory and direct connections · All memories restores the globe" : "Turn and zoom to reveal names · counted clusters open on approach"}{backend === "software" ? " · Software 3D" : ""}</small></span>
      <button type="button" aria-expanded={listOpen || backend === "unavailable"} disabled={backend === "unavailable"} onClick={() => setListOpen(!listOpen)}>{backend === "unavailable" ? "File list open" : listOpen ? "Hide file list" : "Browse files"}</button>
    </div>
    </div>
    {(listOpen || backend === "unavailable") && <section className="memory-cosmos-browser" aria-label="Memory files">
      <div className="memory-cosmos-search"><input aria-label="Search memory titles and paths" placeholder="Find a title or path…" value={query} onChange={event => setQuery(event.target.value)} /><span aria-live="polite">{matches.length} files{highlighted.size > 0 ? ` · ${graph.nodes.filter(n => highlighted.has(n.id)).length} changed` : ""}</span></div>
      <div className="memory-cosmos-filelist">
        {shown.map(node => <button key={node.id} type="button" className={highlighted.has(node.id) ? "is-changed" : ""} aria-pressed={selected === node.id} onClick={() => choose(node.id)}>
          <strong>{node.title || node.label}</strong><span>{node.id}</span><small>{contextLabel(node)}{highlighted.has(node.id) ? " · Changed" : ""}</small>
        </button>)}
        {matches.length === 0 && <p>No matching files.</p>}
      </div>
      {matches.length > 60 && <div className="memory-cosmos-pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {Math.ceil(matches.length / 60)}</span><button disabled={(page + 1) * 60 >= matches.length} onClick={() => setPage(page + 1)}>Next</button></div>}
    </section>}
  </div>;
}
