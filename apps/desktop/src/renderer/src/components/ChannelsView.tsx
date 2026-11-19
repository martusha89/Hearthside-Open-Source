import { useCallback, useEffect, useRef, useState } from "react";
import { BrandLogo, brandFor } from "./BrandLogo";
import { useAppStore } from "../store";
import type { ChannelAccess, ChannelAccount, ChannelBotReassign, ChannelChatMode, MutedChannel, ChannelField, ChannelInfo, ChannelPairing, ChannelRoute } from "../types";
import { ChevronRightIcon, Spinner } from "./icons";
import { channelServiceCameUp, groupChannelBots, pairingsForOwnBots } from "../lib/channel-bots";

/**
 * Hearthside: Telegram and Discord. Connect a bot to the agent, approve who
 * may talk to it, and see the chats it's in. Channels run while Hearthside
 * runs (closing the window keeps them going in the tray).
 *
 * Each bot belongs to one companion (docs/AGENT-OWNED-BOTS.md). This page
 * shows the chosen companion's own bots, then any bot still waiting to be
 * assigned, then — named and read-only — the bots belonging to other
 * companions, so it is always clear whose bot is whose. The main process
 * checks the owner on every change, so what is shown here is for reading, not
 * what makes a change allowed.
 */

const HOW_TO: Record<string, string[]> = {
  telegram: [
    "In Telegram, open a chat with @BotFather and send /newbot.",
    "Pick a name and a username for the bot.",
    "BotFather replies with a token. Paste it below.",
  ],
  discord: [
    "Go to discord.com/developers/applications and create a New Application.",
    "Under Bot: Reset Token and copy it; turn on Message Content Intent.",
    "Under OAuth2 → URL Generator: tick bot, then Send Messages and Read Message History; open the link to add the bot to your server.",
  ],
};

const POLICIES: Array<{ id: ChannelAccess; label: string; detail: string }> = [
  { id: "just-me", label: "Just me (recommended)", detail: "The first person whose DM you approve becomes the only person allowed to DM. Other DMs are turned away." },
  { id: "pairing", label: "People I approve", detail: "Each new person who DMs gets a pairing code; you approve or decline them here. Group messages do not request pairing." },
  { id: "open", label: "Anyone", detail: "Anyone who finds the bot can DM your agent without approval." },
];

function MessageScopeNotice() {
  return (
    <p className="text-xs text-muted">
      These choices control direct messages (DMs). “Just me” does not by itself make groups or servers private.
      Group and server access follows separate sender and channel rules; those rules may also use the approved-person list.
    </p>
  );
}

/** "Answers in 9 channels across 2 servers", or "2 connected chats". */
function chatsSummary(chats: ChannelRoute[]): string {
  const servers = new Set(chats.map((route) => route.label?.split(" · ")[1]).filter(Boolean));
  const channels = chats.filter((route) => route.chatType === "channel").length;
  const direct = chats.length - channels;
  const parts: string[] = [];
  if (channels) parts.push(`${channels} ${channels === 1 ? "channel" : "channels"}${servers.size ? ` across ${servers.size} ${servers.size === 1 ? "server" : "servers"}` : ""}`);
  if (direct) parts.push(`${direct} ${direct === 1 ? "direct chat" : "direct chats"}`);
  return `Answers in ${parts.join(" and ")} ·`;
}

