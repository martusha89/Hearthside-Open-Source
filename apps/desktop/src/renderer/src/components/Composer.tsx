// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { ConversationExecution, localFolderAvailable } from "./ConversationExecution";
import { ExecutionPlaces, nativeMoveAvailable } from "./ExecutionPlaces";
import { executionDestinationNotice, executionHoldNotice } from "../lib/execution-guidance";
import { queueStatusLabel } from "../lib/queue-status";
import { stopControl } from "../lib/turn-controls";
import { GifPicker } from "./GifPicker";
import { gifTag } from "../lib/attachments";
import { GIF_FRAMES_NAME, gifContactSheet } from "../lib/gif-frames";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { shortPath } from "../lib/format";
import { captureComposer, composerKey, selectCwd, selectEffort, selectModel, useAppStore } from "../store";
import { effortLabel, reasoningChoice, reasoningOptions, resolveModel } from "../lib/models";
import type { Attachment, ChatCommand, ModelOption, PermissionMode } from "../types";
import { parseAskUserQuestionNotif } from "@letta-ai/letta-code/ask-user-question";
import { ContextMeter } from "./ContextMeter";
import { GptUsageMeter } from "./GptUsageMeter";
import { type SlashCommand, suggestCommands, withModCommands } from "../lib/commands";
import { ModelPicker } from "./ModelPicker";
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, CloseIcon, FileIcon, FolderIcon, PaperclipIcon, PlusIcon, ShieldIcon, Spinner, StopIcon } from "./icons";

/** The draft box grows to this, then scrolls (less on a short screen). */
const MAX_HEIGHT = Math.min(240, Math.round(window.innerHeight * 0.3));
// A stable reference: a selector must not return a fresh array on every call.
const NO_FOLDERS: string[] = [];
const NO_ATTACHMENTS: Attachment[] = [];
const NO_MOD_COMMANDS: ChatCommand[] = [];

const PERMISSION_MODES: Array<{ mode: PermissionMode; label: string; detail: string }> = [
  { mode: "standard", label: "Ask first", detail: "Asks before running commands or editing files" },
  { mode: "acceptEdits", label: "Accept edits", detail: "Edits files freely, asks before commands" },

  { mode: "unrestricted", label: "YOLO", detail: "Runs everything without asking" },
];

const menuContent =
  "z-50 min-w-[240px] rounded-xl border border-border bg-surface p-1 shadow-elevated";
const menuItem =
  "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-800 outline-none data-[highlighted]:bg-surface-tertiary";

