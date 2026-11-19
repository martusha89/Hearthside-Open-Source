import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useAppStore } from "../store";
import type { BackendKind } from "../types";
import { LettaSignIn } from "./LettaSignIn";
import { ProvidersPanel } from "./ProvidersPanel";
import { Spinner } from "./icons";

/**
 * Hearthside: the welcome on first launch only. First: do you already have an
 * agent, or are you new? Someone with an agent connects to where it lives
 * (Letta Cloud, their Letta Code folder, or their own server). Someone new
 * chooses where their companion lives, connects a model or signs in, and then
 * creates their companion (Continuity Studio's pages, inside Hearthside).
 * Every step can be skipped and done later in Settings.
 */

type Step = "welcome" | "existing" | "localExisting" | "where" | "cloud" | "model" | "agent" | "tips";
type Path = "existing" | "new";

const PLACES: Array<{ id: BackendKind; title: string; detail: string }> = [
  { id: "local", title: "This computer", detail: "Private and free to run. You connect a model, like a ChatGPT plan or an API key." },
  { id: "cloud", title: "Letta Cloud", detail: "Your Letta account. Your companion is there on every device." },
  { id: "remote", title: "Your own server", detail: "A server you run, such as Railway or a home PC. For people comfortable with setup." },
];

const EXISTING: Array<{ id: "cloud" | "local" | "remote"; title: string; detail: string }> = [
  { id: "cloud", title: "On Letta Cloud", detail: "You sign in to Letta (the website or the Letta app). Your agents appear as soon as you sign in." },
  { id: "local", title: "In Letta Code or Letta Desktop on this computer", detail: "Agents you made locally, without a Letta account." },
  { id: "remote", title: "On my own server", detail: "A Letta server you run yourself." },
];