// Hearthside: the service behind every bot here, with the way back when it's down.
function ChannelServiceLine() {
  const status = useAppStore((state) => state.channelService);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  if (!status || status.state === "off") return null;
  const down = status.state === "failed" || status.state === "blocked";
  const retryIn = down && status.nextRetryAt ? Math.max(0, Math.ceil((status.nextRetryAt - now) / 1_000)) : null;
  const recover = () => {
    setBusy(true);
    setFailure(null);
    window.bridge.recoverChannelService().catch((error: unknown) => setFailure(errorText(error))).finally(() => setBusy(false));
  };
  return (
    <div role="status" className={`grid gap-1 rounded-xl px-3.5 py-2.5 text-xs ${down ? "bg-error-light text-error" : "bg-surface-secondary text-muted"}`}>
      {status.state === "starting" && <span className="flex items-center gap-2"><Spinner className="h-3 w-3" /> Channel service starting…</span>}
      {status.state === "running" && <span>Channel service running{status.recovered ? " · recovered after an unclean exit" : ""}</span>}
      {down && (
        <>
          <span className="font-medium">{status.state === "blocked" ? "Channel service blocked" : "Channel service stopped"}</span>
          {status.reason && <span className="break-words">{status.reason}</span>}
          <span className="flex items-center gap-3">
            {retryIn !== null && <span>Retrying in {retryIn}s</span>}
            <button type="button" disabled={busy} className="font-medium underline disabled:opacity-50" onClick={recover}>
              {status.state === "blocked" ? "Recover" : "Try now"}
            </button>
          </span>
          {failure && <span className="break-words">{failure}</span>}
        </>
      )}
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function FieldInput({ field, value, onChange }: { field: ChannelField; value: unknown; onChange: (value: unknown) => void }) {
  if (field.type === "boolean") {
    return (
      <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-800">
        <input type="checkbox" className="accent-[var(--color-accent)]" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        {field.label}
      </label>
    );
  }
  return (
    <label className="grid gap-1">
      <span className="text-xs font-medium text-ink-700">
        {field.label}
        {!field.required && <span className="font-normal text-muted"> (optional)</span>}
      </span>
      {field.type === "select" ? (
        <select value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} className="field text-sm">
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === "secret" ? "password" : field.type === "number" ? "number" : "text"}
          autoComplete="off"
          spellCheck={false}
          value={String(value ?? "")}
          placeholder={field.placeholder || undefined}
          onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)}
          className="field font-mono text-sm"
        />
      )}
      {field.description && <span className="text-[11px] text-muted">{field.description}</span>}
    </label>
  );
}

