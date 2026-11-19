import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../store";

/**
 * Hearthside: a short guided tour on a new install. The screen dims and blurs
 * around one part of the app, which stays clear and outlined, with a card
 * saying what it is. Next / Back / Skip; Esc skips, arrow keys move. It starts
 * once after the welcome (and after the companion builder, if that opened),
 * and can be replayed from Settings → General. Stops point at elements marked
 * data-tour="…"; a stop whose element isn't on screen is left out.
 */

type Stop = { target: string; title: string; body: ReactNode };

export const TOUR_STOPS: Stop[] = [
  {
    target: "agents",
    title: "Your companions",
    body: "Switch between your companions here, and star the ones you talk to most. The + makes a new one.",
  },
  {
    target: "new-chat",
    title: "Chats",
    body: "Start a fresh conversation any time. Your companion remembers across all of them, and your chats are listed below.",
  },
  {
    target: "memory",
    title: "Memory",
    body: "Everything your companion remembers, as a web and as files. You can read and edit it, and bring in past ChatGPT or Claude conversations.",
  },
  {
    target: "composer",
    title: "Talking",
    body: "Write here. Type / for shortcuts like /remember, attach files or pictures, or send a GIF. While a reply is coming you can stop it or queue your next message.",
  },
  {
    target: "tools",
    title: "Skills, schedules and calendar",
    body: "Skills teach your companion new abilities. Schedules let them check in on their own, like a morning hello. The calendar is yours to share with them.",
  },
  {
    target: "more",
    title: "More",
    body: "Channels, to talk from Telegram or Discord. Connectors, for tools like a voice, Notion or your own apps. And archived chats.",
  },
  {
    target: "settings",
    title: "Settings",
    body: (
      <ul className="grid list-disc gap-0.5 pl-4">
        <li>Where your companions live: this computer, Letta Cloud or your own server</li>
        <li>Models and sign-ins</li>
        <li>Theme, text size and notifications</li>
        <li>Updates, and Diagnostics if something goes wrong</li>
      </ul>
    ),
  },
];

const PAD = 6;
const CARD_WIDTH = 320;

function rectOf(target: string): DOMRect | null {
  const element = document.querySelector(`[data-tour="${target}"]`);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

export function GuidedTour() {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const newAgentOpen = useAppStore((state) => state.newAgentOpen);
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  // Wait for the welcome, the builder and Settings to close before starting.
  const wanted = Boolean(settings && settings.welcomed && !settings.toured && !newAgentOpen && !settingsOpen);
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!wanted) {
      setActive(false);
      return;
    }
    // Give the sidebar a moment to settle after the welcome closes.
    const timer = setTimeout(() => {
      setIndex(0);
      setActive(true);
    }, 600);
    return () => clearTimeout(timer);
  }, [wanted]);

  const stops = TOUR_STOPS.filter((stop) => !active || rectOf(stop.target));
  const stop = stops[Math.min(index, stops.length - 1)];
  const finish = useCallback(() => {
    setActive(false);
    void saveSettings({ toured: true });
  }, [saveSettings]);

  useLayoutEffect(() => {
    if (!active || !stop) return;
    const measure = () => setRect(rectOf(stop.target));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [active, stop]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
      else if (event.key === "ArrowRight" || event.key === "Enter") {
        if (index >= stops.length - 1) finish();
        else setIndex(index + 1);
      } else if (event.key === "ArrowLeft") setIndex(Math.max(0, index - 1));
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, index, stops.length, finish]);

  // Re-measure if the layout shifts (e.g. More expands).
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 500);
    return () => clearInterval(timer);
  }, [active]);

  if (!active || !stop || !rect || stops.length === 0) return null;

  const hole = { left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // The card goes to the right of the spot when it fits, otherwise above or below.
  const right = hole.left + hole.width + 16;
  let cardLeft: number;
  let cardTop: number;
  if (right + CARD_WIDTH <= vw - 16) {
    cardLeft = right;
    cardTop = Math.min(Math.max(16, hole.top), vh - 260);
  } else {
    cardLeft = Math.min(Math.max(16, hole.left), vw - CARD_WIDTH - 16);
    cardTop = hole.top > vh / 2 ? Math.max(16, hole.top - 230) : hole.top + hole.height + 16;
  }
  const pane = "fixed bg-black/45 backdrop-blur-[2px]";
  const last = index >= stops.length - 1;

  return (
    <div className="fixed inset-0 z-[60]" data-testid="guided-tour">
      {/* Four panes around the spot: dimmed and blurred, the spot itself clear. */}
      <div className={pane} style={{ left: 0, top: 0, width: vw, height: Math.max(0, hole.top) }} />
      <div className={pane} style={{ left: 0, top: hole.top + hole.height, width: vw, height: Math.max(0, vh - hole.top - hole.height) }} />
      <div className={pane} style={{ left: 0, top: hole.top, width: Math.max(0, hole.left), height: hole.height }} />
      <div className={pane} style={{ left: hole.left + hole.width, top: hole.top, width: Math.max(0, vw - hole.left - hole.width), height: hole.height }} />
      {/* The spot: outlined, and not clickable while the tour is on. */}
      <div className="pointer-events-auto fixed rounded-xl ring-2 ring-accent ring-offset-2 ring-offset-transparent" style={hole} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        className="fixed grid gap-2 rounded-2xl border border-border bg-surface p-4 shadow-elevated"
        style={{ left: cardLeft, top: cardTop, width: CARD_WIDTH }}
      >
        <span className="text-[11px] text-muted">
          {index + 1} of {stops.length}
        </span>
        <h2 id="tour-title" className="text-sm font-semibold text-ink-900">
          {stop.title}
        </h2>
        <div className="text-sm text-ink-800">{stop.body}</div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <button type="button" className="text-xs text-muted hover:text-ink-800 hover:underline" onClick={finish}>
            Skip the tour
          </button>
          <div className="flex gap-2">
            {index > 0 && (
              <button type="button" className="button-secondary px-3 py-1 text-xs" onClick={() => setIndex(index - 1)}>
                Back
              </button>
            )}
            <button type="button" className="button-primary px-3 py-1 text-xs" autoFocus onClick={() => (last ? finish() : setIndex(index + 1))}>
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
