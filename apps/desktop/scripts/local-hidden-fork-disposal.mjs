// Pinned local-only extension. Never modifies the installed dependency.
import { createHash } from 'node:crypto';

const storeStart = 'class LocalStore {';
const storeEnd = 'var DEFAULT_LOCAL_AGENT_NAME';
const backendStart = '  LocalBackend = class LocalBackend extends HeadlessBackend {';
const backendEnd = '    setModEventHooks(hooks) {';

const storeMethods = `
  hearthsideSettledMessageIdsByConversationKey = new Map;
  hearthsidePendingConversationDisposals = new Map;
  deleteHiddenConversation(conversationId) {
    if (typeof conversationId !== "string" || !conversationId || conversationId === "default")
      throw new Error("Only hidden nondefault conversations can be disposed");
    const pending = this.hearthsidePendingConversationDisposals.get(conversationId);
    if (pending) {
      this.retrieveAgentRecord(pending.agentId);
      rmSync3(pending.path, { recursive: true, force: true });
      this.hearthsidePendingConversationDisposals.delete(conversationId);
      return;
    }
    const conversation = this.findConversation(conversationId);
    if (!conversation)
      throw new LocalBackendNotFoundError("Conversation", conversationId);
    if (conversation.id !== conversationId || conversation.hidden !== true || conversation.agent_free)
      throw new Error("Only agent-owned hidden conversations can be disposed");
    this.retrieveAgentRecord(conversation.agent_id);
    const key = this.conversationKey(conversationId, conversation.agent_id);
    let removedPath;
    if (this.storageDir) {
      const originalPath = join22(this.storageDir, "conversations", encodePathSegment(key));
      const recordedPath = this.transcriptMetadataByConversationKey.get(key)?.conversationDir;
      if (recordedPath && recordedPath !== originalPath)
        throw new Error("Cannot dispose a noncanonical local conversation directory");
      if (existsSync15(originalPath)) {
        // Move outside the scanned conversations directory before clearing indexes.
        // A crash or failed physical cleanup cannot resurrect this record on restart.
        removedPath = join22(this.storageDir, ".hearthside-disposed-" + randomUUID8());
        renameSync3(originalPath, removedPath);
        this.hearthsidePendingConversationDisposals.set(conversationId, { path: removedPath, agentId: conversation.agent_id });
      }
    }
    for (const id of this.hearthsideSettledMessageIdsByConversationKey.get(key) ?? [])
      this.settledLocalMessageIds.delete(id);
    this.hearthsideSettledMessageIdsByConversationKey.delete(key);
    for (const message of this.localMessagesByConversationKey.get(key) ?? [])
      this.settledLocalMessageIds.delete(message.id);
    for (const [id, messages] of this.messagesById) {
      const remaining = messages.filter(message => message.conversation_id !== conversationId);
      if (remaining.length === 0) this.messagesById.delete(id);
      else if (remaining.length !== messages.length) this.messagesById.set(id, remaining);
    }
    for (const name of ["conversations", "localMessagesByConversationKey", "loadedConversationKeys",
      "tailResidentConversationKeys", "residentTailStartIndexByConversationKey", "loadRepairedConversationKeys",
      "unreadTranscriptHeadBytesByKey", "transcriptMetadataByConversationKey", "conversationRecordJsonByKey",
      "sessionEntryIdsByConversationKey", "sessionEntryIdByMessageIdByConversationKey",
      "persistedMessageByMessageIdByConversationKey", "lastSessionEntryIdByConversationKey",
      "compiledSystemPromptByConversationKey"])
      this[name].delete(key);
    if (removedPath) rmSync3(removedPath, { recursive: true, force: true });
    this.hearthsidePendingConversationDisposals.delete(conversationId);
  }
`;

const backendMethods = `
    hearthsidePendingDisposalTurns = new Map;
    async executeConversationTurn(conversationId, body, options) {
      if (this.store.hearthsidePendingConversationDisposals.has(conversationId))
        throw new Error("Conversation disposal cleanup is pending");
      const pending = this.hearthsidePendingDisposalTurns;
      pending.set(conversationId, (pending.get(conversationId) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const count = pending.get(conversationId) - 1;
        if (count) pending.set(conversationId, count);
        else pending.delete(conversationId);
      };
      try {
        const stream = await super.executeConversationTurn(conversationId, body, options);
        let consumed = false;
        return {
          controller: stream.controller,
          async* [Symbol.asyncIterator]() {
            if (consumed) throw new Error("Local turn stream can only be consumed once");
            consumed = true;
            try { yield* stream; } finally { release(); }
          }
        };
      } catch (error) { release(); throw error; }
    }
    async deleteConversation(conversationId) {
      // Runtime maps are instance-local, not proof that other processes are idle.
      // The additional lifetime guard covers startup, cancelled streams and a
      // terminal stop chunk yielded before the provider iterator actually ends.
      if (this.hearthsidePendingDisposalTurns.has(conversationId))
        throw new Error("Cannot dispose a conversation with a pending turn");
      const conversation = this.store.findConversation(conversationId);
      if (conversation && this.activeRunByConversation.has(localConversationKey(conversationId, conversation.agent_id)))
        throw new Error("Cannot dispose a conversation with an active run");
      const runIds = [];
      for (const [id, run] of this.runs) {
        if (run.conversation_id !== conversationId) continue;
        if (!isTerminalRun(run) || this.runControllerByRunId.has(id) || this.runStartupPreemptByRunId.has(id))
          throw new Error("Cannot dispose a conversation with an unsettled run");
        runIds.push(id);
      }
      // No await between validation and synchronous persistence removal.
      this.store.deleteHiddenConversation(conversationId);
      for (const id of runIds) {
        this.runs.delete(id);
        this.runChunksByRunId.delete(id);
      }
    }
`;

function section(source, start, end, hash) {
  const at = source.indexOf(start);
  const stop = source.indexOf(end, at);
  if (at < 0 || stop < 0 || source.indexOf(start, at + start.length) !== -1 ||
      createHash('sha256').update(source.slice(at, stop)).digest('hex') !== hash)
    throw new Error('Local hidden fork disposal: pinned 0.34.36 source mismatch');
  return at;
}

/** Compose after other policy transforms; independently hash-pin untouched local sections.
 * Activity exclusion is scoped to this backend instance. Upstream provides no
 * cross-process conversation lock; concurrent writers in another runtime are not
 * supported. Unconsumed streams conservatively remain busy even after cancellation.
 * Rename is atomic within the storage volume, not an fsync-backed transaction.
 * Cleanup failure throws and can leave an unscanned .hearthside-disposed-* directory.
 */
export function transformLocalHiddenForkDisposal(source) {
  section(source, storeStart, storeEnd, '0200fa1eaea1d57bc1c91fbffc332cabcade46dbdd399422c38a66c32afd4dd6');
  section(source, backendStart, backendEnd, '8ed33ea395a522ae073421a53cba0abb542690e2ad077037abaf55c739e4665c');
  return source.replace(storeStart, storeStart + storeMethods)
    .replace('    this.settledLocalMessageIds.add(last.id);', `    this.settledLocalMessageIds.add(last.id);
    const disposalKey = this.conversationKey(conversationId, agentId);
    let disposalIds = this.hearthsideSettledMessageIdsByConversationKey.get(disposalKey);
    if (!disposalIds) this.hearthsideSettledMessageIdsByConversationKey.set(disposalKey, disposalIds = new Set);
    disposalIds.add(last.id);`)
    .replace(backendEnd, backendMethods + backendEnd);
}