function ConnectForm({ channel, agentId, onDone }: { channel: ChannelInfo; agentId: string; onDone: () => void }) {
  const fields = channel.fields.filter((field) => field.scope === "account" && field.type !== "key-value-map" && field.type !== "string-array");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [name, setName] = useState("");
  const [policy, setPolicy] = useState<ChannelAccess>("just-me");
  const [botAmbient, setBotAmbient] = useState(true);
  const [botMentions, setBotMentions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete = fields.every((field) => !field.required || String(values[field.key] ?? "").trim());

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "" && value !== undefined));
      await window.bridge.setupChannel({ channelId: channel.id, agentId, name, access: policy, config,
        ...(channel.id === "discord" ? { companionParticipation: { version: 1 as const, ambient: botAmbient, mentions: botMentions } } : {}) });
      onDone();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !busy) void connect();
      }}
    >
      <ol className="grid list-decimal gap-1 pl-5 text-xs text-ink-700">
        {(HOW_TO[channel.id] ?? []).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <label className="grid gap-1">
        <span className="text-xs font-medium text-ink-700">
          Name <span className="font-normal text-muted">(optional)</span>
        </span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={`My ${channel.name} bot`} className="field text-sm" />
      </label>
      {fields.map((field) => (
        <FieldInput key={field.key} field={field} value={values[field.key]} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />
      ))}
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-xs font-medium text-ink-700">Who can DM it</legend>
        {POLICIES.map((item) => (
          <label key={item.id} className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="radio" name={`${channel.id}-policy`} className="mt-1 accent-[var(--color-accent)]" checked={policy === item.id} onChange={() => setPolicy(item.id)} />
            <span>
              <span className="block text-ink-900">{item.label}</span>
              <span className="block text-xs text-muted">{item.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {channel.id === "discord" && <fieldset className="grid gap-1.5">
        <legend className="text-xs font-medium text-ink-700">Other companion bots in shared rooms</legend>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={botAmbient} onChange={event => setBotAmbient(event.target.checked)} />Notice untagged messages</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={botMentions} onChange={event => setBotMentions(event.target.checked)} />Notice explicit mentions</label>
        <span className="text-xs text-muted">Both start on. The companion may reply, react (subject to Discord permissions), or stay silent, and only in rooms you authorize. Safeguard: 12 bot inputs per room in two minutes, then an automatically expiring 30-second pause.</span>
      </fieldset>}
      <MessageScopeNotice />
      {error && <p className="break-words text-xs text-error">{error}</p>}
      <div>
        <button type="submit" className="button-primary" disabled={!complete || busy}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Connect
        </button>
      </div>
    </form>
  );
}

function ChannelCard({
  channel,
  agentId,
  agentName,
  nameOf,
  routes,
  onChanged,
}: {
  channel: ChannelInfo;
  agentId: string;
  agentName: string;
  nameOf: (id: string | null) => string;
  routes: ChannelRoute[];
  onChanged: () => void;
}) {
  const openChat = useAppStore((state) => state.openChat);
  const [accounts, setAccounts] = useState<ChannelAccount[] | null>(null);
  const [pairings, setPairings] = useState<ChannelPairing[]>([]);
  const [muted, setMuted] = useState<MutedChannel[]>([]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from `error`: a failed look at the bots is cleared by the next
  // look that works, while a failed change stays until the next change is tried.
  // Sharing one message meant a lost connection's error stayed on the card
  // after the bots were back, and clearing it on every look would wipe out
  // "that didn't work" five seconds after it appeared.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moving, setMoving] = useState<ChannelBotReassign | null>(null);

  // Which companion's page these lists are for. Everything here is asked for one
  // companion, and the answer can arrive after someone has switched to another —
  // so each reply is checked against what is on screen now and dropped if it is
  // about the companion that was selected a moment ago.
  const shownFor = useRef(`${channel.id}:${agentId}`);

  const refresh = useCallback(async () => {
    const asked = `${channel.id}:${agentId}`;
    try {
      const [nextAccounts, nextPairings] = await Promise.all([window.bridge.listChannelAccounts(channel.id, agentId), window.bridge.listPairings(channel.id, agentId)]);
      if (shownFor.current !== asked) return;
      setAccounts(nextAccounts);
      setPairings(nextPairings);
      setLoadError(null);
      if (channel.id === "discord") {
        const lists = await Promise.all(
          nextAccounts
            .filter((account) => account.ownerAgentId === agentId && account.here)
            .map((account) => window.bridge.listMutedChannels(account.accountId, agentId).catch(() => [] as MutedChannel[])),
        );
        if (shownFor.current !== asked) return;
        setMuted(lists.flat());
      }
    } catch (failure) {
      if (shownFor.current !== asked) return;
      setLoadError(errorText(failure));
    }
  }, [channel.id, agentId]);

  useEffect(() => {
    shownFor.current = `${channel.id}:${agentId}`;
    // Start from nothing: no bot, request or part-finished move from the previous
    // companion stays on screen while this companion's are being fetched.
    setAccounts(null);
    setPairings([]);
    setMuted([]);
    setMoving(null);
    setError(null);
    setLoadError(null);
    void refresh();
    // New pairing requests arrive while the page is open.
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh, channel.id, agentId]);

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await refresh();
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const chats = routes.filter((route) => route.channelId === channel.id &&
    !muted.some((item) => item.accountId === route.accountId && item.chatId === route.chatId));
  // Whose bot is whose: this companion's here, the ones nobody has claimed, this
  // companion's belonging to another connection, then other companions' (shown so
  // they can be recognised and moved, not changed).
  const { mine, unclaimed, elsewhere, others } = groupChannelBots(accounts, agentId);
  // Only requests waiting on a bot this companion owns here.
  const waiting = pairingsForOwnBots(pairings, mine);
  // Folded by default; opens by itself while someone is waiting to be approved.
  const shown = open || waiting.length > 0;
  return (
    <section className="grid gap-3 rounded-2xl border border-border p-4">
      <button type="button" className="flex items-center justify-between gap-2 text-left" aria-expanded={shown} aria-label={`${channel.name} details`} onClick={() => setOpen(!shown)}>
        <span className="flex items-center gap-3">
          <BrandLogo brand={brandFor(channel.id, channel.name)} label={channel.name} />
          <h2 className="text-sm font-semibold text-ink-900">{channel.name}</h2>
          {waiting.length > 0 && (
            <span className="rounded-md bg-accent-subtle px-1.5 py-0.5 text-[11px] text-ink-800">{waiting.length} waiting for you</span>
          )}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted">
          {accounts === null ? "" : mine.length === 0 ? "Not set up" : mine.some((account) => account.running) ? "Running" : "Stopped"}
          <ChevronRightIcon className={`h-4 w-4 transition-transform ${shown ? "rotate-90" : ""}`} />
        </span>
      </button>
      {shown && (
        <>

      {mine.map((account) => {
        const held = account.unfinishedMove
          ? "This bot's move to another companion didn't finish. Finish it or put it back first."
          : account.conflict
            ? "Hearthside and Letta disagree about whose bot this is, so it's held until that's sorted out."
            : null;
        return (
        <div key={account.accountId} className="grid gap-2 rounded-xl bg-surface-secondary px-3 py-2">
        <div className="flex items-center gap-3">
          <span className={`h-2 w-2 shrink-0 rounded-full ${account.running ? "bg-success" : "bg-muted-light"}`} />
          <span className="min-w-0 flex-1 truncate text-sm text-ink-900">{account.name}</span>
          {/* A bot that is held — its move didn't finish, or Hearthside and the
              runtime disagree about whose it is — can't be changed until that is
              sorted out, so the buttons say so instead of failing when pressed. */}
          <button
            type="button"
            className="button-secondary"
            disabled={busy !== null || held !== null}
            title={held ?? undefined}
            onClick={() => void act(`run-${account.accountId}`, () => window.bridge.setChannelAccountRunning(channel.id, account.accountId, !account.running, agentId))}
          >
            {account.running ? "Stop" : "Start"}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={busy !== null || held !== null}
            title={held ?? undefined}
            onClick={() => void act(`rm-${account.accountId}`, () => window.bridge.removeChannelAccount(channel.id, account.accountId, agentId))}
          >
            Remove
          </button>
        </div>
        {account.unfinishedMove && (
          <div role="alert" className="grid gap-2 rounded-xl border border-accent/30 px-3 py-2 text-xs">
            <span className="text-ink-800">
              This bot was being moved to {nameOf(account.unfinishedMove.toAgentId)} and the move didn't finish, so it's switched off and
              nothing will start it. Finish the move, or put it back with {nameOf(account.unfinishedMove.fromAgentId)}. Either way you choose
              when it starts answering again.
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="button-primary"
                disabled={busy !== null}
                onClick={() => void act(`finish-${account.accountId}`, () => window.bridge.resumeChannelBotMove(channel.id, account.accountId, "finish"))}
              >
                Finish moving it to {nameOf(account.unfinishedMove.toAgentId)}
              </button>
              <button
                type="button"
                className="button-secondary"
                disabled={busy !== null || account.unfinishedMove.fromAgentId === null}
                title={account.unfinishedMove.fromAgentId === null ? "This bot didn't belong to a companion before the move, so there's nothing to put it back to." : undefined}
                onClick={() => void act(`undo-${account.accountId}`, () => window.bridge.resumeChannelBotMove(channel.id, account.accountId, "undo"))}
              >
                Put it back
              </button>
            </div>
          </div>
        )}
        {!account.unfinishedMove && account.conflict && (
          <p role="alert" className="text-xs text-error">
            Hearthside has this bot down as {agentName}'s, but Letta is sending its messages to {nameOf(account.boundAgentId)}. It's switched
            off until that's sorted out: give it to {agentName} again to point Letta back, or move it to {nameOf(account.boundAgentId)}.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-700">
          <span className="text-muted">Who can DM it:</span>
          <select
            value={account.access}
            disabled={busy !== null || held !== null}
            title={held ?? undefined}
            aria-label={`Who can DM ${account.name}`}
            onChange={(event) =>
              void act(`access-${account.accountId}`, () =>
                window.bridge.setChannelAccess(channel.id, account.accountId, event.target.value as ChannelAccess, account.allowedUsers, agentId),
              )
            }
            className="field py-1 text-xs"
          >
            {POLICIES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label.replace(" (recommended)", "")}
              </option>
            ))}
          </select>
          {account.access === "just-me" && account.allowedUsers.length === 0 && <span className="text-muted">Waiting for you to approve the first person's DM.</span>}
        </div>
        <MessageScopeNotice />
        {channel.id === "discord" && (
          <div className="grid gap-1 text-xs text-ink-700">
            <fieldset className="grid gap-1.5 rounded-lg border border-border px-3 py-2">
              <legend className="px-1 font-medium text-ink-800">Other companion bots in shared rooms</legend>
              {account.companionParticipation.mode === "legacy" && <p className="text-muted">Legacy settings are unchanged. A legacy sidecar's bot/channel allowlist is not represented by these checkboxes and remains in force; changing either control explicitly migrates this account to the new policy.</p>}
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]"
                  checked={account.companionParticipation.ambient} disabled={busy !== null || held !== null}
                  onChange={(event) => void act(`ambient-${account.accountId}`, () => window.bridge.setDiscordCompanionParticipation(account.accountId,
                    { version: 1, ambient: event.target.checked, mentions: account.companionParticipation.mentions }, agentId))} />
                <span><span className="block text-ink-900">Notice untagged messages</span><span className="text-muted">May reply, react, or stay silent. Only rooms already allowed below are included.</span></span>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]"
                  checked={account.companionParticipation.mentions} disabled={busy !== null || held !== null}
                  onChange={(event) => void act(`mentions-${account.accountId}`, () => window.bridge.setDiscordCompanionParticipation(account.accountId,
                    { version: 1, ambient: account.companionParticipation.ambient, mentions: event.target.checked }, agentId))} />
                <span><span className="block text-ink-900">Notice explicit mentions</span><span className="text-muted">A mention is context, not a command to answer.</span></span>
              </label>
              <span className="text-muted">Safeguard: 12 bot inputs per room in two minutes, then a 30-second pause that expires automatically.</span>
              {account.companionParticipation.reactions && <span className="text-muted">The Discord runtime exposes reaction actions, subject to a valid message target and the bot's Discord permissions; a reaction is not guaranteed for every trigger.</span>}
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted">Server messages go to:</span>
              <select
                value={account.chatMode}
                disabled={busy !== null || held !== null}
                title={held ?? undefined}
                aria-label={`Where ${account.name}'s server messages go`}
                onChange={(event) =>
                  void act(`mode-${account.accountId}`, () => window.bridge.setChannelChatMode(account.accountId, event.target.value as ChannelChatMode, agentId))
                }
                className="field w-auto py-1 text-xs"
              >
                <option value="main">The main chat</option>
                <option value="server">One chat per Discord server</option>
                <option value="channel">One chat per channel or thread</option>
              </select>
            </div>
            {account.chatMode !== "channel" && (
              <span className="text-muted">
                Whether the bot needs a mention follows each channel's listening policy; some channels allow replies without a mention.
                A brand-new Discord thread can start its own chat; it stays there with its history.
              </span>
            )}
            <span className="text-muted">
              Changing this moves your server channels over once no reply is in progress. Earlier messages stay where they are; nothing is archived.
            </span>
          </div>
        )}
        {account.allowedUsers.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted">Allowed:</span>
            {account.allowedUsers.map((user) => (
              <span key={user} className="flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 font-mono text-ink-800">
                {user}
                <button
                  type="button"
                  aria-label={`Remove ${user}`}
                  title={held ?? "Remove from the allowed-person list (DM and restrictive group rules may use this list)"}
                  disabled={busy !== null || held !== null}
                  className="text-muted hover:text-error"
                  onClick={() =>
                    void act(`unallow-${user}`, () =>
                      window.bridge.setChannelAccess(channel.id, account.accountId, account.access, account.allowedUsers.filter((item) => item !== user), agentId),
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        </div>
        );
      })}

      {unclaimed.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-ink-700">Not assigned to a companion yet</span>
          <p className="text-xs text-muted">
            {unclaimed.length === 1 ? "This bot was" : "These bots were"} set up before bots belonged to a particular companion, so
            Hearthside doesn't know who {unclaimed.length === 1 ? "it" : "they"} should answer for. {unclaimed.length === 1 ? "It stays" : "They stay"} switched
            off until you say — nothing is assigned on its own, not even to the companion you happen to have open. Giving a bot to a
            companion doesn't start it either; you do that afterwards.
          </p>
          {unclaimed.map((account) => (
            <div key={account.accountId} className="grid gap-1 rounded-xl bg-surface-secondary px-3 py-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-ink-900">{account.name}</span>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy !== null || !account.claimable}
                  title={account.claimable ? `Let ${agentName} answer on this bot` : `This bot is set up for ${account.connectionLabel ?? "another connection"}; open Hearthside there to assign it.`}
                  onClick={() => void act(`claim-${account.accountId}`, () => window.bridge.claimChannelBot(channel.id, account.accountId, agentId))}
                >
                  Give it to {agentName}
                </button>
              </div>
              {/* Letta's own binding, offered as a hint and nothing more: on
                  Telegram it can come from a chat someone approved on the wrong
                  page, so it is never acted on without being asked. */}
              {account.boundAgentId && (
                <span className="text-xs text-muted">
                  Letta currently sends its messages to {nameOf(account.boundAgentId)}. Claiming checks its existing chats too; it won't
                  silently move another companion's chats. To change its owner, claim it for its existing companion first, then reassign it.
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {elsewhere.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-ink-700">{agentName}'s bots on another setup</span>
          <p className="text-xs text-muted">
            {elsewhere.length === 1 ? "This bot belongs" : "These bots belong"} to {agentName} on another connection, so
            {elsewhere.length === 1 ? " it isn't" : " they aren't"} running here and can't be changed from here. A bot only ever polls in
            one place. Open Hearthside on that connection to change {elsewhere.length === 1 ? "it" : "them"}.
          </p>
          {elsewhere.map((account) => (
            <div key={account.accountId} className="flex items-center gap-3 rounded-xl bg-surface-secondary px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink-800">{account.name}</span>
              <span className="rounded-md bg-surface-tertiary px-1.5 py-0.5 text-[11px] text-muted">
                For {account.connectionLabel ?? "another connection"}
              </span>
            </div>
          ))}
        </div>
      )}

      {others.length > 0 && (
        <details className="group grid gap-1.5">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted hover:text-ink-800">
            <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            {others.length} {others.length === 1 ? "bot belongs" : "bots belong"} to your other companions
          </summary>
          <p className="text-xs text-muted">
            These keep answering for their own companion. You can't change them from {agentName}'s page — open that companion's
            channels instead, or move a bot over here.
          </p>
          {others.map((account) => (
            <div key={account.accountId} className="grid gap-1.5 rounded-xl bg-surface-secondary px-3 py-2">
              <div className="flex items-center gap-3 text-sm">
                <span className={`h-2 w-2 shrink-0 rounded-full ${account.running ? "bg-success" : "bg-muted-light"}`} />
                <span className="min-w-0 flex-1 truncate text-ink-800">
                  {account.name}
                  <span className="text-xs text-muted"> · answers for {nameOf(account.ownerAgentId)}</span>
                </span>
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy !== null || !account.here || account.unfinishedMove !== null}
                  title={
                    account.unfinishedMove
                      ? "A move of this bot didn't finish. Its own companion's page can finish it or put it back."
                      : account.here
                        ? undefined
                        : `This bot is set up for ${account.connectionLabel ?? "another connection"}.`
                  }
                  onClick={() => void act(`move-${account.accountId}`, async () => {
                    setMoving(await window.bridge.previewChannelBotReassign(channel.id, account.accountId, agentId));
                  })}
                >
                  Move to {agentName}…
                </button>
              </div>
              {/* What is confirmed is what the preview said, not what happens to
                  be selected when the button is pressed: the companion it came
                  from, the companion it goes to and the connection all travel
                  with the request, and the main process refuses the move if any
                  of them has changed since. */}
              {moving?.accountId === account.accountId && (
                <div role="alert" className="grid gap-2 rounded-xl border border-accent/30 px-3 py-2 text-xs">
                  <span className="text-ink-800">
                    Move <span className="font-medium">{account.name}</span> from {nameOf(moving.fromAgentId)} to {nameOf(moving.toAgentId)}?
                    {" "}
                    {moving.movingRoutes === 0
                      ? "It has no connected chats yet."
                      : `Its ${moving.movingRoutes} connected ${moving.movingRoutes === 1 ? "chat comes" : "chats come"} across too, so the people in ${moving.movingRoutes === 1 ? "it" : "them"} will be talking to ${nameOf(moving.toAgentId)} from then on.`}
                    {" "}
                    {nameOf(moving.fromAgentId)} stops answering on this bot.
                    {moving.resetChats > 0 && (
                      <>
                        {" "}
                        {moving.resetChats === 1 ? "One of those chats has" : `${moving.resetChats} of those chats have`} their own chat
                        with {nameOf(moving.fromAgentId)}; {moving.resetChats === 1 ? "it carries on" : "they carry on"} in
                        {" "}{nameOf(moving.toAgentId)}'s main chat instead. What was said before stays with {nameOf(moving.fromAgentId)} and
                        isn't moved or shown to {nameOf(moving.toAgentId)}.
                      </>
                    )}
                    {" "}
                    {moving.running ? "The bot is switched off while this happens, then started again." : "The bot stays switched off."}
                  </span>
                  <div className="flex items-center gap-2">
                    <button type="button" className="button-secondary" disabled={busy !== null} onClick={() => setMoving(null)}>
                      Keep it where it is
                    </button>
                    <button
                      type="button"
                      className="button-primary"
                      disabled={busy !== null}
                      onClick={() => void act(`moved-${account.accountId}`, async () => {
                        await window.bridge.reassignChannelBot({
                          channelId: moving.channelId,
                          accountId: moving.accountId,
                          fromAgentId: moving.fromAgentId,
                          toAgentId: moving.toAgentId,
                          connection: moving.connection,
                        });
                        setMoving(null);
                      })}
                    >
                      Move it to {nameOf(moving.toAgentId)}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </details>
      )}

      {waiting.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-ink-700">Waiting for your approval</span>
          {waiting.map((pairing) => (
            <div key={pairing.code} className="flex items-center gap-3 rounded-xl border border-accent/30 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="text-ink-900">{pairing.senderName || "Someone"}</span>
                {/* Name the bot as well: only this companion's bots are listed, and the
                    chat is bound to that bot's companion whatever is selected. */}
                <span className="text-xs text-muted">
                  {" "}messaged {accounts?.find((account) => account.accountId === pairing.accountId)?.name ?? "your bot"} and
                  wants to talk to {agentName} (code {pairing.code})
                </span>
              </span>
              <button
                type="button"
                className="button-secondary"
                disabled={busy !== null}
                onClick={() => void act(`decline-${pairing.code}`, () => window.bridge.declinePairing(pairing.code))}
              >
                Decline
              </button>
              <button
                type="button"
                className="button-primary"
                disabled={busy !== null}
                onClick={() => void act(`pair-${pairing.code}`, () => window.bridge.approvePairing({ channelId: channel.id, accountId: pairing.accountId, code: pairing.code, agentId }))}
              >
                Approve
              </button>
            </div>
          ))}
        </div>
      )}

      {chats.length > 0 && (
        <details className="group grid gap-1.5">
          {/* Folded to one line: a long list of channels all going to the same chat says little. */}
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted hover:text-ink-800">
            <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            {chatsSummary(chats)}
            <span className="text-accent">Manage</span>
          </summary>
          {chats.map((route) => (
            <div key={`${route.accountId}:${route.chatId}`} className="flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate text-ink-800" title={route.chatId}>
                {route.label ?? (
                  <>
                    {route.chatType === "channel" ? "Channel" : "Direct chat"} <span className="font-mono text-xs text-muted">{route.chatId}</span>
                  </>
                )}
                <span className="text-xs text-muted"> → {route.conversationId === "default" ? "main chat" : "its own chat"}</span>
                {/* A chat that comes to this companion on someone else's bot: say so
                    rather than leaving it a puzzle. Approving from the wrong page used
                    to make exactly this, so it is worth naming. */}
                {others.some((account) => account.accountId === route.accountId) && (
                  <span className="text-xs text-muted"> · arrives on {nameOf(others.find((account) => account.accountId === route.accountId)?.ownerAgentId ?? null)}'s bot</span>
                )}
              </span>
              <button type="button" className="text-xs text-accent hover:underline" onClick={() => openChat(route.conversationId === "default" ? `main:${agentId}` : route.conversationId)}>
                Open chat
              </button>
              {channel.id === "discord" && route.threadId ? (
                <span className="text-xs text-muted" title="Turn off the parent server channel to stop replies in its threads">Follows parent channel</span>
              ) : <button
                type="button"
                className="text-xs text-muted hover:text-error hover:underline"
                disabled={busy !== null}
                title={channel.id === "discord" && route.chatType === "channel" ? "The bot stops answering in this channel, even when mentioned" : "Disconnect this chat"}
                onClick={() =>
                  void act(`route-${route.chatId}`, () =>
                    channel.id === "discord" && route.chatType === "channel"
                      ? window.bridge.setDiscordChannelListening(route.accountId, route.chatId, false, agentId)
                      : window.bridge.removeChannelRoute(channel.id, route.accountId, route.chatId, agentId),
                  )
                }
              >
                {channel.id === "discord" && route.chatType === "channel" ? "Turn off" : "Disconnect"}
              </button>}
            </div>
          ))}
        </details>
      )}

      {channel.id === "discord" && muted.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-ink-700">Not answering in</span>
          {muted.map((item) => (
            <div key={`${item.accountId}:${item.chatId}`} className="flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate text-muted" title={item.chatId}>
                {item.label ?? <span className="font-mono text-xs">{item.chatId}</span>}
              </span>
              <button
                type="button"
                className="text-xs text-accent hover:underline"
                disabled={busy !== null}
                onClick={() => void act(`listen-${item.chatId}`, () => window.bridge.setDiscordChannelListening(item.accountId, item.chatId, true, agentId))}
              >
                Turn back on
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <ConnectForm
          channel={channel}
          agentId={agentId}
          onDone={() => {
            setAdding(false);
            void refresh();
            onChanged();
          }}
        />
      ) : (
        <div>
          <button type="button" className={mine.length ? "button-secondary" : "button-primary"} onClick={() => setAdding(true)}>
            {mine.length ? `Connect another bot for ${agentName}` : `Connect a ${channel.name} bot for ${agentName}`}
          </button>
        </div>
      )}
        </>
      )}
      {(error ?? loadError) && <p className="break-words text-xs text-error">{error ?? loadError}</p>}
    </section>
  );
}

export function ChannelsView() {
  const agentId = useAppStore((state) => state.agentId);
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === state.agentId)?.name ?? "Your agent");
  const agents = useAppStore((state) => state.agents);
  const backend = useAppStore((state) => state.connection?.backend);
  // A bot can belong to a companion that isn't in this list (another connection's).
  const nameOf = useCallback((id: string | null) => agents.find((agent) => agent.id === id)?.name ?? "another companion", [agents]);
  const [channels, setChannels] = useState<ChannelInfo[] | null>(null);
  const [routes, setRoutes] = useState<ChannelRoute[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!agentId) return;
    try {
      const [list, chatRoutes] = await Promise.all([window.bridge.listChannels(), window.bridge.listChannelRoutes(agentId)]);
      setChannels(list);
      setRoutes(chatRoutes);
      // It worked, so whatever went wrong last time is no longer true.
      setError(null);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [agentId]);

  useEffect(() => {
    if (backend !== "remote") void refresh();
  }, [refresh, backend]);

  // The page used to ask once, when it opened. Opened while the channel service
  // was down, it showed that error and no bots, and went on showing it after
  // "Recover" or "Try now" had brought the service back — until you left the
  // page and came back. So it asks again whenever the service comes up.
  const serviceState = useAppStore((state) => state.channelService?.state ?? null);
  const lastServiceState = useRef(serviceState);
  useEffect(() => {
    const previous = lastServiceState.current;
    lastServiceState.current = serviceState;
    if (backend !== "remote" && channelServiceCameUp(previous, serviceState)) void refresh();
  }, [serviceState, refresh, backend]);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface">
      <header className="app-drag flex h-12 shrink-0 items-center justify-center border-b border-border px-6">
        <span className="truncate text-sm font-medium text-ink-700">{agentName} on Telegram and Discord</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl gap-4 px-6 py-6">
          {backend === "remote" ? (
            <p className="text-sm text-muted">Channels run on your server. Set them up there; Hearthside shows the chats once they're connected.</p>
          ) : (
            <>
              <p className="text-sm text-muted">
                Talk to {agentName} from your phone. Channels run while Hearthside is running on this computer (closing the window
                keeps it running). For always-on, run your companion on your own server.
              </p>
              <ChannelServiceLine />
              {error && <p role="alert" className="rounded-xl bg-error-light px-3.5 py-2.5 text-sm text-error">{error}</p>}
              {!channels && !error && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Spinner className="h-4 w-4" /> Starting the channel service…
                </div>
              )}
              {agentId &&
                channels?.map((channel) => (
                  <ChannelCard key={channel.id} channel={channel} agentId={agentId} agentName={agentName} nameOf={nameOf} routes={routes} onChanged={() => void refresh()} />
                ))}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