function FolderMenu({ cwd }: { cwd: string }) {
  const recentCwds = useAppStore((state) => state.settings?.recentCwds ?? NO_FOLDERS);
  const setCwd = useAppStore((state) => state.setCwd);
  const pickCwd = useAppStore((state) => state.pickCwd);
  const others = recentCwds.filter((path) => path !== cwd);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="chip composer-folder" title={`Working folder: ${cwd}`} aria-label={`Working folder: ${cwd}`}>
        <FolderIcon className="h-3.5 w-3.5 shrink-0" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={menuContent} side="top" align="start" sideOffset={8}>
          <DropdownMenu.Label className="px-3 pb-1 pt-2 text-xs text-muted">
            Folder for file work
          </DropdownMenu.Label>
          <DropdownMenu.Item className={menuItem} disabled>
            <CheckIcon className="h-4 w-4 shrink-0 text-accent" />
            <span className="truncate font-mono text-xs">{shortPath(cwd)}</span>
          </DropdownMenu.Item>
          {others.map((path) => (
            <DropdownMenu.Item key={path} className={menuItem} onSelect={() => setCwd(path)}>
              <span className="w-4 shrink-0" />
              <span className="truncate font-mono text-xs" title={path}>
                {shortPath(path)}
              </span>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item className={menuItem} onSelect={() => void pickCwd()}>
            <FolderIcon className="h-4 w-4 shrink-0 text-muted" />
            Choose folder...
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function PermissionMenu() {
  const current = useAppStore((state) => state.settings?.permissionMode ?? "standard");
  const saveSettings = useAppStore((state) => state.saveSettings);
  const label = PERMISSION_MODES.find((item) => item.mode === current)?.label ?? current;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className={`chip composer-permission ${current === "unrestricted" ? "text-warning-strong" : ""}`} title={`${label}: ${PERMISSION_MODES.find((item) => item.mode === current)?.detail ?? "What the agent may do without asking"}`} aria-label={`Permissions: ${label}`}>
        <ShieldIcon className="h-3.5 w-3.5 shrink-0" />
        {current !== "standard" && <span>{label}{current === "unrestricted" ? " !" : ""}</span>}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={menuContent} side="top" align="start" sideOffset={8}>
          {PERMISSION_MODES.map((item) => (
            <DropdownMenu.Item
              key={item.mode}
              className={menuItem}
              onSelect={() => void saveSettings({ permissionMode: item.mode })}
            >
              <span className="w-4 shrink-0">
                {item.mode === current && <CheckIcon className="h-4 w-4 text-accent" />}
              </span>
              <span>
                <span className="block">{item.label}</span>
                <span className="block text-xs text-muted">{item.detail}</span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Hearthside: reasoning level for the chosen model, from the runtime's catalog
 * tiers. `effort` is the level Letta holds for this chat (or the one chosen and
 * not yet sent); null means nobody knows, and then no level is shown and none
 * is ticked. Standing in the model's default there would claim a level Letta
 * may not hold — and the next message would send the claim back.
 */
export function ReasoningMenu({ value, effort, models, onChange }: { value: string | null; effort: string | null; models: ModelOption[]; onChange: (id: string) => void }) {
  const resolved = resolveModel(value, models);
  if (!resolved || resolved.model.reasoning.length < 2) return null;
  const { model } = resolved;
  const defaultEffort = model.reasoning.find((tier) => tier.id === model.id)?.effort ?? null;
  const { label, tickedTierId } = reasoningChoice(model, effort, value);
  const groups = new Map<string, ModelOption["reasoning"]>();
  for (const tier of reasoningOptions(model, value)) groups.set(tier.effort, [...(groups.get(tier.effort) ?? []), tier]);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="chip composer-reasoning" title="How much the model thinks before answering">
        <span>{label}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={menuContent} side="top" align="start" sideOffset={8}>
          <DropdownMenu.Label className="px-3 pb-1 pt-2 text-xs text-muted">Reasoning</DropdownMenu.Label>
          {[...groups].map(([level, tiers]) => {
            const tier = tiers[0]!;
            const text = <span>{effortLabel(level)}{level === defaultEffort && <span className="text-xs text-muted"> (default)</span>}</span>;
            if (tiers.length === 1) return <DropdownMenu.Item key={level} className={menuItem} onSelect={() => onChange(tier.id)}>
              <span className="w-4 shrink-0">{tier.id === tickedTierId && <CheckIcon className="h-4 w-4 text-accent" />}</span>{text}
            </DropdownMenu.Item>;
            // Unknown runtime-specific levels can address distinct configurations.
            // One level in the menu, explicit alternatives rather than guessed routing.
            return <DropdownMenu.Sub key={level}><DropdownMenu.SubTrigger className={menuItem} title="The runtime lists distinct configurations for this level.">
              <span className="w-4 shrink-0">{tiers.some((item) => item.id === tickedTierId) && <CheckIcon className="h-4 w-4 text-accent" />}</span>{text}<ChevronDownIcon className="ml-auto h-3 w-3 -rotate-90" />
            </DropdownMenu.SubTrigger><DropdownMenu.Portal><DropdownMenu.SubContent className={`${menuContent} max-w-md`} sideOffset={4}>
              <DropdownMenu.Label className="px-3 py-2 text-xs text-muted">{effortLabel(level)} configurations</DropdownMenu.Label>
              {tiers.map((variant) => <DropdownMenu.Item key={variant.id} className={menuItem} onSelect={() => onChange(variant.id)}>
                <span className="w-4 shrink-0">{variant.id === tickedTierId && <CheckIcon className="h-4 w-4 text-accent" />}</span><span className="min-w-0 break-all text-xs">{variant.id}{variant.id === model.id ? " (default)" : ""}</span>
              </DropdownMenu.Item>)}
            </DropdownMenu.SubContent></DropdownMenu.Portal></DropdownMenu.Sub>;
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Hearthside: attachments waiting to be sent. */
function AttachmentTray({ attachments, onRemove }: { attachments: Attachment[]; onRemove: (index: number) => void }) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {attachments.map((item, index) => (
        <div key={index} className="group relative flex items-center gap-2 rounded-xl border border-border bg-surface-secondary p-1.5 pr-2 text-xs text-ink-700">
          {item.kind === "image" ? (
            <img src={`data:${item.mediaType};base64,${item.data}`} alt="" className="h-10 w-10 rounded-lg object-cover" />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tertiary">
              <FileIcon className="h-4 w-4 text-muted" />
            </span>
          )}
          <span className="max-w-[10rem] truncate" title={item.name}>{item.name}</span>
          <button
            type="button"
            onClick={() => onRemove(index)}
            aria-label={`Remove ${item.name}`}
            title="Remove"
            className="rounded-full p-0.5 text-muted hover:bg-surface-tertiary hover:text-ink-800"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Hearthside: messages waiting for the agent to finish. */
function QueueList() {
  const activeId = useAppStore((state) => state.activeId);
  const chat = useAppStore((state) => state.chats[composerKey(state)]);
  const agentId = useAppStore((state) => state.agentId);
  const connected = useAppStore((state) => state.connection?.status === "ready");
  const removeQueued = useAppStore((state) => state.removeQueued);
  const sendQueueNow = useAppStore((state) => state.sendQueueNow);
  const queue = chat?.queue.filter((item) => !item.agentId || item.agentId === agentId) ?? [];
  if (!chat || queue.length === 0) return null;
  return (
    <div className="mb-2 grid max-h-[25vh] gap-1.5 overflow-y-auto" aria-label="Queued messages">
      <div className="flex items-center justify-between px-1 text-xs text-muted">
        <span>
          {queueStatusLabel(chat, connected)}
        </span>
        {chat.queuePaused && !queue.some((item) => item.deliveryUnconfirmed) && !chat.running && !chat.stopRequested && connected && chat.execution?.status !== "blocked" && !chat.executionSaving && !chat.execution?.requiresDestination && !chat.execution?.pendingDelivery && (
          <button type="button" className="font-medium text-accent hover:underline" onClick={sendQueueNow}>
            Send now
          </button>
        )}
      </div>
      {queue.map((item) => {
        const isAnswer = parseAskUserQuestionNotif(item.text).length > 0;
        const label = isAnswer
          ? "Your answer to the agent's questions"
          : item.text || item.attachments.map((a) => a.name).join(", ");
        return (
          <div key={item.id} className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-surface-secondary px-3 py-1.5 text-sm text-ink-700">
            <span className="min-w-0 flex-1"><span className="block truncate">{label}</span>{item.deliveryUnconfirmed && <span className="block text-xs text-muted">Delivery unconfirmed — never resent here. Check the destination before dismissing this record; dismissal does not cancel delivery.</span>}</span>
            {item.attachments.length > 0 && item.text && (
              <span className="shrink-0 text-xs text-muted">+{item.attachments.length}</span>
            )}
            <button
              type="button"
              onClick={() => removeQueued(item.id)}
              aria-label={item.deliveryUnconfirmed ? "Dismiss unconfirmed delivery record" : "Remove from queue"}
              title={item.deliveryUnconfirmed ? "Dismiss record, not delivery" : "Remove from queue"}
              className="shrink-0 rounded-full p-0.5 text-muted hover:bg-surface-tertiary hover:text-ink-800"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Fixed for the window's lifetime: what the main process exposes doesn't change under us. */
const nativeMove = nativeMoveAvailable();

export function Composer({ disabled }: { disabled: boolean }) {
  const activeId = useAppStore((state) => state.activeId);
  const key = useAppStore((state) => composerKey(state));
  const draft = useAppStore((state) => state.drafts[key] ?? "");
  const running = useAppStore((state) =>
    activeId ? (state.chats[activeId]?.running ?? false) : state.pendingFirstMessage !== null,
  );
  const cwd = useAppStore((state) => selectCwd(state, key));
  const execution = useAppStore((state) => activeId ? state.chats[activeId]?.execution : undefined);
  const executionSaving = useAppStore((state) => activeId ? state.chats[activeId]?.executionSaving : false);
  const showLocalFolder = useAppStore((state) => localFolderAvailable(state.settings, execution, activeId));
  const onCloud = useAppStore((state) => state.settings?.backend === "cloud");
  const offline = useAppStore((state) => state.connection?.status !== "ready");
  const queuePaused = useAppStore((state) => Boolean(state.chats[key]?.stopRequested || (state.chats[key]?.queuePaused && state.chats[key]?.queue.length)));
  const move = useAppStore((state) => (activeId ? state.chats[activeId]?.move : undefined));
  const stopRequested = useAppStore((state) => (activeId ? Boolean(state.chats[activeId]?.stopRequested) : false));
  const blocked = execution?.status === "blocked";
  const held = offline || blocked || execution?.requiresDestination || execution?.pendingDelivery || executionSaving || queuePaused;
  const followsOwner = execution?.followsOwner === true;
  const model = useAppStore((state) => selectModel(state, key));
  const effort = useAppStore((state) => selectEffort(state, key));
  const models = useAppStore((state) => state.models);
  const setDraft = useAppStore((state) => state.setDraft);
  const setModel = useAppStore((state) => state.setModel);
  const agent = useAppStore((state) => state.agents.find((item) => item.id === state.agentId) ?? null);
  const updateAgent = useAppStore((state) => state.updateAgent);
  const setNotice = useAppStore((state) => state.setNotice);
  const chosen = resolveModel(model, models)?.model ?? null;
  const agentDefault = resolveModel(agent?.model ?? null, models)?.model ?? null;
  // The chat can use a different model from the agent's default; offer to make it the default.
  const pickerFooter =
    agent && chosen && chosen.handle !== agentDefault?.handle
      ? (close: () => void) => (
          <button
            type="button"
            className="w-full rounded-lg px-3 py-2 text-left text-xs text-ink-700 hover:bg-surface-tertiary"
            onClick={() => {
              close();
              void updateAgent({ model: chosen.handle }).catch((error: unknown) =>
                setNotice(error instanceof Error ? error.message : String(error)),
              );
            }}
          >
            Make {chosen.label} the default for {agent.name}
          </button>
        )
      : undefined;
  const send = useAppStore((state) => state.send);
  const stop = useAppStore((state) => state.stop);
  const attachments = useAppStore((state) => state.attachments[key] ?? NO_ATTACHMENTS);
  const attachmentReads = useAppStore((state) => state.attachmentReads);
  const addAttachments = useAppStore((state) => state.addAttachments);
  const removeAttachment = useAppStore((state) => state.removeAttachment);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [gifPicker, setGifPicker] = useState(false);
  const gifsAvailable = useAppStore((state) => state.settings?.gifsAvailable ?? false);
  // Hearthside: slash command suggestions while typing "/…", built-ins plus
  // whatever the runtime says this chat's mods have registered.
  const modCommands = useAppStore((state) => (state.activeId ? state.chatCommands[state.activeId]?.commands : undefined) ?? NO_MOD_COMMANDS);
  const available = useMemo(() => withModCommands(modCommands), [modCommands]);
  const suggestions = disabled || followsOwner ? [] : suggestCommands(draft, available);
  const [highlight, setHighlight] = useState(0);
  const pick = (command: SlashCommand) => {
    setDraft(`/${command.name}${command.argument || command.needsArgument ? " " : ""}`);
    setHighlight(0);
    inputRef.current?.focus();
  };

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_HEIGHT)}px`;
    input.style.overflowY = input.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    if (!disabled) inputRef.current?.focus();
  }, [key, disabled]);

  // Whether Stop can act is the runtime's answer (`execution.controls`), not a
  // guess from what this window happens to know.
  const stopping = stopControl({ controls: execution?.controls, move, blocked, pendingDelivery: Boolean(execution?.pendingDelivery), followsOwner, nativeMove }, stopRequested);
  const hasContent = draft.trim().length > 0 || attachments.length > 0;
  const destinationNotice = executionDestinationNotice(execution, running);
  const holdNotice = executionHoldNotice(execution);
  // Hearthside: in an existing chat, a message written while the agent works is queued.
  const canSend = !attachmentReads && !disabled && hasContent && (!held || Boolean(activeId)) && (!running || Boolean(activeId));

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-5">
      {destinationNotice && <p className="mb-2 text-xs text-muted" role="status">{destinationNotice}</p>}
      
      {holdNotice && <div role="status" className="mb-2 rounded-xl border border-border bg-surface-secondary px-3 py-2 text-sm text-ink-700">{holdNotice}</div>}
      {offline && <p role="status" className="mb-2 text-xs text-muted">Offline — drafts stay here. New messages can be queued on hold; nothing sends until you reconnect and choose Send now.</p>}
      <QueueList />
      <div
        data-tour="composer"
        className={`composer-surface rounded-2xl border bg-surface shadow-card transition-colors focus-within:border-border-hover ${dragging ? "border-accent" : "border-border"}`}
        onDragOver={(event) => {
          if (disabled || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          setDragging(false);
          if (disabled || event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          void addAttachments(event.dataTransfer.files);
        }}
      >
        <AttachmentTray attachments={attachments} onRemove={removeAttachment} />
        {suggestions.length > 0 && (
          <div role="listbox" aria-label="Commands" className="mx-2 mt-2 overflow-hidden rounded-xl border border-border bg-surface-secondary">
            {suggestions.map((command, index) => (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={index === Math.min(highlight, suggestions.length - 1)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(command)}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm ${index === Math.min(highlight, suggestions.length - 1) ? "bg-surface-tertiary" : "hover:bg-surface-tertiary"}`}
              >
                <span className="shrink-0 font-mono text-ink-900">/{command.name}</span>
                {command.argument && <span className="shrink-0 font-mono text-xs text-muted">{command.argument}</span>}
                <span className="min-w-0 truncate text-xs text-muted">{command.description}</span>
                {/* Hearthside: from a mod, so the person can see it isn't built in. */}
                {command.mod && <span className="ml-auto shrink-0 rounded bg-surface-tertiary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">Mod</span>}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          disabled={disabled}
          placeholder={
            disabled
              ? "Connect to Letta to start"
              : running && activeId
                ? `Message ${agent?.name ?? "your companion"}… It sends when the current reply finishes.`
                : `Message ${agent?.name ?? "your companion"}…`
          }
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            // Pasted images and files become attachments; text pastes as usual.
            if (event.clipboardData.files.length === 0) return;
            event.preventDefault();
            void addAttachments(event.clipboardData.files);
          }}
          onKeyDown={(event) => {
            if (suggestions.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setHighlight((current) => (Math.min(current, suggestions.length - 1) + step + suggestions.length) % suggestions.length);
                return;
              }
              if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                const chosen = suggestions[Math.min(highlight, suggestions.length - 1)]!;
                // Enter on a fully typed command that needs nothing more runs it.
                if (!(event.key === "Enter" && draft === `/${chosen.name}` && !chosen.needsArgument)) {
                  event.preventDefault();
                  pick(chosen);
                  return;
                }
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft("");
                return;
              }
            }
            // Enter sends; Shift+Enter and IME composition insert a newline.
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (canSend) void send(draft);
          }}
          className="block w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed text-ink-900 placeholder:text-muted focus:outline-none disabled:cursor-not-allowed"
        />
        <div className={`composer-toolbar${followsOwner ? " composer-toolbar--owner" : ""}`}>
          <div className="composer-location">
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) void addAttachments([...event.target.files]);
                event.target.value = "";
              }}
            />
            
            <div className="relative shrink-0">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger className="chip" disabled={disabled} aria-label="Add" title="Add files or a GIF">
                  <PlusIcon className="h-3.5 w-3.5 shrink-0" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className={menuContent} side="top" align="start" sideOffset={8}>
                    <DropdownMenu.Item className={menuItem} onSelect={() => fileRef.current?.click()}>
                      <PaperclipIcon className="h-4 w-4 shrink-0 text-muted" />
                      <span>Attach files</span>
                      <span className="ml-auto pl-3 text-xs text-muted">or paste, or drop</span>
                    </DropdownMenu.Item>
                    {gifsAvailable && (
                      <DropdownMenu.Item className={menuItem} onSelect={() => setGifPicker(true)}>
                        <span className="w-4 shrink-0 text-center text-[10px] font-semibold tracking-wide text-muted">GIF</span>
                        <span>Choose a GIF</span>
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              {gifsAvailable && gifPicker && (
                <GifPicker
                  onClose={() => setGifPicker(false)}
                  onPick={(gif) => {
                    setGifPicker(false);
                    // Anything typed goes along with the GIF.
                    const source = captureComposer();
                    const typed = (source.draft ?? "").trim();
                    const text = typed ? `${typed}\n${gifTag(gif.title, gif.url)}` : gifTag(gif.title, gif.url);
                    // The agent also gets frames from across the GIF as one picture, so it can see it.
                    void window.bridge
                      .fetchGif(gif.url)
                      .then((data) => gifContactSheet(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)).buffer))
                      .then((sheet) => send(text, [{ kind: "image", name: GIF_FRAMES_NAME, mediaType: "image/jpeg", data: sheet }], source),
                        () => send(text, [], source));
                  }}
                />
              )}
            </div>
            {/* Hearthside: the one computer picker, when this build can really
                move a conversation. Until the main process can, the older
                next-turn chooser stays: a control that can't do what it says is
                worse than the clumsy one that can. */}
            {/* Off Letta Cloud there is nowhere to move a conversation to: the
                picker listed "This computer — Offline" and a Letta Cloud row,
                every one disabled, which read as the computer being offline. */}
            {!onCloud ? null : nativeMove ? <ExecutionPlaces compact /> : <ConversationExecution compact />}
            {showLocalFolder && <FolderMenu cwd={cwd} />}
          </div>
          {!followsOwner && <div className="composer-model">
              <ModelPicker value={model} effort={effort} models={models} onChange={setModel} className="composer-model-picker" compact footer={pickerFooter} />
              <ReasoningMenu value={model} effort={effort} models={models} onChange={setModel} />
          </div>}
          <div className="composer-details">
            {!followsOwner && <PermissionMenu />}
            {/* Hearthside: the ChatGPT plan's own usage, beside the chat's context. */}
            <GptUsageMeter />
            <ContextMeter />
          </div>
          <div className="composer-send">
          {/* Hearthside: Stop stays on screen the whole time a reply is coming.
              It used to disappear whenever the turn was running somewhere this
              window couldn't reach, which left no way to tell "you can't stop
              this" from "there is nothing to stop". Now it says which. */}
          {running && activeId && (
            <button
              type="button"
              onClick={() => { if (stopping.state === "available") stop(); else if (stopping.reason) setNotice(stopping.reason); }}
              aria-disabled={stopping.state !== "available"}
              aria-label={stopping.reason ? `${stopping.label}: ${stopping.reason}` : stopping.label}
              title={stopping.reason ?? stopping.label}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-900 text-surface transition-opacity ${stopping.state === "available" ? "hover:opacity-80" : "opacity-40"}`}
            >
              {stopping.state === "pending" ? <Spinner className="h-4 w-4" /> : <StopIcon className="h-4 w-4" />}
            </button>
          )}
          {(!running || !activeId || hasContent) && (
            <button
              type="button"
              onClick={() => void send(draft)}
              disabled={!canSend}
              aria-label={held && activeId ? "Queue on hold" : running && activeId ? "Queue message" : "Send"}
              title={held && activeId ? "Queue message while delivery is held (Enter)" : running && activeId ? "Queue: sends when the agent finishes (Enter)" : "Send (Enter)"}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-brand-content transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUpIcon className="h-4 w-4" />
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
