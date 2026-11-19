// The renderer ⇄ main boundary. Types describe the API; the zod schemas below
// are enforced by the main process on every call, so a compromised or buggy
// renderer cannot send malformed or out-of-bounds arguments.
import { z } from "zod";
export { validChatIcon } from "./chat-icon";
import { REASONING_EFFORTS } from "./types";
import type { AppRequests } from "./types";

export type * from "./types";
export { ATTRIBUTION_NOTE, BRANCH_NOTE, REASONING_EFFORTS } from "./types";
export { DEFAULT_FOLLOWUP_POLICY } from "./intentions";

/** Runtime protocol versions this build understands (letta-code App Server). */
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

const id = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().max(max);
const backend = z.enum(["local", "cloud", "remote"]);
const permissionMode = z.enum(["standard", "acceptEdits", "unrestricted", "strict"]);

/** A path inside an agent's memory folder: relative, no `..`, no drive or root. */
export const memoryPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((p) => !/^([a-zA-Z]:)?[\\/]/.test(p), "Memory paths must be relative.")
  .refine((p) => !p.split(/[\\/]/).includes(".."), "Memory paths cannot contain '..'.");

// Mods. A mod file is one plain file name directly inside the runtime's mods
// folder: no separators, no "..", and one of the extensions the runtime loads
// (@letta-ai/letta-code dist/types/mods/file-extensions.d.ts).
const modScope = z.enum(["machine", "agent"]);
export const modFileName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\\/]+$/, "A mod file name cannot contain a path.")
  .refine((name) => name !== "." && name !== "..", "Not a file name.")
  .refine((name) => !name.startsWith("."), "Hidden files are not mods.")
  .refine((name) => /\.(js|mjs|ts|tsx)$/.test(name), "Mods are .js, .mjs, .ts or .tsx files.");
/** The runtime's own rule for a mod command id (letta.js validateModCommandId). */
const modCommandId = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "Not a command name.");

const settingsUpdate = z
  .object({
    backend: backend.optional(),
    executionComputer: z.object({ deviceId: id, name: z.string().trim().min(1).max(200) }).strict().nullable().optional(),
    serverUrl: text(2_000).optional(),
    apiBaseUrl: text(2_000).optional(),
    apiKey: text(1_000).nullable().optional(),
    serverToken: text(1_000).nullable().optional(),
    permissionMode: permissionMode.optional(),
    agentId: id.nullable().optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
    textSize: z.enum(["small", "medium", "large"]).optional(),
    showReasoning: z.boolean().optional(),
    closeToTray: z.boolean().optional(),
    reachableComputer: z.boolean().optional(),
    computerName: text(80).optional(),
    favouriteAgents: z.array(id).max(500).optional(),
    showUsage: z.boolean().optional(),
    showCompactions: z.boolean().optional(),
    notifications: z.boolean().optional(),
    startAtLogin: z.boolean().optional(),
    welcomed: z.boolean().optional(),
    toured: z.boolean().optional(),
    runtimeDebugLog: z.boolean().optional(),
    useRealLettaHome: z.boolean().optional(),
    gifs: z.boolean().optional(),
    gifFilter: z.enum(["high", "medium", "low", "off"]).optional(),
    weather: z.boolean().optional(),
    homeTown: text(100).optional(),
    obsidianVault: text(4_000).optional(),
    imageEngine: z.enum(["off", "codex", "grok"]).optional(),
  })
  .strict();

// Hearthside: pictures and chat backgrounds. Images arrive already resized by the
// window (256 px pictures, 1920 px backgrounds); the length limit is a safety net.
const lookKind = z.enum(["avatar", "background"]);
const lookDataUrl = z.string().max(4_000_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/, "Not a picture.");
const lookStyle = z
  .object({
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
    blur: z.number().min(0).max(40).optional(),
  })
  .strict();

const connectorInput = z
  .object({
    id: id.optional(),
    name: text(100),
    kind: z.enum(["command", "url"]),
    commandLine: text(4_000).optional(),
    url: text(2_000).optional(),
    transport: z.enum(["http", "sse"]).optional(),
    envText: text(20_000).optional(),
    headersText: text(20_000).optional(),
    agentIds: z.array(id).max(500),
    preset: text(40).optional(),
  })
  .strict();

