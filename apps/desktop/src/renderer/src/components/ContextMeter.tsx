import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { resolveModel } from "../lib/models";
import { selectModel, useAppStore } from "../store";
import { CheckIcon, MeterRing } from "./icons";

/**
 * Hearthside: how full the chat's context is, from the usage the model reports
 * each turn. Opens to show details and, for chats other than the main one, to
 * give the chat its own context size.
 */

const SIZES = [32_000, 64_000, 128_000, 200_000, 272_000, 400_000, 1_000_000];

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

const menuContent = "z-50 w-[300px] rounded-xl border border-border bg-surface p-3 shadow-elevated";
const radioItem =
  "flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink-800 outline-none data-[highlighted]:bg-surface-tertiary";

export function ContextMeter() {
  const activeId = useAppStore((state) => state.activeId);
  const usage = useAppStore((state) => (activeId ? (state.chats[activeId]?.usage ?? null) : null));
  const conversation = useAppStore((state) => state.conversations.find((item) => item.id === activeId));
  const show = useAppStore((state) => state.settings?.showUsage ?? true);
  const model = useAppStore((state) => (activeId ? selectModel(state, activeId) : null));
  const models = useAppStore((state) => state.models);
  const setChatContextWindow = useAppStore((state) => state.setChatContextWindow);
  const setAgentSettingsOpen = useAppStore((state) => state.setAgentSettingsOpen);
  const setNotice = useAppStore((state) => state.setNotice);
  if (!show || !activeId || !conversation) return null;

  const modelWindow = resolveModel(model, models)?.model.contextWindow ?? null;
  const limit = conversation.contextWindowLimit ?? usage?.contextWindow;
  const window = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null;
  const count = usage?.contextTokens;
  const used = typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null;
  const fraction = used !== null && window ? used / window : null;
  const percent = fraction === null ? null : Math.round(fraction * 100);
  // The model's listed size is a guide, not a hard limit.
  const sizes = [...new Set([...SIZES, ...(modelWindow ? [modelWindow] : [])])].sort((a, b) => a - b);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="chip"
        aria-label={percent === null ? "Context usage" : `Context ${percent}% full`}
        title="How full this chat's context is"
      >
        <MeterRing fraction={fraction} />
        <span className="tabular-nums">{percent === null ? "–" : `${percent}%`}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={menuContent} side="top" align="end" sideOffset={8}>
          <p className="text-sm font-medium text-ink-900">Context</p>
          {used !== null && window ? (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-tertiary">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (used / window) * 100)}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-ink-700 tabular-nums">
                {used.toLocaleString()} of {window.toLocaleString()} tokens ({percent}%)
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-muted">Waiting for fresh context usage and the active context limit.</p>
          )}
          {usage && usage.promptTokens + usage.completionTokens > 0 && (
            <p className="mt-1 text-xs text-muted tabular-nums">
              Last reply: {compact(usage.promptTokens)} read, {compact(usage.completionTokens)} written
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            When it fills up, older messages are summarised to make room. The originals can still be found by searching.
          </p>

          <DropdownMenu.Separator className="my-2.5 h-px bg-border" />
          {conversation.main ? (
            <div className="grid gap-1.5">
              <p className="text-xs text-muted">The main chat uses the agent's context size.</p>
              <DropdownMenu.Item className={radioItem} onSelect={() => setAgentSettingsOpen(true)}>
                Change it in Agent settings…
              </DropdownMenu.Item>
            </div>
          ) : (
            <>
              <DropdownMenu.Label className="px-2 pb-1 text-xs font-medium text-ink-700">Context size for this chat</DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={String(conversation.contextWindowLimit ?? "agent")}
                onValueChange={(value) => {
                  const limit = value === "agent" ? null : Number(value);
                  setChatContextWindow(conversation.id, limit).catch((error: unknown) =>
                    setNotice(error instanceof Error ? error.message : String(error)),
                  );
                }}
              >
                <DropdownMenu.RadioItem value="agent" className={radioItem}>
                  <span className="w-4">
                    <DropdownMenu.ItemIndicator>
                      <CheckIcon className="h-4 w-4 text-accent" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  Same as the agent
                </DropdownMenu.RadioItem>
                {sizes.map((size) => (
                  <DropdownMenu.RadioItem key={size} value={String(size)} className={radioItem}>
                    <span className="w-4">
                      <DropdownMenu.ItemIndicator>
                        <CheckIcon className="h-4 w-4 text-accent" />
                      </DropdownMenu.ItemIndicator>
                    </span>
                    <span className="tabular-nums">
                      {compact(size)} tokens{size === modelWindow ? " (listed)" : modelWindow && size > modelWindow ? " (above listed)" : ""}
                    </span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
              <p className="mt-1.5 px-2 text-[11px] text-muted">Bigger keeps more of the chat in view but costs more per reply.</p>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
