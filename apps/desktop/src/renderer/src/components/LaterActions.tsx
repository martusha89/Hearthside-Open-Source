import { useAppStore } from "../store";

export function LaterActions({ current }: { current: "calendar" | "schedules" | "intentions" }) {
  const options = [
    { id: "calendar", title: "Calendar", text: "Remember an event or reminder." },
    { id: "schedules", title: "Schedules", text: "Ask your companion to act at a chosen time." },
    { id: "intentions", title: "Intentions", text: "Keep conversation loose ends, with optional follow-ups." },
  ] as const;
  return <nav aria-label="Ways to plan for later" className="grid gap-1 rounded-xl border border-border p-3 text-xs text-muted">{options.map((option) => <p key={option.id}>{option.id === current ? <strong className="text-ink-900">{option.title}</strong> : <button type="button" className="text-accent underline" onClick={() => {
    if (option.id === "intentions") useAppStore.getState().openSettings("intentions");
    else useAppStore.setState({ view: option.id, settingsOpen: false });
  }}>{option.title}</button>} · {option.text}</p>)}</nav>;
}