export function WelcomeGuide() {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const agents = useAppStore((state) => state.agents);
  const openSettings = useAppStore((state) => state.openSettings);
  const createAgent = useAppStore((state) => state.createAgent);
  const setNewAgentOpen = useAppStore((state) => state.setNewAgentOpen);
  const [path, setPath] = useState<Path>("new");
  const [agentName, setAgentName] = useState("");
  const [blank, setBlank] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("welcome");
  const [place, setPlace] = useState<BackendKind>(settings?.backend ?? "local");
  const [existingPlace, setExistingPlace] = useState<"cloud" | "local" | "remote">("cloud");
  const [switching, setSwitching] = useState(false);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  const open = Boolean(settings) && settings?.welcomed === false;

  const finish = () => void saveSettings({ welcomed: true });
  const choosePlace = async () => {
    if (settings?.backend !== place) await saveSettings({ backend: place });
    if (place === "local") setStep("model");
    else if (place === "cloud") setStep("cloud");
    else {
      finish();
      openSettings("connection");
    }
  };
  const chooseExisting = async () => {
    if (existingPlace === "cloud") {
      if (settings?.backend !== "cloud") await saveSettings({ backend: "cloud" });
      setStep("cloud");
    } else if (existingPlace === "local") {
      setStep("localExisting");
    } else {
      finish();
      openSettings("connection");
    }
  };
  const useLettaCodeFolder = async () => {
    setSwitching(true);
    setSwitchNotice(null);
    try {
      if (settings?.backend !== "local") await saveSettings({ backend: "local" });
      const { backup } = await window.bridge.setUseRealLettaHome(true);
      setSwitchNotice(backup ? `Done. Your folder was backed up to ${backup} first.` : "Done.");
    } catch (error) {
      setSwitchNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitching(false);
    }
  };
  const buildCompanion = () => {
    finish();
    setNewAgentOpen(true, "companion");
  };

  const primary = "button-primary";
  const secondary = "button-secondary";
  const heading = "text-lg font-semibold text-ink-900";
  const text = "mt-2 text-sm text-muted";
  const card = (selected: boolean) =>
    `flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${selected ? "border-accent bg-accent-subtle" : "border-border hover:bg-surface-tertiary"}`;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && finish()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/30 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-elevated">
          {step === "welcome" && (
            <>
              <Dialog.Title className={heading}>Welcome to Hearthside</Dialog.Title>
              <Dialog.Description className={text}>
                A home for your AI companions. They remember what matters across every chat, and you can see and shape that memory.
              </Dialog.Description>
              <div className="mt-5 grid gap-2">
                <button
                  type="button"
                  className="grid gap-0.5 rounded-xl border border-border px-4 py-3 text-left transition-colors hover:border-accent hover:bg-accent-subtle"
                  onClick={() => {
                    setPath("existing");
                    setStep("existing");
                  }}
                >
                  <span className="text-sm font-semibold text-ink-900">I already have an agent</span>
                  <span className="text-xs text-muted">From Letta Cloud, Letta Code or Letta Desktop. Pick up where you left off.</span>
                </button>
                <button
                  type="button"
                  className="grid gap-0.5 rounded-xl border border-border px-4 py-3 text-left transition-colors hover:border-accent hover:bg-accent-subtle"
                  onClick={() => {
                    setPath("new");
                    setStep("where");
                  }}
                >
                  <span className="text-sm font-semibold text-ink-900">I'm new here</span>
                  <span className="text-xs text-muted">Create your companion: who they are, who you are, and how you work together.</span>
                </button>
              </div>
              <div className="mt-5 flex justify-end">
                <button type="button" className="text-xs text-muted hover:text-ink-800 hover:underline" onClick={finish}>
                  Skip for now
                </button>
              </div>
            </>
          )}

          {step === "existing" && (
            <>
              <Dialog.Title className={heading}>Where is your agent?</Dialog.Title>
              <Dialog.Description className={text}>Hearthside connects to it there. Nothing is moved or copied.</Dialog.Description>
              <fieldset className="mt-4 grid gap-2">
                <legend className="sr-only">Where your agent is</legend>
                {EXISTING.map((item) => (
                  <label key={item.id} className={card(existingPlace === item.id)}>
                    <input
                      type="radio"
                      name="welcome-existing"
                      className="mt-1 accent-[var(--color-accent)]"
                      checked={existingPlace === item.id}
                      onChange={() => setExistingPlace(item.id)}
                    />
                    <span>
                      <span className="block text-sm font-medium text-ink-900">{item.title}</span>
                      <span className="block text-xs text-muted">{item.detail}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="mt-6 flex justify-between gap-2">
                <button type="button" className={secondary} onClick={() => setStep("welcome")}>
                  Back
                </button>
                <button type="button" className={primary} onClick={() => void chooseExisting()}>
                  Continue
                </button>
              </div>
            </>
          )}

          {step === "localExisting" && (
            <>
              <Dialog.Title className={heading}>Use your Letta Code folder</Dialog.Title>
              <Dialog.Description className={text}>
                Hearthside normally keeps its own Letta folder, so it can never change yours. To see the agents you made in Letta Code or Letta
                Desktop, it can use your folder (~/.letta) instead. It makes a backup copy first.
              </Dialog.Description>
              <ul className="mt-3 grid gap-1.5 text-xs text-ink-800">
                <li>Your agents, their memory and your chats appear here, the same ones Letta Code sees.</li>
                <li>
                  If a Telegram or Discord bot runs in Letta Code, keep it running in one place only: two apps answering the same bot clash.
                </li>
                <li>You can switch back any time in Settings → Diagnostics.</li>
              </ul>
              {switchNotice && (
                <p role="status" className="mt-3 rounded-xl bg-accent-subtle px-3 py-2 text-xs text-ink-800">
                  {switchNotice}
                </p>
              )}
              <div className="mt-6 flex justify-between gap-2">
                <button type="button" className={secondary} disabled={switching} onClick={() => setStep("existing")}>
                  Back
                </button>
                {settings?.useRealLettaHome ? (
                  <button type="button" className={primary} onClick={() => setStep("agent")}>
                    Continue
                  </button>
                ) : (
                  <button type="button" className={primary} disabled={switching} onClick={() => void useLettaCodeFolder()}>
                    {switching && <Spinner className="h-3.5 w-3.5" />}
                    {switching ? "Backing up…" : "Use my Letta Code folder"}
                  </button>
                )}
              </div>
            </>
          )}

          {step === "where" && (
            <>
              <Dialog.Title className={heading}>Where should your companion live?</Dialog.Title>
              <Dialog.Description className={text}>You can change this any time in Settings.</Dialog.Description>
              <fieldset className="mt-4 grid gap-2">
                <legend className="sr-only">Where agents live</legend>
                {PLACES.map((item) => (
                  <label key={item.id} className={card(place === item.id)}>
                    <input
                      type="radio"
                      name="welcome-place"
                      className="mt-1 accent-[var(--color-accent)]"
                      checked={place === item.id}
                      onChange={() => setPlace(item.id)}
                    />
                    <span>
                      <span className="block text-sm font-medium text-ink-900">{item.title}</span>
                      <span className="block text-xs text-muted">{item.detail}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="mt-6 flex justify-between gap-2">
                <button type="button" className={secondary} onClick={() => setStep("welcome")}>
                  Back
                </button>
                <button type="button" className={primary} onClick={() => void choosePlace()}>
                  Continue
                </button>
              </div>
            </>
          )}

          {step === "cloud" && settings && (
            <>
              <Dialog.Title className={heading}>Sign in to Letta Cloud</Dialog.Title>
              <Dialog.Description className={text}>
                Your browser opens Letta's sign-in page (it may say "Letta Mobile"). Come back here when it's done.
              </Dialog.Description>
              <div className="mt-4">
                <LettaSignIn settings={settings} />
              </div>
              <div className="mt-6 flex justify-between gap-2">
                <button type="button" className={secondary} onClick={() => setStep(path === "existing" ? "existing" : "where")}>
                  Back
                </button>
                <button type="button" className={primary} onClick={() => setStep("agent")}>
                  {settings.hasLettaSignIn ? "Continue" : "Skip for now"}
                </button>
              </div>
            </>
          )}

          {step === "model" && (
            <>
              <Dialog.Title className={heading}>Connect a model</Dialog.Title>
              <Dialog.Description className={text}>
                Your companion thinks with a model you connect: a ChatGPT plan, an API key, or a model running on this computer.
              </Dialog.Description>
              <ProvidersPanel />
              <div className="mt-6 flex justify-between gap-2">
                <button type="button" className={secondary} onClick={() => setStep("where")}>
                  Back
                </button>
                <button type="button" className={primary} onClick={() => setStep("agent")}>
                  Continue
                </button>
              </div>
            </>
          )}

          {step === "agent" && path === "existing" && (
            <>
              <Dialog.Title className={heading}>{agents.length > 0 ? "Your agents are here" : "No agents yet"}</Dialog.Title>
              <Dialog.Description className={text}>
                {agents.length > 0
                  ? `Found ${agents.length} agent${agents.length === 1 ? "" : "s"}. Switch between them at the top left; star the ones you use most.`
                  : "None showed up yet. If you just signed in or switched folders, give it a moment. You can also check Settings → Connection, or build a new companion."}
              </Dialog.Description>
              <div className="mt-6 flex justify-between gap-2">
                <button type="button" className={secondary} onClick={() => setStep(existingPlace === "local" ? "localExisting" : "cloud")}>
                  Back
                </button>
                <div className="flex gap-2">
                  {agents.length === 0 && (
                    <button type="button" className={secondary} onClick={buildCompanion}>
                      Create a companion
                    </button>
                  )}
                  <button type="button" className={primary} onClick={() => setStep("tips")}>
                    Continue
                  </button>
                </div>
              </div>
            </>
          )}

          {step === "agent" && path === "new" && (
            <>
              <Dialog.Title className={heading}>Make your companion</Dialog.Title>
              <Dialog.Description className={text}>
                Three short pages: who they are, who you are, and how you work together. Then you review exactly what goes into their memory.
                You can bring in past ChatGPT or Claude conversations afterwards, from Memory.
              </Dialog.Description>
              {blank && (
                <label className="mt-4 grid gap-1">
                  <span className="text-xs font-medium text-ink-700">Name</span>
                  <input autoFocus value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="My agent" className="field" />
                </label>
              )}
              {createError && <p className="mt-2 break-words text-xs text-error">{createError}</p>}
              <div className="mt-6 flex justify-between gap-2">
                <button type="button" className={secondary} onClick={() => setStep(place === "cloud" ? "cloud" : "model")}>
                  Back
                </button>
                <div className="flex gap-2">
                  {!blank ? (
                    <>
                      <button type="button" className={secondary} onClick={() => setBlank(true)}>
                        Just a blank agent
                      </button>
                      <button type="button" className={primary} onClick={buildCompanion}>
                        Start here
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className={secondary} onClick={() => setStep("tips")}>
                        Later
                      </button>
                      <button
                        type="button"
                        className={primary}
                        disabled={creating || !agentName.trim()}
                        onClick={async () => {
                          setCreating(true);
                          setCreateError(null);
                          try {
                            await createAgent({ name: agentName.trim() });
                            setStep("tips");
                          } catch (error) {
                            setCreateError(error instanceof Error ? error.message : String(error));
                          } finally {
                            setCreating(false);
                          }
                        }}
                      >
                        {creating ? "Creating…" : "Create agent"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {step === "tips" && (
            <>
              <Dialog.Title className={heading}>A few things to know</Dialog.Title>
              <ul className="mt-3 grid gap-2 text-sm text-ink-800">
                <li>
                  <span className="font-medium">Memory</span>, in the sidebar, shows everything your agent remembers as a web. Click any
                  file to read or edit it.
                </li>
                <li>
                  Type <span className="font-mono">/</span> in the message box for shortcuts like{" "}
                  <span className="font-mono">/remember</span> and <span className="font-mono">/dream</span>.
                </li>
                <li>Closing the window keeps Hearthside running by the clock, so your agent stays reachable.</li>
              </ul>
              <div className="mt-6 flex justify-end">
                <button type="button" className={primary} onClick={finish}>
                  Done
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
