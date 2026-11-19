// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { findAudio, type AudioSource } from "../lib/audio";
import { AudioPlayer } from "./AudioPlayer";
import {
  type AskUserQuestionResponse,
  parseAskUserQuestionNotif,
  parseAskUserQuestionReceipt,
} from "@letta-ai/letta-code/ask-user-question";
import { useAppStore } from "../store";
import { memo, useEffect, useMemo, useState } from "react";
import { Avatar } from "./Avatar";
import { parseChannelMessages, parseUserText, type ChannelAttachment } from "../lib/attachments";
import { GIF_FRAMES_NAME } from "../lib/gif-frames";
import { parseTaskNotifications, type TaskNotification } from "../lib/task-notification";
import { parseSkillContent, type SkillContent } from "../lib/skill-content";
import { channelName, channelReply } from "../lib/tools";
import { channelOperation, channelOutcome, channelTarget, isChannelAttempt } from "../lib/channel-delivery";
import { relativeToFolder } from "../lib/format";
import { TranscriptTimestamp } from "./TranscriptTime";
export { DaySeparator, TranscriptTimestamp } from "./TranscriptTime";
import { describeTool } from "../lib/tools";
import MDContent from "../render/markdown";
import type { ChatCompactionRow, ChatRow, ChatTextRow, ChatToolRow } from "../types";
import { QuestionForm } from "./QuestionForm";
import { CheckIcon, ChevronRightIcon, CloseIcon, FileIcon, ImageIcon, SendIcon, Spinner } from "./icons";

/** Hearthside: the person's answers to the agent's questions, shown compactly. */
function AnswerNote({ responses }: { responses: AskUserQuestionResponse[] }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl border border-border px-4 py-2.5 text-sm text-ink-800">
        {responses.map((response) =>
          response.status === "dismissed" ? (
            <p key={response.toolCallId} className="text-muted">You skipped the questions.</p>
          ) : (
            <dl key={response.toolCallId} className="grid gap-1">
              {response.questions.map((question) => (
                <div key={question.question}>
                  <dt className="text-xs text-muted">{question.header || question.question}</dt>
                  <dd className="font-medium">{response.answers?.[question.question]}</dd>
                </div>
              ))}
            </dl>
          ),
        )}
      </div>
    </div>
  );
}