const agentUpdate = z
  .object({
    name: text(200).optional(),
    description: text(2_000).optional(),
    model: text(300).optional(),
    system: text(200_000).optional(),
    contextWindowLimit: z.number().int().min(4_000).max(10_000_000).optional(),
  })
  .strict();

const dreamSettings = z
  .object({
    trigger: z.enum(["off", "step-count", "compaction-event"]),
    stepCount: z.number().int().min(1).max(10_000),
    merge: z.enum(["auto", "explicit"]),
    mergeInstructions: z.string().max(10_000),
  })
  .strict();

const approvalDecision = z.discriminatedUnion("behavior", [
  z
    .object({
      behavior: z.literal("allow"),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      suggestionIds: z.array(id).max(50).optional(),
    })
    .strict(),
  z.object({ behavior: z.literal("deny"), message: text(5_000).optional() }).strict(),
]);

// Hearthside: attachments. Images up to ~5 MB each (base64), text files up to 200 KB.
const attachment = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("image"),
      name: text(260),
      mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
      data: z.string().min(1).max(7_000_000).regex(/^[A-Za-z0-9+/=]+$/, "Not base64."),
    })
    .strict(),
  z.object({ kind: z.literal("text"), name: text(260), text: z.string().max(200_000) }).strict(),
  // PDFs up to 20 MB (base64).
  z
    .object({ kind: z.literal("pdf"), name: text(260), data: z.string().min(1).max(28_000_000).regex(/^[A-Za-z0-9+/=]+$/, "Not base64.") })
    .strict(),
]);

const sendMessageInput = z
  .object({
    agentId: id,
    conversationId: id.nullable(),
    text: z.string().trim().max(100_000),
    otid: id,
    cwd: text(4_000),
    model: text(300).optional(),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
    attachments: z.array(attachment).max(8).optional(),
  })
  .strict()
  .refine((input) => input.text.length > 0 || (input.attachments?.length ?? 0) > 0, "Message is empty.");

// Hearthside: schedules.
const scheduleInput = z
  .object({
    agentId: id,
    conversationId: id.nullable().optional(),
    name: text(200),
    description: text(2_000).optional(),
    cron: z.string().trim().min(9).max(100).regex(/^\S+(\s+\S+){4}$/, "Five cron fields expected."),
    timezone: text(100).optional(),
    recurring: z.boolean(),
    prompt: z.string().trim().min(1).max(20_000),
    scheduledFor: z.string().max(100).nullable().optional(),
  })
  .strict();

