import { useEffect, useRef, useState } from "react";
import type { Followup, FollowupCaptureStatus, FollowupCreate, FollowupPolicy } from "@hearthside/ipc-contract";
import { useAppStore } from "../store";
import { enabledFollowupPolicy, followupConsentKey, needsFollowupConsent } from "../lib/followup-consent";
import { ModelPicker } from "./ModelPicker";
import { LaterActions } from "./LaterActions";
import { TimezoneSelect, ZonedDateTime } from "./ZonedDateTime";
import { isExplicitInstant, tomorrowMorning } from "../lib/zoned-date";
import { resolveModel } from "../lib/models";

const initialPolicy: FollowupPolicy = {
  enabled: false, extractAutomatically: true, autoActivate: true, proactive: false, timezone: "UTC",
  quietStart: "22:00", quietEnd: "08:00", dailyLimit: 1, topicExclusions: [],
  semanticModel: null, dailyClassifierLimit: 40, automaticNotes: true,
};
const initialCapture: FollowupCaptureStatus = { available: false, reason: "Loading…", model: null, usedToday: 0, limit: 0, archiveFailures: 0 };
const originLabels: Record<Followup["origin"], string> = {
  classifier_proposed: "Noticed in what you wrote — not an intention your companion formed",
  agent_created: "Created by your companion",
  user_created: "Created by you",
  policy_activated: "Noticed in what you wrote and kept, because you turned noticing on",
};

/** Where an item came from, and who activated it: never the companion's own idea. */
export function originLine(item: Followup): string {
  const origin = item.origin === "classifier_proposed" && item.adoptedBy === "agent"
    ? "Originally noticed in what you wrote"
    : originLabels[item.origin];
  const adopted = item.adoptedBy === "agent" ? " · Adopted by your companion" : item.adoptedBy ? ` · Activated by ${item.adoptedBy}` : "";
  return `${origin}${adopted}`;
}

/** Temporary check conversations Hearthside could not confirm it archived. */
export function ArchiveNotice({ failures }: { failures: number }) {
  if (failures < 1) return null;
  const one = failures === 1;
  return <p role="alert" className="text-xs text-error">{failures} temporary check conversation{one ? "" : "s"} {one ? "was" : "were"} not confirmed archived. {one ? "It may" : "They may"} still be in your Letta account&rsquo;s conversation list, where you can archive or delete {one ? "it" : "them"} yourself. Archiving is not deletion.</p>;
}

export function IntentionsPanel() {
  const agentId = useAppStore((state) => state.agentId);
  const activeId = useAppStore((state) => state.activeId);
  const epoch = useAppStore((state) => state.backendEpoch);
  if (!agentId) return <p className="mt-4 text-sm text-muted">Select a companion to manage follow-ups.</p>;
  const conversationId = activeId ?? `main:${agentId}`;
  // Remount synchronously: no previous scope's private data survives even one render.
  return <ScopedIntentions key={JSON.stringify([epoch, agentId, conversationId])} agentId={agentId} conversationId={conversationId} />;
}

