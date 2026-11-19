import { useCallback, useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ExecutionPlace } from "@hearthside/ipc-contract";
import { useAppStore } from "../store";
import { ChevronDownIcon, MonitorIcon } from "./icons";
import { isRetryOfSamePlace, moveInFlight, moveNotice } from "../lib/move-status";

/**
 * Hearthside: which computer this conversation is running on, and moving it to
 * another one.
 *
 * One list, one meaning. Every entry is a real computer (or Letta's own cloud
 * sandbox), and choosing one moves *this* conversation there — the live one,
 * mid-reply if need be — rather than quietly arranging where some future
 * message will go. There is nothing here about defaults or routing, because
 * there is nothing to route: a conversation is in one place at a time, and this
 * is where you say which.
 *
 * A computer that can't be moved to still appears, with the reason next to it.
 * Hiding it would leave the person wondering where their laptop went; greying it
 * out silently would leave them guessing why.
 *
 * Between messages a conversation is running nowhere, and that is the ordinary
 * case rather than an error. Choosing a computer for an idle chat has nothing to
 * interrupt, so the main process records it as where the next message goes and
 * moves nothing — which is why a chosen place reads "selected · ready" and only
 * a verified live one reads "running here now". The chip never claims a
 * conversation is running somewhere on the strength of where it last was.
 *
 * Two entries are not computers to move to, and they are worded so nobody reads
 * them as one: "Run in this app" and "Continue where it's running". They exist
 * because a chat a message channel is connected to cannot be moved at all —
 * Letta refuses, because the channel cannot follow it — and before them such a
 * chat had every entry refused and no way to be sent to from inside the app.
 * They move nothing, so they are not what the channel guard is about.
 *
 * Which of the two applies is the one thing this list cannot decide for itself:
 * it depends on whether the conversation is running right now, which only the
 * main process can say. So exactly one of them is ever actionable, and when
 * neither is, the reason is shown with the step that would change it instead of
 * a list of grey rows.
 */
/** The chip is narrow, so the two non-computer entries get a shorter name. */
function chipName(place: ExecutionPlace): string {
  if (place.kind === "app") return "This app";
  if (place.kind === "follow") return "Where it's running";
  return place.name;
}

/**
 * What the trigger says about a chosen destination that is not running yet.
 *
 * Kind by kind rather than by name: "the next message goes to Run in this app"
 * is the sort of sentence a template produces and a person has to decode.
 */
function chosenLine(place: ExecutionPlace): string {
  if (place.kind === "follow") return "Your next message goes where this conversation is already running.";
  if (place.kind === "app") return "Nothing is running in this conversation. Its next message runs here, in this app.";
  return `Nothing is running in this conversation. Its next message goes to ${place.name}.`;
}

/** What each entry does, in the terms it matters in. */
function placeDetail(place: ExecutionPlace): string | null {
  if (place.kind === "app") return "Hearthside runs it here. Nothing is moved, so a connected message channel keeps working.";
  if (place.kind === "follow") return "Sends your next message to wherever the conversation is running now. Nothing is moved.";
  if (place.kind === "this-pc") return "Run tools on this computer";
  return null;
}

/**
 * Whether anything in the list can be chosen, and what to say when not.
 *
 * Exported because it is the rule the repair turns on, and it is worth being
 * able to test without a mounted menu. A list where every row is grey and
 * nothing says why is the state Aria was left in: it reads as "keep it here",
 * which was not on offer either — the chat could not be sent to at all.
 *
 * Returns null while something is still actionable, or while the reason is
 * temporary (offline, a move still settling) — those have their own lines and
 * saying this as well would only add noise.
 */
export function deadEndReason(places: ExecutionPlace[] | null, context: { ready: boolean; busy: boolean }): string | null {
  if (!places || places.length === 0 || !context.ready || context.busy) return null;
  // A conversation running at a named place is not stuck: it is somewhere.
  if (places.some((place) => place.current)) return null;
  if (places.some((place) => !place.moveBlocked && place.online)) return null;
  // The app entry's refusal is the useful one: it is about this app, and it
  // carries its own next step. The others say "can't move", which is already
  // visible on every row.
  const ordered = [...places].sort((left, right) => rank(left) - rank(right));
  const reason = ordered.find((place) => place.moveBlocked)?.moveBlocked;
  return reason ? `Nothing here can take this conversation right now. ${reason}` : null;
}

const rank = (place: ExecutionPlace): number => (place.kind === "app" ? 0 : place.kind === "follow" ? 1 : 2);