/** Argument schemas for every request, as tuples matching the method's parameters. */
const followupDate = z.string().datetime({ offset: true });
const followupFields = {
  summary: z.string().trim().min(1).max(1000), action: z.string().trim().min(1).max(1000),
  eventAt: followupDate.nullable(), notBefore: followupDate.nullable(), expiresAt: followupDate,
  timezone: z.string().min(1).max(100), sourceMessageId: id, sourceAt: followupDate,
};
const followupPolicy = z.object({
  enabled: z.boolean(), extractAutomatically: z.boolean().optional(), autoActivate: z.boolean(), proactive: z.boolean(), timezone: z.string().min(1).max(100),
  quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  dailyLimit: z.number().int().min(1).max(5), topicExclusions: z.array(z.string().trim().min(1).max(100)).max(30),
  semanticModel: z.string().trim().min(1).max(300).nullable().optional(),
  dailyClassifierLimit: z.number().int().min(1).max(200).optional(),
  automaticNotes: z.boolean().optional(),
}).strict();
export const requestSchemas = {
  getFollowups: z.tuple([id, id]),
  saveFollowupPolicy: z.tuple([id, id, followupPolicy]),
  createFollowup: z.tuple([id, id, z.object(followupFields).strict()]),
  updateFollowup: z.tuple([id, id, id, z.number().int().min(1), z.object(followupFields).omit({ sourceMessageId: true, sourceAt: true }).partial().strict()]),
  changeFollowup: z.tuple([id, id, id, z.number().int().min(1), z.enum(["adopt", "defer", "resolve", "cancel"]), followupDate.optional()]),
  scanFollowups: z.tuple([id, id]),
  getSettings: z.tuple([]),
  getChatPreferences: z.tuple([z.string().min(1).max(200).refine((id) => id !== "__proto__"), z.string().min(1).max(200)]),
  setChatPreference: z.tuple([z.string().min(1).max(200).refine((id) => id !== "__proto__"), z.string().min(1).max(200).refine((id) => id !== "__proto__"), z.string().min(1).max(200),
    z.object({ pinned: z.boolean().optional(), starred: z.boolean().optional(), icon: z.string().min(1).max(64).nullable().optional() }).strict()]),
  listExecutionComputers: z.tuple([]),
  getConversationExecution: z.tuple([id]),
  getConversationAgent: z.tuple([id]),
  setConversationExecution: z.tuple([id, z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("follow-owner") }).strict(),
    z.object({ kind: z.literal("default") }).strict(),
    z.object({ kind: z.literal("desktop") }).strict(),
    z.object({ kind: z.literal("desktop-listener") }).strict(),
    z.object({ kind: z.literal("cloud") }).strict(),
    z.object({ kind: z.literal("computer"), deviceId: id, name: z.string().trim().min(1).max(200) }).strict(),
  ])]),
  listExecutionPlaces: z.tuple([id]),
  // The place ID is minted by the main process and echoed back; it is matched
  // against the live list rather than parsed, so it carries no authority.
  moveConversation: z.tuple([id, z.string().trim().min(1).max(200)]),
  updateSettings: z.tuple([settingsUpdate]),
  getConnection: z.tuple([]),
  reconnect: z.tuple([]),
  listAgents: z.tuple([]),
  createAgent: z.tuple([
    z
      .object({
        name: text(200),
        model: text(300).optional(),
        // Full custom Companion prompt or an explicit advanced override; omitted for Letta default.
        systemPrompt: text(60_000).optional(),
        coreMemory: z.array(z.object({
          label: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          value: text(60_000), description: text(2_000).optional(),
        }).strict()).max(20).optional(),
        // Hearthside: starting memory files at the memory root (the companion builder).
        memory: z
          .array(z.object({ path: z.string().regex(/^(MEMORY|[a-z][a-z0-9-]{0,40})\.md$/), content: text(60_000) }).strict())
          .max(8)
          .optional(),
      })
      .strict(),
  ]),
  getAgent: z.tuple([id]),
  restoreCompanionPrompt: z.tuple([id, text(200_000), text(200_000), z.literal(true)]),
  updateAgent: z.tuple([id, agentUpdate]),
  deleteAgent: z.tuple([id]),
  listModels: z.union([z.tuple([]), z.tuple([z.boolean().optional()])]),
  listProviders: z.tuple([]),
  connectProvider: z.tuple([
    z
      .object({
        providerId: id,
        authMethodId: id.optional(),
        fields: z.record(z.string().max(100), z.string().max(4_000)),
      })
      .strict(),
  ]),
  disconnectProvider: z.tuple([z.object({ providerId: id, providerName: id.optional() }).strict()]),
  getGptUsage: z.union([z.tuple([]), z.tuple([z.boolean().optional()])]),
  // Hearthside: a reset is spent only with the confirmation word, the exact
  // reset the person was shown, and the handle of the view it was shown in. A
  // renderer cannot ask for "whichever is free", nor for a plan on a
  // connection other than the one it read.
  useGptReset: z.tuple([
    z
      .object({
        providerName: id,
        resetId: id,
        token: z.string().regex(/^[0-9a-f]{32}$/),
        confirm: z.literal("use-one-reset"),
      })
      .strict(),
  ]),
  listMemory: z.tuple([id]),
  readMemoryFile: z.tuple([id, memoryPath]),
  writeMemoryFile: z.tuple([id, memoryPath, z.string().max(1_000_000), z.string().max(1_000_000).nullish()]),
  deleteMemoryFile: z.tuple([id, memoryPath]),
  listMemoryHistory: z.tuple([id, memoryPath]),
  readMemoryFileAt: z.tuple([id, memoryPath, z.string().regex(/^[0-9a-f]{4,64}$/i)]),
  listMemoryActivity: z.tuple([id, z.number().int().min(1).max(5_000)]),
  readMemoryCommitDiff: z.tuple([id, z.string().regex(/^[0-9a-f]{4,64}$/i)]),
  listConversations: z.tuple([id]),
  loadHistory: z.tuple([id, z.number().int().min(1).max(500), z.object({ before: id.optional(), around: id.optional() }).strict().refine((value) => !(value.before && value.around), "Choose one history cursor.").optional()]),
  latestMessageMark: z.tuple([id]),
  renameConversation: z.tuple([id, text(200)]),
  archiveConversation: z.tuple([id]),
  listArchivedConversations: z.tuple([id]),
  restoreConversation: z.tuple([id]),
  sendMessage: z.tuple([sendMessageInput]),
  stopTurn: z.tuple([id]),
  checkPrograms: z.tuple([z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,40}$/i)).max(20)]),
  listDirectory: z.tuple([text(4_000), z.string().max(4_000).refine((p) => !p.split(/[\\/]/).includes(".."), "No ..")]),
  readWorkingFile: z.tuple([text(4_000), z.string().min(1).max(4_000).refine((p) => !p.split(/[\\/]/).includes(".."), "No ..")]),
  listConnectors: z.tuple([id]),
  saveConnector: z.tuple([connectorInput]),
  testConnectorInput: z.tuple([connectorInput]),
  addConnectorsFromJson: z.tuple([text(100_000), z.array(id).max(500)]),
  removeConnector: z.tuple([id]),
  setConnectorAgents: z.tuple([id, z.array(id).max(500)]),
  setLettaToolAttached: z.tuple([id, id, z.boolean(), id]),
  testConnector: z.tuple([id]),
  signInConnector: z.tuple([id]),
  signOutConnector: z.tuple([id]),
  setConnectorTools: z.tuple([id, z.array(text(200)).max(500)]),
  setConnectorVoice: z.tuple([id, z.object({ id: text(200), name: text(200) }).strict().nullable()]),
  listConnectorVoices: z.tuple([id]),
  setConnectorVoiceModel: z.tuple([id, z.string().regex(/^[a-z0-9_]{1,60}$/).nullable()]),
  listConnectorImports: z.tuple([]),
  importConnectors: z.tuple([z.array(z.object({ from: text(40), name: text(200) }).strict()).max(100), z.array(id).max(500)]),
  listGifs: z.tuple([z.string().max(100)]),
  imageEngineStatus: z.tuple([]),
  imageConnectStatus: z.tuple([]),
  startImageSetup: z.tuple([z.enum(["install", "login"]), z.enum(["browser", "device"]).optional()]),
  cancelImageSetup: z.tuple([id]),
  listCalendar: z.tuple([z.number().int(), z.number().int()]),
  saveCalendarEvent: z.tuple([
    z
      .object({
        id: id.optional(),
        revision: z.number().int().optional(),
        title: text(200),
        start: text(40),
        end: text(40).nullable().optional(),
        allDay: z.boolean().optional(),
        timezone: text(80).optional(),
        location: text(300).nullable().optional(),
        notes: text(4_000).nullable().optional(),
        reminderMinutes: z.number().int().min(0).max(40_320).nullable().optional(),
        remindAgentId: id.nullable().optional(),
      })
      .strict(),
  ]),
  deleteCalendarEvent: z.tuple([id]),
  listCalendarSubscriptions: z.tuple([]),
  addCalendarSubscription: z.tuple([text(100), text(4_000)]),
  removeCalendarSubscription: z.tuple([id]),
  refreshCalendarSubscription: z.tuple([id]),
  calendarAccess: z.tuple([]),
  setCalendarAccess: z.tuple([id, z.boolean()]),
  readImageFile: z.tuple([z.string().min(1).max(4_000).regex(/\.(png|jpe?g|webp)$/i)]),
  fetchGif: z.tuple([z.string().max(1_000).regex(/^https:\/\/static\.klipy\.com\/[^\s?#]+\.gif$/)]),
  readAudioFile: z.tuple([z.string().min(1).max(4_000).regex(/\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm)$/i)]),
  revealAudioFile: z.tuple([z.string().min(1).max(4_000).regex(/\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm)$/i)]),
  listSecretNames: z.tuple([id]),
  setSecret: z.tuple([id, z.string().max(100), z.string().min(1).max(20_000)]),
  removeSecret: z.tuple([id, z.string().max(100)]),
  getDiagnostics: z.tuple([]),
  getComputerStatus: z.tuple([]),
  getChannelServiceStatus: z.tuple([]),
  recoverChannelService: z.tuple([]),
  openLogFolder: z.tuple([]),
  openFileLink: z.tuple([text(4_000), text(4_000).nullable(), id.nullable().optional()]),
  openLettaComputer: z.tuple([id]),
  setUseRealLettaHome: z.tuple([z.boolean()]),
  forkConversation: z.tuple([id]),
  exportConversation: z.tuple([id]),
  searchMessages: z.tuple([id, z.string().trim().min(1).max(500)]),
  listChannels: z.tuple([]),
  listChannelAccounts: z.tuple([id, id]),
  setupChannel: z.tuple([
    z
      .object({
        channelId: id,
        agentId: id,
        name: text(200),
        access: z.enum(["just-me", "pairing", "open"]),
        config: z.record(z.string().max(100), z.unknown()),
        companionParticipation: z.object({ version: z.literal(1), ambient: z.boolean(), mentions: z.boolean() }).strict().optional(),
      })
      .strict(),
  ]),
  // Hearthside: the trailing id is the companion asking. The main process checks
  // it against the bot's recorded owner, so a renderer naming another
  // companion's bot is refused there, not merely hidden in the window.
  setChannelAccountRunning: z.tuple([id, id, z.boolean(), id]),
  setChannelAccess: z.tuple([id, id, z.enum(["just-me", "pairing", "open"]), z.array(text(200)).max(200), id]),
  setDiscordCompanionParticipation: z.tuple([id, z.object({ version: z.literal(1), ambient: z.boolean(), mentions: z.boolean() }).strict(), id]),
  declinePairing: z.tuple([text(100)]),
  setChannelChatMode: z.tuple([id, z.enum(["main", "server", "channel"]), id]),
  setDiscordChannelListening: z.tuple([id, z.string().regex(/^\d{5,30}$/), z.boolean(), id]),
  listMutedChannels: z.tuple([id, id]),
  removeChannelAccount: z.tuple([id, id, id]),
  claimChannelBot: z.tuple([id, id, id]),
  previewChannelBotReassign: z.tuple([id, id, id]),
  // Hearthside: a move carries the owner and connection the person was SHOWN,
  // so the main process can refuse a confirmation that is no longer about the
  // bot as it is now (another window, a recovery handover, a changed selection).
  reassignChannelBot: z.tuple([z.object({ channelId: id, accountId: id, fromAgentId: id, toAgentId: id, connection: text(300).min(1) }).strict()]),
  resumeChannelBotMove: z.tuple([id, id, z.enum(["finish", "undo"])]),
  listPairings: z.tuple([id, id]),
  // The bot a pairing arrived at is required: a request that can't be tied to
  // one bot must not be approved against a guess.
  approvePairing: z.tuple([z.object({ channelId: id, accountId: id, code: text(100).min(1), agentId: id }).strict()]),
  listChannelRoutes: z.tuple([id]),
  removeChannelRoute: z.tuple([id, id, text(300).min(1), id]),
  listSchedules: z.tuple([id]),
  addSchedule: z.tuple([scheduleInput]),
  updateSchedule: z.tuple([id, scheduleInput.partial()]),
  setSchedulePaused: z.tuple([id, z.boolean()]),
  runScheduleNow: z.tuple([id]),
  deleteSchedule: z.tuple([id]),
  listScheduleRuns: z.tuple([id]),
  listSkills: z.tuple([id]),
  listSkillCatalog: z.tuple([]),
  installSkill: z.tuple([
    z
      .object({
        source: z.object({ owner: text(100), repo: text(100), ref: text(200), path: text(500) }).strict().optional(),
        url: text(2_000).optional(),
        target: z.enum(["agent", "computer"]),
        agentId: id,
      })
      .strict(),
  ]),
  removeSkill: z.tuple([
    z
      .object({
        agentId: id,
        skill: z
          .object({
            id: text(300),
            name: text(200),
            description: text(4_000),
            path: text(4_000),
            source: z.enum(["bundled", "global", "agent", "project"]),
            needs: z.object({ programs: z.array(text(60)), secrets: z.array(text(100)), setup: text(4_000).nullable() }).strict().optional(),
          })
          .strict(),
      })
      .strict(),
  ]),
  getUpdateReady: z.tuple([]),
  installUpdate: z.tuple([]),
  checkForUpdates: z.tuple([]),
  getAppVersion: z.tuple([]),
  getToolset: z.tuple([id]),
  setToolset: z.tuple([id, z.enum(["auto", "default", "codex", "letta", "none"])]),
  runCommand: z.tuple([id, z.enum(["doctor", "dream", "compact", "init", "reload", "recompile"]), z.string().max(4_000)]),
  getModsOverview: z.tuple([id.nullable()]),
  readModSource: z.tuple([z.object({ scope: modScope, agentId: id.nullable(), name: modFileName }).strict()]),
  chooseModFile: z.tuple([]),
  confirmModImport: z.tuple([text(200).min(1)]),
  setModsOff: z.tuple([z.boolean()]),
  reloadMods: z.tuple([id]),
  listChatCommands: z.tuple([id]),
  listHistory: z.tuple([id]),
  runChatCommand: z.tuple([id, modCommandId, z.string().max(4_000)]),
  setConversationContextWindow: z.tuple([id, z.number().int().min(4_000).max(10_000_000).nullable()]),
  respondApproval: z.tuple([id, id, approvalDecision]),
  selectDirectory: z.tuple([]),
  chooseHistoryImport: z.tuple([id]),
  runHistoryImport: z.tuple([text(100), z.object({ personName: text(100).optional(), includeArchived: z.boolean().optional() }).strict()]),
  startProviderSignIn: z.tuple([z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Unknown provider.")]),
  answerProviderSignIn: z.tuple([id, z.string().max(4_000).refine((t) => !/[\r\n]/.test(t), "One line only.")]),
  cancelProviderSignIn: z.tuple([id]),
  signInWithLetta: z.tuple([]),
  cancelLettaSignIn: z.tuple([]),
  signOutOfLetta: z.tuple([]),
  getDreamSettings: z.tuple([id]),
  setDreamSettings: z.tuple([id, dreamSettings]),
  getLooks: z.tuple([]),
  setLookImage: z.tuple([id, lookKind, lookDataUrl]),
  clearLookImage: z.tuple([id, lookKind]),
  setLookStyle: z.tuple([id, lookStyle]),
  listChatHelpers: z.tuple([id]),
  getBackupSettings: z.tuple([]),
  chooseBackupFolder: z.tuple([]),
  unlockBackupFolder: z.tuple([text(200)]),
  newBackupRecoveryCode: z.tuple([]),
  updateBackupSettings: z.tuple([
    z.object({ includePictures: z.boolean().optional(), daily: z.boolean().optional(), dailyAt: z.string().regex(/^\d{2}:\d{2}$/).optional(), keepDays: z.number().int().min(1).max(3650).optional() }).strict(),
  ]),
  backUpNow: z.union([z.tuple([id]), z.tuple([id, z.boolean()])]),
  listBackups: z.tuple([id]),
  listBackupCompanions: z.tuple([]),
  verifyBackup: z.tuple([id, text(100)]),
  runCaptureDiagnostic: z.tuple([id]),
  cancelCaptureDiagnostic: z.tuple([]),
  previewBackupRestore: z.tuple([id, text(100), z.object({ pictures: z.enum(["block", "placeholder"]).optional(), unansweredCalls: z.enum(["block", "annotate"]).optional(), windowCalls: z.enum(["block", "close"]).optional(), excludeChats: z.array(z.string().max(300)).max(1000).optional(), fallbacks: z.boolean().optional() }).strict().optional()]),
  restoreBackupCopy: z.tuple([text(200).min(1)]),
  getRecoveryReceipt: z.tuple([id]),
  listRecoveryCopies: z.tuple([]),
  previewRecoveryHandover: z.tuple([id]),
  confirmRecoveryHandover: z.tuple([text(200).min(1), z.array(z.enum(["manual", "schedules", "channels"])).max(3)]),
  rollbackRecoveryHandover: z.tuple([id]),
  getRecoveryHandover: z.tuple([id]),
  previewManualRecoveryCopy: z.tuple([id]),
  confirmManualRecoveryCopy: z.tuple([text(200).min(1)]),
} satisfies { [K in keyof AppRequests]: z.ZodType };

export type RequestName = keyof AppRequests;

export function isRequestName(value: unknown): value is RequestName {
  return typeof value === "string" && Object.hasOwn(requestSchemas, value);
}

/** Validate the raw IPC arguments for a request. Throws a readable error on bad input. */
export function parseRequestArgs<K extends RequestName>(name: K, args: unknown[]): Parameters<AppRequests[K]> {
  const result = requestSchemas[name].safeParse(args);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Invalid ${name} request${issue ? `: ${issue.message}` : ""}.`);
  }
  return result.data as Parameters<AppRequests[K]>;
}