function AttachmentChip({ name, kind }: { name: string; kind: "file" | "image" }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-surface px-2 py-1 text-xs text-ink-700">
      {kind === "image" ? <ImageIcon className="h-3.5 w-3.5 shrink-0" /> : <FileIcon className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Hearthside: a tool that finished after the reply (an image, a voice message). */
function BackgroundNote({ note }: { note: TaskNotification }) {
  const [details, setDetails] = useState(false);
  const failed = note.status !== "completed";
  const label = note.toolName ? describeTool(note.toolName, {}).label : "A task";
  // The player reads the saved file, so keep one source for as long as the note shows it.
  const audio = useMemo<AudioSource | null>(() => (note.audio ? { kind: "file", value: note.audio } : null), [note.audio]);
  return (
    <div className="grid justify-items-start gap-1">
      {note.image && !failed && <SavedImage path={note.image} alt={label} />}
      {/* A voice message made in the background plays here, from the file the tool saved. */}
      {audio && !failed && <AudioPlayer source={audio} {...(label === "Made a voice message" ? {} : { label: "Audio" })} />}
      <span className="flex gap-3 pl-1 text-[11px] text-muted-light">
        <span className={failed ? "text-error" : undefined}>
          {failed ? `Didn't finish in the background · ${label}` : `Finished in the background · ${label}`}
        </span>
        {note.result && (
          <button type="button" className="hover:text-ink-700 hover:underline" onClick={() => setDetails(!details)}>
            {details ? "Hide details" : "Details"}
          </button>
        )}
      </span>
      {details && <pre className="max-w-full whitespace-pre-wrap break-words rounded-xl bg-surface-secondary px-3 py-2 text-xs text-ink-800">{note.result}</pre>}
    </div>
  );
}

function sizeLabel(bytes: number | null): string {
  if (!bytes) return "";
  return bytes < 1024 * 1024 ? ` · ${Math.max(1, Math.round(bytes / 1024))} KB` : ` · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Hearthside: a photo, video or file that came in on Telegram/Discord. A picture
 * whose file is on this computer is shown; anything else (a video, or a file
 * kept on the server the bot runs on) is a small labelled chip.
 */
function ChannelAttachmentView({ attachment }: { attachment: ChannelAttachment }) {
  const isPicture = attachment.kind === "image" || attachment.kind === "photo" || (attachment.mimeType ?? "").startsWith("image/");
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!isPicture || !attachment.path) {
      setMissing(true);
      return;
    }
    let live = true;
    void window.bridge
      .readImageFile(attachment.path)
      .then((url) => live && setSrc(url))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [attachment.path, isPicture]);
  if (src) return <img src={src} alt={attachment.name} title={attachment.name} className="max-h-72 max-w-[320px] rounded-2xl border border-border bg-surface-secondary" />;
  if (!missing) return <div className="h-32 w-48 animate-pulse rounded-2xl border border-border bg-surface-secondary" />;
  const kind = isPicture ? "Picture" : attachment.kind === "video" ? "Video" : attachment.kind === "voice" || attachment.kind === "audio" ? "Voice message" : "File";
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-xl border border-border bg-surface-secondary px-2.5 py-1.5 text-xs text-ink-800"
      title={isPicture && attachment.path ? "The picture is kept where the bot runs, not on this computer." : attachment.name}
    >
      {isPicture ? <ImageIcon className="h-3.5 w-3.5 shrink-0 text-muted" /> : <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted" />}
      <span className="truncate">
        {kind} · {attachment.name}
        {sizeLabel(attachment.size)}
      </span>
    </span>
  );
}

/** Hearthside: the agent loaded a skill; its text is one click away instead of filling the chat. */
function SkillNote({ skill }: { skill: SkillContent }) {
  const [details, setDetails] = useState(false);
  return (
    <div className="grid justify-items-start gap-1">
      <span className="flex gap-3 pl-1 text-[11px] text-muted-light">
        <span>Loaded the skill · {skill.name}</span>
        <button type="button" className="hover:text-ink-700 hover:underline" onClick={() => setDetails(!details)}>
          {details ? "Hide" : "Show"}
        </button>
      </span>
      {details && <pre className="max-h-72 max-w-full overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-surface-secondary px-3 py-2 text-xs text-ink-800">{skill.content}</pre>}
    </div>
  );
}

const UserMessage = ({ row }: { row: ChatTextRow }) => {
  // Hearthside: the person's own picture, when they chose one.
  const myPicture = useAppStore((state) => state.looks?.me.avatar ?? null);
  if (row.source === "controller") return (
    <details className="min-w-0 rounded-xl border border-border bg-surface-secondary p-3 text-xs text-muted">
      <summary className="cursor-pointer font-medium">Automatic follow-up · app controller, not you</summary>
      <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{row.text}</p>
    </details>
  );
  // Legacy formatting is not trusted provenance. Keep the exact text accessible;
  // quoted, fenced, embedded and nested markup remains ordinary user content.
  if (/^<system-alert>[^<>]*<\/system-alert>$/.test(row.text.trim())) return (
    <details className="min-w-0 rounded-xl border border-border bg-surface-secondary p-3 text-xs text-muted">
      <summary className="cursor-pointer font-medium">Legacy control text · origin unverified</summary>
      <pre className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{row.text}</pre>
    </details>
  );
  const responses = parseAskUserQuestionNotif(row.text);
  if (responses.length > 0) return <AnswerNote responses={responses} />;
  const skill = parseSkillContent(row.text);
  if (skill) {
    return (
      <div className="grid gap-2">
        <SkillNote skill={skill} />
        {skill.rest && <UserMessage row={{ ...row, text: skill.rest }} />}
      </div>
    );
  }
  const background = parseTaskNotifications(row.text);
  if (background.length > 0) {
    return (
      <div className="grid gap-2">
        {background.map((note, index) => (
          <BackgroundNote key={index} note={note} />
        ))}
      </div>
    );
  }
  // Hearthside: messages from Telegram or Discord, shown as messages with where they came from.
  const fromChannel = parseChannelMessages(row.text);
  if (fromChannel.length > 0) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {fromChannel.map((message, index) => (
          <div key={index} className="flex max-w-[85%] flex-col items-end gap-0.5">
            <span className="flex items-center gap-1 text-[11px] text-muted">
              <SendIcon className="h-3 w-3 text-accent" />
              via {channelName(message.source)}
              {message.sender ? ` · ${message.sender}` : ""}
            </span>
            {message.attachments.map((attachment, index) => (
              <ChannelAttachmentView key={index} attachment={attachment} />
            ))}
            {message.text && (
              <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-2xl bg-surface-tertiary px-4 py-2.5 text-ink-900">{message.text}</div>
            )}
          </div>
        ))}
      </div>
    );
  }
  const parsed = parseUserText(row.text);
  // Images just sent show as pictures; from history only their names are known.
  // A GIF's frames are for the agent; the person sees the GIF itself.
  const forAgent = (name: string) => parsed.gifs.length > 0 && name === GIF_FRAMES_NAME;
  const shownImages = (row.images ?? []).filter((image) => !forAgent(image.name));
  const namedImages = parsed.images.filter((name) => !forAgent(name) && !shownImages.some((image) => image.name === name));
  return (
    <div className="flex items-start justify-end gap-3">
    <div className="flex min-w-0 flex-1 flex-col items-end gap-1.5">
      {parsed.gifs.map((gif, index) => (
        <img key={`g${index}`} src={gif.url} alt={gif.title} title={gif.title} loading="lazy" className="max-h-64 max-w-[280px] rounded-2xl border border-border bg-surface-secondary" />
      ))}
      {shownImages.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {shownImages.map((image, index) => (
            <img
              key={index}
              src={`data:${image.mediaType};base64,${image.data}`}
              alt={image.name}
              className="max-h-48 max-w-[16rem] rounded-xl border border-border object-cover"
            />
          ))}
        </div>
      )}
      {(parsed.text || parsed.files.length > 0 || namedImages.length > 0) && (
        <div className="max-w-[85%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-2xl bg-surface-tertiary px-4 py-2.5 text-ink-900">
          {parsed.text}
          {(parsed.files.length > 0 || namedImages.length > 0) && (
            <div className={`flex flex-wrap gap-1.5 ${parsed.text ? "mt-2" : ""}`}>
              {parsed.files.map((file, index) => (
                <AttachmentChip key={`f${index}`} name={file.name} kind="file" />
              ))}
              {namedImages.map((name, index) => (
                <AttachmentChip key={`i${index}`} name={name} kind="image" />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
    {myPicture && <Avatar name="You" src={myPicture} px={28} className="mt-0.5" />}
    </div>
  );
};

/** Hearthside: questions the agent posted, answered right in the chat. */
function QuestionCard({ row, answer }: { row: ChatToolRow; answer?: AskUserQuestionResponse }) {
  const receipt = parseAskUserQuestionReceipt(row.result?.content ?? "");
  const answerQuestion = useAppStore((state) => state.answerQuestion);
  if (!receipt) return null;
  if (answer) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <CheckIcon className="h-3.5 w-3.5 text-success" />
        {answer.status === "answered" ? "You answered the agent's questions" : "You skipped the agent's questions"}
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-accent/30 bg-surface p-4 shadow-card">
      <QuestionForm
        questions={receipt.questions}
        onAnswer={(answers) => answerQuestion(receipt.toolCallId, receipt.questions, answers)}
        onSkip={() => answerQuestion(receipt.toolCallId, receipt.questions, null)}
      />
    </div>
  );
}

const AssistantMessage = ({ row }: { row: ChatTextRow }) => {
  // Hearthside: the companion's picture beside each reply, and a soft backing
  // for the text when a chat background is on.
  const name = useAppStore((state) => state.agents.find((agent) => agent.id === state.agentId)?.name) ?? "Agent";
  const look = useAppStore((state) => (state.agentId ? state.looks?.agents[state.agentId] : undefined));
  // Over a background picture the text gets a light translucent backing.
  const body = (
    <div className={`min-w-0 break-words [overflow-wrap:anywhere] ${look?.background ? "rounded-2xl bg-surface/70 px-4 py-3 backdrop-blur-sm" : ""}`}>
      <MDContent text={row.text} />
    </div>
  );
  if (!look?.avatar) return body;
  return (
    <div className="flex items-start gap-3">
      <Avatar name={name} src={look.avatar} px={28} className="mt-0.5" />
      {body}
    </div>
  );
};

/**
 * Hearthside: the agent's reply to the person on Telegram or Discord (a
 * MessageChannel call), shown as the agent's own message, the way the person's
 * channel messages show as theirs. If it didn't go through, that's said.
 */
function ChannelReply({ row, pending }: { row: ChatToolRow; pending: boolean }) {
  const name = useAppStore((state) => state.agents.find((agent) => agent.id === state.agentId)?.name) ?? "Agent";
  const look = useAppStore((state) => (state.agentId ? state.looks?.agents[state.agentId] : undefined));
  const failed = row.result?.isError === true;
  const reply = channelReply(row.toolName, row.toolInput);
  const description = describeTool(row.toolName, row.toolInput);
  // Non-message actions previously used ToolWithAudio. Keep their media output.
  const audio = !reply && row.result && !row.result.isError ? findAudio(row.result.content) : [];

  const target = channelTarget(row.toolInput);
  // "via Telegram" only when every requested identifier is well formed; otherwise the details say what is wrong.
  const channel = target.startsWith("Requested destination") && typeof row.toolInput.channel === "string" ? channelName(row.toolInput.channel) : null;
  const operation = channelOperation(row.toolInput);
  const header = [channel ? `via ${channel}` : null, channelOutcome(row, pending), operation === "Message attempt" ? null : operation].filter(Boolean).join(" · ");
  const body = (
    <div className="flex min-w-0 max-w-[85%] flex-col items-start gap-0.5">
      <span className="flex items-center gap-1 text-[11px] text-muted">
        <SendIcon className="h-3 w-3 text-accent" />
        {header}
      </span>
      {reply ? (
        <div className={`min-w-0 break-words [overflow-wrap:anywhere] rounded-2xl px-4 py-2.5 ${look?.background ? "bg-surface/70 backdrop-blur-sm" : "bg-surface-secondary"}`}>
          <MDContent text={reply.message} />
        </div>
      ) : <span className="text-sm text-ink-800">{description.detail || (operation === "Message attempt" ? "Message missing or invalid" : "See attempt details")}</span>}
      {audio.map((source) => <AudioPlayer key={source.value.slice(0, 200)} source={source} />)}
      {failed && <span className="text-[11px] text-error">Didn't go through: {(row.result?.content ?? "").slice(0, 200)}</span>}
      <details className="max-w-full text-xs text-muted">
        <summary className="cursor-pointer">Attempt details</summary>
        <p className="mt-1 [overflow-wrap:anywhere]">{target}</p>
        {row.result?.isError === false && <p className="mt-1">Tool acceptance is not proof of delivery or reading.</p>}
        <p className="mt-1 [overflow-wrap:anywhere]">{operation} · <span className="font-mono">{row.toolName} · {row.toolCallId}</span></p>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(row.toolInput, null, 2)}</pre>
        {row.result && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{row.result.content}</pre>}
      </details>
    </div>
  );
  if (!look?.avatar) return body;
  return (
    <div className="flex items-start gap-3">
      <Avatar name={name} src={look.avatar} px={28} className="mt-0.5" />
      {body}
    </div>
  );
}

/** Hearthside: older messages were summarised to make room; the summary can be opened. */
function Compaction({ row }: { row: ChatCompactionRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-muted">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-1 rounded-full px-2 py-0.5 hover:bg-surface-tertiary hover:text-ink-700"
          title="To make room, older messages were summarised. They can still be found by searching."
        >
          <ChevronRightIcon className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
          Earlier messages were summarised
        </button>
        <span className="h-px flex-1 bg-border" />
      </div>
      {open && (
        <div className="mx-auto mt-2 max-w-2xl whitespace-pre-wrap break-words rounded-xl bg-surface-secondary px-4 py-3 text-sm text-ink-700">
          {row.summary || "(No summary text was kept.)"}
        </div>
      )}
    </div>
  );
}

function Reasoning({ row, active }: { row: ChatTextRow; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-muted hover:text-ink-700 transition-colors"
      >
        <ChevronRightIcon className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className={active ? "animate-pulse" : ""}>{active ? "Thinking" : "Thought"}</span>
      </button>
      {open && (
        <div className="mt-2 whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-ink-600">
          {row.text}
        </div>
      )}
    </div>
  );
}

function ToolStatus({ row, running }: { row: ChatToolRow; running: boolean }) {
  if (row.result) {
    return row.result.isError ? (
      <CloseIcon className="h-3.5 w-3.5 shrink-0 text-error" />
    ) : (
      <CheckIcon className="h-3.5 w-3.5 shrink-0 text-success" />
    );
  }
  // A call with no result is only in flight while its turn is.
  return running ? (
    <Spinner className="h-3.5 w-3.5 shrink-0 text-muted" />
  ) : (
    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-light" title="No result" />
  );
}

function ToolCall({ row, running, cwd }: { row: ChatToolRow; running: boolean; cwd: string }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const description = describeTool(row.toolName, row.toolInput);
  const summary = relativeToFolder(description.detail, cwd);
  const hasInput = Object.keys(row.toolInput).length > 0;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-secondary text-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-tertiary transition-colors"
      >
        <ToolStatus row={row} running={running} />
        {description.channel && <SendIcon className="h-3.5 w-3.5 shrink-0 text-accent" />}
        <span className="shrink-0 font-medium text-ink-800" title={row.toolName}>{description.label}</span>
        {description.account && <span className="shrink-0 text-xs text-muted">({description.account})</span>}
        <span className={`min-w-0 flex-1 truncate text-xs text-muted ${description.channel ? "" : "font-mono"}`}>{summary}</span>
        <ChevronRightIcon
          className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && description.message !== undefined && !raw && (
        // Hearthside: a channel message reads as a message, not as JSON.
        <div className="grid gap-2 border-t border-border px-3 py-2.5">
          <div className="min-w-0 break-words text-ink-800">
            <MDContent text={description.message} />
          </div>
          {row.result?.isError && <p className="text-xs text-error">{row.result.content}</p>}
          <button type="button" className="justify-self-start text-xs text-muted hover:text-ink-800 hover:underline" onClick={() => setRaw(true)}>
            Show details
          </button>
        </div>
      )}
      {open && (description.message === undefined || raw) && (
        <div className="grid gap-2 border-t border-border px-3 py-2.5">
          {hasInput && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-ink-700">
              {JSON.stringify(row.toolInput, null, 2)}
            </pre>
          )}
          {row.result && (
            <pre
              className={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-tertiary p-2.5 font-mono text-xs ${row.result.isError ? "text-error" : "text-ink-700"}`}
            >
              {row.result.content || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Hearthside: a tool call, plus a player for any audio it made. */
/** Hearthside: an image the agent made (Codex or Grok), shown in the chat. */
function SavedImage({ path, alt }: { path: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.bridge
      .readImageFile(path)
      .then((url) => live && setSrc(url))
      .catch((failure: unknown) => live && setError((failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
    return () => {
      live = false;
    };
  }, [path]);
  return src ? (
    <img src={src} alt={alt} title={alt} className="max-h-96 max-w-[420px] rounded-2xl border border-border bg-surface-secondary" />
  ) : (
    <div className="flex h-40 w-64 items-center justify-center rounded-2xl border border-border bg-surface-secondary text-xs text-muted">{error ?? "Loading image…"}</div>
  );
}

/**
 * Hearthside: a picture the agent opened with ViewImage. Letta keeps only
 * "[Image omitted]" in the history, so the picture comes from the file itself:
 * shown when it is on this computer; when the tool ran elsewhere (a bot on a
 * server), the usual card says where it is.
 */
function ViewedImage({ row, path, running, cwd }: { row: ChatToolRow; path: string; running: boolean; cwd: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    let live = true;
    void window.bridge
      .readImageFile(path)
      .then((url) => live && setSrc(url))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [path]);
  if (missing || (!src && row.result?.isError)) {
    return (
      <div className="grid gap-1">
        <ToolCall row={row} running={running} cwd={cwd} />
        <span className="pl-1 text-[11px] text-muted-light">The picture stays where the tool ran (not on this computer), so it can't be shown here.</span>
      </div>
    );
  }
  const name = path.split(/[\\/]/).pop() ?? "Picture";
  return (
    <div className="grid justify-items-start gap-1">
      {src ? (
        <img src={src} alt={name} title={`Looked at ${name}`} className="max-h-80 max-w-[420px] rounded-2xl border border-border bg-surface-secondary" />
      ) : (
        <div className="h-40 w-56 animate-pulse rounded-2xl border border-border bg-surface-secondary" />
      )}
      <button type="button" className="pl-1 text-[11px] text-muted-light hover:text-ink-700 hover:underline" onClick={() => setDetails(!details)}>
        {details ? "Hide details" : `Looked at ${name}`}
      </button>
      {details && (
        <div className="w-full">
          <ToolCall row={row} running={running} cwd={cwd} />
        </div>
      )}
    </div>
  );
}

function GeneratedImage({ row, path, running, cwd }: { row: ChatToolRow; path: string; running: boolean; cwd: string }) {
  const [details, setDetails] = useState(false);
  const prompt = typeof row.toolInput.prompt === "string" ? row.toolInput.prompt : "Image";
  return (
    <div className="grid justify-items-start gap-1">
      <SavedImage path={path} alt={prompt} />
      <button type="button" className="pl-1 text-[11px] text-muted-light hover:text-ink-700 hover:underline" onClick={() => setDetails(!details)}>
        {details ? "Hide details" : "Details"}
      </button>
      {details && (
        <div className="w-full">
          <ToolCall row={row} running={running} cwd={cwd} />
        </div>
      )}
    </div>
  );
}

/** Hearthside: a GIF the agent sent, shown like in a messaging app. */
function GifMessage({ row, url, running, cwd }: { row: ChatToolRow; url: string; running: boolean; cwd: string }) {
  const [details, setDetails] = useState(false);
  const query = typeof row.toolInput.query === "string" ? row.toolInput.query : "GIF";
  return (
    <div className="grid justify-items-start gap-1">
      <img src={url} alt={query} title={query} loading="lazy" className="max-h-64 max-w-[280px] rounded-2xl border border-border bg-surface-secondary" />
      <span className="flex gap-3 pl-1 text-[11px] text-muted-light">
        <a href="https://klipy.com" target="_blank" rel="noreferrer" className="hover:text-ink-700 hover:underline">
          Powered by KLIPY
        </a>
        <button type="button" className="hover:text-ink-700 hover:underline" onClick={() => setDetails(!details)}>
          {details ? "Hide details" : "Details"}
        </button>
      </span>
      {details && (
        <div className="w-full">
          <ToolCall row={row} running={running} cwd={cwd} />
        </div>
      )}
    </div>
  );
}

function ToolWithAudio({ row, running, cwd }: { row: ChatToolRow; running: boolean; cwd: string }) {
  const [details, setDetails] = useState(false);
  const gif = row.toolName === "send_gif" && row.result && !row.result.isError ? /GIF link: (https:\/\/static\.klipy\.com\/\S+)/.exec(row.result.content)?.[1] : undefined;
  if (gif) return <GifMessage row={row} url={gif} running={running} cwd={cwd} />;
  const image = row.toolName === "generate_image" && row.result && !row.result.isError ? /Image saved as: (.+\.(?:png|jpe?g|webp))\s*$/im.exec(row.result.content)?.[1] : undefined;
  if (image) return <GeneratedImage row={row} path={image.trim()} running={running} cwd={cwd} />;
  // Hearthside: a picture the agent looked at (frames from a video, a screenshot): show it, as the old app did.
  const viewed = (row.toolName === "ViewImage" || row.toolName === "view_image") && typeof row.toolInput.path === "string" ? row.toolInput.path : undefined;
  if (viewed) return <ViewedImage row={row} path={viewed} running={running} cwd={cwd} />;
  const sources = row.result && !row.result.isError ? findAudio(row.result.content) : [];
  if (sources.length === 0) return <ToolCall row={row} running={running} cwd={cwd} />;
  const description = describeTool(row.toolName, row.toolInput);
  // A voice message reads as a voice note; the tool call itself is one click away.
  if (description.label === "Made a voice message") {
    const spoken = typeof row.toolInput.text === "string" ? row.toolInput.text : typeof row.toolInput.prompt === "string" ? row.toolInput.prompt : undefined;
    return (
      <div className="grid justify-items-start gap-1">
        {sources.map((source) => (
          <AudioPlayer key={source.value.slice(0, 200)} source={source} transcript={spoken} />
        ))}
        <button type="button" className="pl-1 text-[11px] text-muted-light hover:text-ink-700 hover:underline" onClick={() => setDetails(!details)}>
          {details ? "Hide details" : "Details"}
        </button>
        {details && (
          <div className="w-full">
            <ToolCall row={row} running={running} cwd={cwd} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <ToolCall row={row} running={running} cwd={cwd} />
      {sources.map((source) => (
        <AudioPlayer key={source.value.slice(0, 200)} source={source} label="Audio" />
      ))}
    </div>
  );
}

/**
 * One transcript row. `active` marks the last row of a running turn, which is
 * the only row still being written.
 */
export const TranscriptRow = memo(function TranscriptRow({
  row,
  active,
  running,
  channelPending = false,
  cwd,
  answer,
}: {
  row: ChatRow;
  active: boolean;
  running: boolean;
  /** Only a channel call observed live in the current turn may show Sending. */
  channelPending?: boolean;
  /** The chat's working folder, used to shorten the paths tools report. */
  cwd: string;
  /** Hearthside: for a question card, the person's answer if they gave one. */
  answer?: AskUserQuestionResponse;
}) {
  const showReasoning = useAppStore((state) => state.settings?.showReasoning ?? true);
  const showCompactions = useAppStore((state) => state.settings?.showCompactions ?? true);
  switch (row.kind) {
    case "user":
      return (
        <div className="group/message">
          <UserMessage row={row} />
          <div className="text-right"><TranscriptTimestamp date={row.date} /></div>
        </div>
      );
    case "assistant":
      return (
        <div className="group/message">
          <AssistantMessage row={row} />
          <TranscriptTimestamp date={row.date} />
        </div>
      );
    case "reasoning":
      // Hearthside: hidden when the person turns off "Show the agent's reasoning".
      return showReasoning ? <Reasoning row={row} active={active} /> : null;
    case "compaction":
      return showCompactions ? <Compaction row={row} /> : null;
    case "tool_call": {
      if (isQuestionRow(row)) return <QuestionCard row={row} answer={answer} />;
      if (isChannelAttempt(row)) return <ChannelReply row={row} pending={channelPending} />;
      return <ToolWithAudio row={row} running={running} cwd={cwd} />;
    }
  }
});

/** Hearthside: a posted AskUserQuestion, which renders as a question card. */
export function isQuestionRow(row: ChatRow): row is ChatToolRow {
  return (
    row.kind === "tool_call" &&
    (row.toolName === "AskUserQuestion" || row.toolName === "AskUserQuestionAsync") &&
    parseAskUserQuestionReceipt(row.result?.content ?? "") !== null
  );
}

/** Hearthside: the id answers refer to (the receipt's, which the runtime chose). */
export function questionId(row: ChatToolRow): string {
  return parseAskUserQuestionReceipt(row.result?.content ?? "")?.toolCallId ?? row.toolCallId;
}

/** Hearthside: answers the person has sent, by the question's tool call id. */
export function questionAnswers(rows: readonly ChatRow[]): Map<string, AskUserQuestionResponse> {
  const answers = new Map<string, AskUserQuestionResponse>();
  for (const row of rows) {
    if (row.kind !== "user" || !row.text.includes("<ask-user-question-response>")) continue;
    for (const response of parseAskUserQuestionNotif(row.text)) answers.set(response.toolCallId, response);
  }
  return answers;
}