export function ExecutionPlaces({ compact = false }: { compact?: boolean }) {
  const id = useAppStore((state) => state.activeId);
  const chat = useAppStore((state) => (id ? state.chats[id] : undefined));
  const ready = useAppStore((state) => state.connection?.status === "ready");
  const epoch = useAppStore((state) => state.backendEpoch);
  const move = useAppStore((state) => state.moveConversation);
  const [places, setPlaces] = useState<ExecutionPlace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Reads from a previous chat or account must never land on this one.
  const generation = useRef(0);
  const moveState = chat?.move ?? null;
  const moveRevision = moveState ? `${moveState.phase}:${moveState.revision}` : "";
  // What the list itself depends on, rather than every execution event: choosing
  // a destination has to show up here, and an ownership poll must not refetch.
  const placesIdentity = useAppStore((state) => {
    const execution = id ? state.chats[id]?.execution : undefined;
    return JSON.stringify([execution?.selected ?? null, execution?.moveFrom?.connectionId ?? null,
      execution?.provenance ?? null, execution?.status === "confirmed", execution?.observed?.deviceId ?? null]);
  });

  const load = useCallback(() => {
    if (!id || !ready) return;
    const mine = ++generation.current;
    const current = () => mine === generation.current && useAppStore.getState().backendEpoch === epoch && useAppStore.getState().activeId === id;
    setLoading(true);
    void window.bridge.listExecutionPlaces(id).then(
      (items) => { if (current()) { setPlaces(items); setError(null); } },
      (failure: unknown) => { if (current()) setError(failure instanceof Error ? failure.message : String(failure)); },
    ).finally(() => { if (current()) setLoading(false); });
  }, [id, ready, epoch]);

  useEffect(() => { setPlaces(null); setError(null); }, [id, epoch]);
  // On opening the chat, and again whenever a move or a destination choice
  // changes what is true.
  useEffect(() => { load(); }, [load, moveRevision, placesIdentity]);

  const here = places?.find((place) => place.current) ?? null;
  // Where the next message goes, when nothing is running. Never a stand-in for
  // `here`: "selected" and "running" are different facts.
  const next = here ? null : places?.find((place) => place.selectedDestination) ?? null;
  const notice = moveNotice(moveState);
  const inFlight = moveInFlight(moveState);
  // `moveSending` is a request actually on the wire; nothing may be clicked
  // while one is. `inFlight` is the longer state, and it has one exception
  // below: asking again about the move that stalled.
  const busy = inFlight || Boolean(chat?.moveSending);
  const attention = !ready || Boolean(error) || Boolean(chat?.moveError) || (notice ? notice.tone !== "progress" : false);
  const label = here ? here.name : next ? chipName(next) : places ? "Choose a computer" : loading ? "Checking…" : "Where it runs";
  const chosen = here ? null : next ? chosenLine(next) : null;
  const deadEnd = deadEndReason(places, { ready, busy });

  return <DropdownMenu.Root onOpenChange={(open) => { if (open) load(); }}>
    <DropdownMenu.Trigger
      className={`chip min-w-0 whitespace-nowrap ${compact ? "composer-destination" : "max-w-[14rem]"}`}
      title={here ? `Running on ${here.name}` : chosen ?? "Which computer this conversation runs on"}
      aria-label={here
        ? `Running on ${here.name}. Choose another computer to move this conversation.`
        : chosen
          ? `${chosen} Open this to change where it runs.`
          : "Choose which computer this conversation runs on"}
    >
      <MonitorIcon className="h-3.5 w-3.5 shrink-0" />
      {/* Compact (in the composer): icon only, like the folder and permission
          chips, with a mark when something needs looking at. */}
      {compact
        ? attention && <span className="text-warning-strong">!</span>
        : <><span className="truncate">{label}</span><ChevronDownIcon className="h-3 w-3 shrink-0" /></>}
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content side="top" align="start" sideOffset={8} collisionPadding={12} className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-80 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-elevated">
      <DropdownMenu.Label className="px-2 py-1 text-sm font-medium">Where this conversation runs</DropdownMenu.Label>
      {/* Not "straight away": a computer part-way through a tool finishes what
          it took on first, so promising immediacy would be a lie in the one
          case people notice. */}
      {/* Both halves of the truth, because which one applies depends on whether
          anything is running — and the person cannot see that from here. */}
      <p className="px-2 pb-2 text-xs text-muted">Choosing a computer moves this conversation there. If nothing is running in it, that's where its next message goes. When available, “Run in this app” and “Continue where it's running” do not move the conversation.</p>

      {!ready && <p role="status" className="px-2 pb-2 text-xs text-muted">Offline — reconnect to move this conversation. Nothing has been moved.</p>}
      {notice && <div role="status" className={`mx-1 mb-2 rounded-lg px-2 py-1.5 text-xs ${notice.tone === "error" ? "bg-error-light text-error" : notice.tone === "warning" ? "bg-warning-light text-warning-strong" : "bg-surface-secondary text-muted"}`}>
        <p>{notice.line}</p>
        <details className="mt-1"><summary className="cursor-pointer">Details</summary><p className="mt-1 whitespace-pre-wrap break-words">{notice.detail}</p></details>
      </div>}

      {/* Not a grey list with no explanation: the reason, and the one step that
          changes it. Said before the rows, because it is about all of them. */}
      {deadEnd && <p role="status" className="mx-1 mb-2 rounded-lg bg-warning-light px-2 py-1.5 text-xs text-warning-strong">{deadEnd}</p>}

      {places === null
        ? <p role="status" className="px-2 pb-2 text-xs text-muted">{loading ? "Checking which computers are available…" : ready ? "Open again to look for computers." : ""}</p>
        : places.length === 0 ? <p role="status" className="px-2 pb-2 text-xs text-muted">No computers to move to. Letta's cloud sandbox and this computer's listener both need to be reachable.</p>
        : places.map((place) => {
          // Offline and refused are different facts, and the person acts on them
          // differently: one waits, the other can't be waited out.
          const refused = place.current ? null : !place.online ? "Offline — can't be moved to until it's back." : place.moveBlocked ?? null;
          // A move that stalled without a receipt would otherwise be a dead end:
          // every computer is disabled because a move is "under way", including
          // the one it stalled on. Asking again about *that* computer is the one
          // way out, and it is safe — the backend recognises the key it kept and
          // reports on the existing move rather than starting a second one. Any
          // other computer stays shut: that would be a new key, and a real
          // second move. (store.ts already allows exactly this one call.)
          const retry = isRetryOfSamePlace(moveState, place.id);
          const stuck = Boolean(refused) || !ready || Boolean(chat?.moveSending) || (busy && !retry);
          // An item that is off only because a move is unsettled must say so.
          // Otherwise it looks exactly like the one item that does work, and the
          // person clicks it and nothing happens.
          const unsettled = refused ?? (!place.current && !retry && busy ? "Can't move anywhere else until this one settles." : null);
          // The line above already carries one of these reasons, word for word.
          // Saying it twice in the same inch of screen makes the person read it
          // twice to find out it was the same thing.
          const reason = unsettled && deadEnd?.endsWith(unsettled) ? null : unsettled;
          return <DropdownMenu.Item
            key={place.id}
            disabled={place.current || stuck}
            onSelect={() => { if (id && !place.current && !stuck) void move(id, place.id); }}
            className="cursor-pointer rounded-lg px-2 py-2 text-sm outline-none data-[highlighted]:bg-surface-tertiary data-[disabled]:cursor-default data-[disabled]:opacity-100"
          >
            {/* Muted by whether it can be chosen, never by whether its reason
                happens to be printed on this row. */}
            <span className={`block ${place.current || !unsettled ? "" : "text-muted"}`}>
              {place.name}{place.current ? " · running here now" : place.selectedDestination ? " · selected · ready" : ""}
            </span>
            {/* Chosen, and nothing running: say so rather than let "ready" read
                as "busy". Choosing it again re-checks that it still holds. The
                continue entry is the exception — something *is* running, which
                is the only reason it is on offer. */}
            {place.selectedDestination && !place.current && <span className="block text-xs text-muted">{place.kind === "follow"
              ? "Where the next message goes, wherever the conversation is running."
              : "Where the next message goes. Nothing is running there now."}</span>}
            {/* What it does, not how it is plumbed. The listener is real and
                worth being able to find out about, so it moved into the folded
                note at the bottom rather than onto this line. */}
            {placeDetail(place) && <span className="block text-xs text-muted">{placeDetail(place)}</span>}
            {reason && <span className="block text-xs text-warning-strong">{reason}</span>}
            {retry && !stuck && !place.current && <span className="block text-xs text-muted">Ask Letta about this move again. It checks the one already asked for; it does not start a second.</span>}
          </DropdownMenu.Item>;
        })}

      <DropdownMenu.Separator className="my-1 border-t border-border" />
      <DropdownMenu.Item
        data-places-refresh
        disabled={!ready || loading}
        onSelect={(event) => { event.preventDefault(); load(); }}
        className="cursor-pointer rounded-lg px-2 py-2 text-sm outline-none data-[highlighted]:bg-surface-tertiary data-[disabled]:opacity-50"
      >
        {loading ? "Checking…" : "Check again"}
      </DropdownMenu.Item>

      <div className="mt-1 border-t border-border px-2 pt-2 text-xs text-muted" role="status">
        {chat?.moveSending && <p>Asking Letta to move it…</p>}
        {(error || chat?.moveError) && <p role="alert" className="text-error">{error || chat?.moveError}</p>}
        {!id && <p>Start a chat before choosing where it runs.</p>}
        <details className="mt-1">
          <summary className="cursor-pointer">What moving changes</summary>
          <p className="mt-1">Running it in this app and continuing where it's running are not moves: nothing is handed over, and a message channel connected to this chat keeps working. Everything below is.</p>
          <p className="mt-1">The conversation itself goes with it — including a reply already in progress, once the computer it's on finishes what it has taken on. The model, permissions, tools and files become the new computer's, not this one's. Anything you have typed and not sent stays here, and nothing already sent is sent again. Your own computer is reached through the listener Letta connects to it by, so it has to be running there.</p>
        </details>
      </div>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

/** Whether this build can actually move a conversation, rather than claim to. */
export function nativeMoveAvailable(): boolean {
  const bridge = window.bridge as Partial<typeof window.bridge> | undefined;
  return typeof bridge?.listExecutionPlaces === "function" && typeof bridge?.moveConversation === "function";
}