function ScopedIntentions({ agentId, conversationId }: { agentId: string; conversationId: string }) {
  const models = useAppStore((state) => state.models);
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === agentId)?.name ?? "Selected companion");
  const chatTitle = useAppStore((state) => conversationId === `main:${agentId}` || state.conversations.find((chat) => chat.id === conversationId)?.main ? "Main chat" : state.conversations.find((chat) => chat.id === conversationId)?.title || "Untitled chat");
  const [managing, setManaging] = useState(false);
  const [reminding, setReminding] = useState<string | null>(null);
  const [policy, setPolicy] = useState<FollowupPolicy>(initialPolicy);
  const [savedPolicy, setSavedPolicy] = useState<FollowupPolicy | null>(null);
  const [acknowledgedFor, setAcknowledgedFor] = useState<string | null>(null);
  const consentKey = followupConsentKey(policy);
  const consentRequired = needsFollowupConsent(savedPolicy, policy);
  const consentMissing = consentRequired && acknowledgedFor !== consentKey;
  const policyDirty = !savedPolicy || followupConsentKey(savedPolicy) !== consentKey;
  const [items, setItems] = useState<Followup[]>([]);
  const [capture, setCapture] = useState<FollowupCaptureStatus>(initialCapture);
  const [audienceReason, setAudienceReason] = useState("");
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(false);
  const locked = useRef(true);
  const [editing, setEditing] = useState<Followup | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [action, setAction] = useState("");
  const [notBefore, setNotBefore] = useState("");
  const [expiresAt, setExpiresAt] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString());
  const [deferUntil, setDeferUntil] = useState("");

  const load = async () => {
    const view = await window.bridge.getFollowups(agentId, conversationId);
    if (!alive.current) return;
    setPolicy(view.policy); setSavedPolicy(view.policy); setAcknowledgedFor(null); setItems(view.items); setStatus(view.status); setLoaded(true);
    if (!view.policy.enabled) setManaging(true);
    setCapture(view.capture); setAudienceReason(view.audienceReason);
  };
  useEffect(() => {
    alive.current = true;
    void load().catch((failure: unknown) => {
      if (alive.current) { setError(String(failure)); setStatus("Follow-ups unavailable on this connection."); }
    }).finally(() => { if (alive.current) { locked.current = false; setBusy(false); } });
    return () => { alive.current = false; };
  }, []);

  const run = async (work: () => Promise<unknown>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await work(); if (alive.current) await load(); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (alive.current) { locked.current = false; setBusy(false); } }
  };
  const iso = (value: string) => {
    if (!isExplicitInstant(value)) {
      throw new Error("Use an ISO timestamp with an explicit offset, for example 2026-10-20T09:00:00Z.");
    }
    // Preserve the original date for the strict IPC validator: Date alone can
    // silently normalise an impossible date such as February 31 into March.
    return value;
  };
  const resetForm = () => { setFormVersion((version) => version + 1); setEditing(null); setSummary(""); setAction(""); setNotBefore(""); setExpiresAt(new Date(Date.now() + 7 * 86400000).toISOString()); };
  const change = (item: Followup, kind: "adopt" | "defer" | "resolve" | "cancel", until = deferUntil) => run(async () => {
    await window.bridge.changeFollowup(agentId, conversationId, item.id, item.revision, kind, kind === "defer" ? iso(until) : undefined);
    if (alive.current && editing?.id === item.id) resetForm();
  });

  return <section className="mt-4 grid min-w-0 gap-5 break-words text-sm text-ink-900" aria-label="Things your companion is keeping in mind">
    <div className="grid gap-2">
      <h3 className="font-medium">Things your companion is keeping in mind</h3>
      <p className="text-xs text-muted">Beta · Checks and new follow-ups run while Hearthside is running, including in the tray. Quitting stops new checks and dispatches; it does not cancel work already accepted by the runtime.</p>
      <p className="rounded-lg bg-accent-subtle px-3 py-2 text-xs text-ink-800">For {agentName} · {chatTitle} · Checks while this app is open</p>
      <LaterActions current="intentions" />
      <p className="text-xs text-muted">Noticing sends your message text and open summaries to your chosen model and may cost credits. Temporary check conversations are archived, not deleted; archiving can fail. Timed follow-ups separately use your companion's model and may cost credits.</p>
      {policy.enabled && <button type="button" className="button-secondary justify-self-start" onClick={() => setManaging(!managing)}>{managing ? "Close management" : "Manage"}</button>}
      <details><summary className="cursor-pointer text-xs text-muted">How this works</summary>
      <p className="text-muted">Short-term memory for this companion and this conversation only. Checks and new timed follow-up dispatches require Hearthside to be running, including in the tray. Quitting stops new checks and dispatches, not work already accepted by the runtime. That is true for Cloud companions too: this controller runs on this computer, not on a server. There is no hosted version of it.</p>
      <p className="text-muted">What is kept here comes from what you wrote. It is not an intention your companion formed, and a time arriving is never evidence that anything happened.</p>
      </details>
      <p role="status" className="text-muted">{status}{notice && ` · ${notice}`}</p>
      <p className="text-xs text-muted">{audienceReason || "Checking who can read this conversation…"}</p>
      <p className="text-xs text-muted">Noticing: {capture.reason}{capture.limit > 0 ? ` (${capture.usedToday} of ${capture.limit} checks today)` : ""}</p>
      <ArchiveNotice failures={capture.archiveFailures} />
      {error && <p role="alert" className="text-error">{error}</p>}
      {!loaded && <button className="button-secondary justify-self-start" disabled={busy} onClick={() => void run(load)}>Retry</button>}
    </div>
    <div hidden={loaded && policy.enabled && !managing}><form onSubmit={(event) => { event.preventDefault(); void run(async () => {
      if (consentMissing) throw new Error("Review and acknowledge the privacy and model-use disclosure before enabling these settings.");
      if (policy.enabled && !policy.semanticModel?.trim()) throw new Error("Choose the model that should do the noticing, or switch short-term memory off.");
      await window.bridge.saveFollowupPolicy(agentId, conversationId, {
        ...policy,
        semanticModel: policy.semanticModel?.trim() ? policy.semanticModel.trim() : null,
        topicExclusions: policy.topicExclusions.map((topic) => topic.trim()).filter(Boolean),
      });
      if (alive.current) setManaging(false);
    }); }}>
      <fieldset disabled={busy || !loaded} className="grid min-w-0 gap-3">
        <legend className="mb-3 font-medium">Conversational short-term memory (off until you turn it on)</legend>
        <div className="grid gap-2 rounded-xl border border-border p-3 text-xs text-muted">
          <p className="text-ink-900">Turning this on means, for this private conversation only:</p>
          <ul className="grid list-disc gap-1 pl-5">
            <li>Each message you send is checked for appointments, plans, waiting and loose ends. The message text and a short list of what is already being kept in mind are sent to the model you pick below.</li>
            <li>Each check runs as a separate conversation in your Letta account with no companion attached: it does not see your companion's persona, memory or tools, and nothing it says is added to this chat. Hearthside archives that conversation afterwards. Archiving can fail, and archived conversations remain in your account — they are not deleted.</li>
            <li>These checks use your own model access and can cost credits. The daily cap below limits how many checks run, not how much they cost.</li>
            <li>On an ordinary turn your companion is shown a short note with up to three of these items, including brief summaries. The note lives for that one turn, says when it was taken, and is never prepared for a conversation that Telegram, Discord or another person can read.</li>
            <li>Items disappear on their own once they are finished or out of date. A small fingerprint is kept briefly so the same message is not noticed twice.</li>
          </ul>
        </div>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1 shrink-0" checked={policy.enabled} onChange={(event) => setPolicy(event.target.checked
          ? enabledFollowupPolicy(policy, savedPolicy, Intl.DateTimeFormat().resolvedOptions().timeZone)
          : { ...policy, enabled: false, proactive: false })} /><span>Enable conversational short-term memory</span></label>
        <label className="grid min-w-0 gap-1">Model for noticing
          {models.length > 0
            ? <span className="grid min-w-0 gap-1">
                <ModelPicker value={policy.semanticModel ?? null} models={models} placement="bottom" placeholder="Choose a model…" className="justify-self-start"
                  onChange={(value) => setPolicy({ ...policy, semanticModel: resolveModel(value, models)?.model.handle ?? value })} />
                
                {policy.semanticModel && (() => {
                  const chosen = resolveModel(policy.semanticModel, models)?.model;
                  return <span className="text-xs text-muted">{chosen ? <>{chosen.source?.label ? `${chosen.source.label} · ` : ""}<span className="font-mono">{chosen.handle}</span></> : <>Not in this connection's list: <span className="font-mono">{policy.semanticModel}</span></>}</span>;
                })()}
              </span>
            : <input className="field min-w-0 w-full" value={policy.semanticModel ?? ""} onChange={(event) => setPolicy({ ...policy, semanticModel: event.target.value || null })} placeholder="openai/gpt-4.1-mini" />}
        </label>
        <label className="grid min-w-0 gap-1">Most checks per day (1–200)<input required type="number" min={1} max={200} className="field w-full min-w-0" value={policy.dailyClassifierLimit ?? 40} onChange={(event) => setPolicy({ ...policy, dailyClassifierLimit: Number(event.target.value) })} /></label>
        <TimezoneSelect value={policy.timezone} onChange={(timezone) => setPolicy({ ...policy, timezone })} />
        <p className="text-xs text-muted">Your timezone is how &ldquo;tomorrow at nine&rdquo; is read, against the clock at the moment you sent the message.</p>
        <label className="grid gap-1">Excluded topics (one per line)<textarea className="field min-w-0 w-full" value={policy.topicExclusions.join("\n")} onChange={(event) => setPolicy({ ...policy, topicExclusions: event.target.value.split("\n") })} /></label>
        <div className="grid gap-3 rounded-xl border border-border p-3">
          <p className="font-medium">Timed follow-ups (separate, off by default)</p>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1 shrink-0" disabled={!policy.enabled} checked={policy.proactive} onChange={(event) => setPolicy({ ...policy, proactive: event.target.checked })} /><span>Let my companion bring something up on its own, in this app's private chat</span></label>
          <p className="text-xs text-muted">This runs your companion's model and may use credits. It appears only here, never in Telegram or Discord, with new dispatches only while Hearthside is running on this computer (including in the tray). Quitting does not cancel work already accepted by the runtime. If replies are set to run on another computer, timed follow-ups stay paused.</p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="grid min-w-0 gap-1">Quiet hours start<input required type="time" className="field min-w-0 w-full" value={policy.quietStart} onChange={(event) => setPolicy({ ...policy, quietStart: event.target.value })} /></label>
            <label className="grid min-w-0 gap-1">Quiet hours end<input required type="time" className="field min-w-0 w-full" value={policy.quietEnd} onChange={(event) => setPolicy({ ...policy, quietEnd: event.target.value })} /></label>
          </div>
          <label className="grid gap-1">Most follow-ups per day (1–5)<input required type="number" min={1} max={5} className="field w-full min-w-0" value={policy.dailyLimit} onChange={(event) => setPolicy({ ...policy, dailyLimit: Number(event.target.value) })} /></label>
        </div>
        {consentRequired && <label className="flex items-start gap-2 rounded-xl border border-border p-3 text-xs text-ink-800">
          <input type="checkbox" checked={acknowledgedFor === consentKey} onChange={(event) => setAcknowledgedFor(event.target.checked ? consentKey : null)} className="mt-0.5 shrink-0" />
          <span>I understand that noticing sends message text and kept summaries to the selected model, can use credits, and creates check conversations that are archived, not deleted. If I enable timed follow-ups, they can send messages in this chat using my companion's model.</span>
        </label>}
        <div className="flex flex-wrap gap-2"><button className="button-primary" type="submit" disabled={consentMissing}>Save settings</button><button className="button-secondary" type="button" disabled={!savedPolicy?.enabled || policyDirty} onClick={() => void run(async () => { const result = await window.bridge.scanFollowups(agentId, conversationId); if (alive.current) setNotice(`Caught up on ${result.scanned} messages; kept ${result.proposed} new things in mind.`); })}>Catch up on recent messages</button></div>
        {policyDirty && <p className="text-xs text-muted">Save your changes before catching up on recent messages.</p>}
      </fieldset>
    </form></div>
    {loaded && items.length === 0 && <p className="text-muted">No follow-ups in this conversation.</p>}
    <ul className="grid min-w-0 gap-3">{items.map((item) => {
      const closed = ["resolved", "cancelled", "expired"].includes(item.lifecycle);
      return <li key={item.id} className="grid min-w-0 gap-2 rounded-xl border border-border p-3 [overflow-wrap:anywhere]">
        <h4 className="font-medium">{item.summary}</h4><p>{item.action}</p>
        <p className="text-xs text-muted">{originLine(item)}</p>
        <p className="text-xs text-muted">{item.lifecycle} · Dispatch: {item.dispatch}</p>
        <details><summary className="cursor-pointer text-xs">Inspect provenance and timing</summary><dl className="mt-2 grid gap-1 text-xs text-muted">{Object.entries({ ID: item.id, Revision: item.revision, "Source message": item.sourceMessageId, "Source time": item.sourceAt, "Event time": item.eventAt ?? "None", "Not before": item.notBefore ?? "None", Expires: item.expiresAt, Timezone: item.timezone }).map(([key, value]) => <div key={key}><dt className="font-medium">{key}</dt><dd>{value}</dd></div>)}</dl></details>
        {!closed && <div className="flex flex-wrap gap-2">
          {item.lifecycle === "candidate" && <button disabled={busy} className="button-primary" onClick={() => void change(item, "adopt")}>Activate</button>}
          <button disabled={busy} className="button-secondary" onClick={() => { setEditing(item); setSummary(item.summary); setAction(item.action); setNotBefore(item.notBefore ?? ""); setExpiresAt(item.expiresAt); }}>Edit</button>
          <button disabled={busy} className="button-secondary" onClick={() => { setReminding(reminding === item.id ? null : item.id); setDeferUntil(""); }}>Remind later</button>
          {reminding === item.id && <fieldset disabled={busy} className="grid w-full gap-2"><legend>Remind later: {item.summary}</legend>
            <button type="button" className="button-secondary justify-self-start" onClick={() => void run(async () => { await window.bridge.changeFollowup(agentId, conversationId, item.id, item.revision, "defer", tomorrowMorning(policy.timezone)); })}>Tomorrow · 09:00 ({policy.timezone})</button>
            <ZonedDateTime key={item.id} label="Choose date and time" value={deferUntil} timezone={policy.timezone} onChange={setDeferUntil} />
            <button disabled={!isExplicitInstant(deferUntil)} className="button-secondary justify-self-start" onClick={() => void change(item, "defer")}>Save reminder time</button>
          </fieldset>}
          <button disabled={busy} className="button-secondary" onClick={() => void change(item, "resolve")}>Resolve</button>
          <button disabled={busy} className="button-secondary" onClick={() => void change(item, "cancel")}>Dismiss</button>
        </div>}
      </li>;
    })}</ul>
    <details open={editing !== null || manualOpen} onToggle={(event) => setManualOpen(event.currentTarget.open)}><summary className="cursor-pointer font-medium">{editing ? "Edit follow-up" : "Create a follow-up"}</summary><form onSubmit={(event) => { event.preventDefault(); void run(async () => {
      if (notBefore && Date.parse(expiresAt) <= Date.parse(notBefore)) throw new Error("Expiry must be after the start.");
      const patch = { summary: summary.trim(), action: action.trim(), notBefore: notBefore ? iso(notBefore) : null, expiresAt: iso(expiresAt), timezone: policy.timezone };
      if (editing) await window.bridge.updateFollowup(agentId, conversationId, editing.id, editing.revision, patch);
      else { const input: FollowupCreate = { ...patch, eventAt: null, sourceMessageId: "manual", sourceAt: new Date().toISOString() }; await window.bridge.createFollowup(agentId, conversationId, input); }
      if (alive.current) resetForm();
    }); }}>
      <fieldset disabled={busy || !loaded} className="grid min-w-0 gap-3 border-t border-border pt-4">
        <legend className="font-medium">{editing ? "Edit follow-up" : "Create a follow-up"}</legend>
        <label className="grid gap-1">Summary<input required className="field w-full min-w-0" value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
        <label className="grid gap-1">Action<textarea required className="field w-full min-w-0" value={action} onChange={(event) => setAction(event.target.value)} /></label>
        <ZonedDateTime key={`start-${editing?.id}-${formVersion}-${policy.timezone}`} label="Not before (optional)" value={notBefore} timezone={policy.timezone} onChange={setNotBefore} />
        <ZonedDateTime key={`expiry-${editing?.id}-${formVersion}-${policy.timezone}`} label="Expires at" required value={expiresAt} timezone={policy.timezone} onChange={setExpiresAt} />
        <div className="flex flex-wrap gap-2"><button className="button-primary" disabled={!summary.trim() || !action.trim()}>{editing ? "Save edit" : "Create"}</button>{editing && <button type="button" className="button-secondary" onClick={resetForm}>Discard edit</button>}</div>
      </fieldset>
    </form></details>
  </section>;
}
