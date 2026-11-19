// Source-owned scoped capability; injected only into the validated runtime COPY.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const UPSTREAM_HANDLE_SHA256 = '10d8d2a9c8138305f76708919d6b8ceaefc8db64147d4bc834781cd41e3fd25e';

// Self-contained so the exact same implementation is exercised by tests and emitted.
export function hearthsideScopedConversation(raw, backend, known = new Set([raw.id, 'default']), owned = false) {
  let active = 0;
  let uncertain = false;
  let state = 'ready';
  let disposing;
  const id = raw.id; // Never trust the public, mutable id at deletion time.
  const enter = () => {
    if (state !== 'ready') throw new Error(`Conversation is ${state}`);
    active++;
  };
  const operation = async (method, args) => {
    enter();
    try { return await raw[method](...args); }
    finally { active--; }
  };
  const handle = {
    id,
    async fork(forkOptions) {
      enter();
      try {
        const hidden = forkOptions?.hidden === true;
        const child = await raw.fork({ hidden });
        const valid = typeof child.id === 'string' && /^(?:conv-|local-conv-)[a-zA-Z0-9_-]+$/.test(child.id) && !known.has(child.id);
        if (!valid) throw new Error('Fork returned an invalid or already owned conversation ID');
        known.add(child.id);
        return hearthsideScopedConversation(child, backend, known, hidden);
      } finally { active--; }
    },
    getHistory(...args) { return operation('getHistory', args); },
    updateTitle(...args) { return operation('updateTitle', args); },
    updateLlmConfig(...args) { return operation('updateLlmConfig', args); },
    async sendMessageStream(...args) {
      enter();
      let stream;
      try { stream = await raw.sendMessageStream(...args); }
      catch (error) { active--; uncertain = true; throw error; }
      let consumed = false;
      // Do not expose tee/toReadableStream: those would bypass lifecycle tracking.
      return {
        async *[Symbol.asyncIterator]() {
          if (consumed) throw new Error('Conversation stream can only be consumed once');
          consumed = true;
          let completed = false;
          let terminal;
          let failed = false;
          try {
            for await (const chunk of stream) {
              if (chunk?.message_type === 'stop_reason') terminal = chunk.stop_reason;
              if (chunk?.message_type === 'error') failed = true;
              yield chunk;
            }
            completed = terminal === 'end_turn' && !failed && !args[2]?.signal?.aborted;
          } finally {
            active--;
            if (!completed) uncertain = true;
          }
        }
      };
    }
  };
  if (owned) {
    handle.dispose = () => {
      if (state === 'disposed') return Promise.resolve();
      if (disposing) return disposing;
      if (active || uncertain) return Promise.reject(new Error('Conversation has active or uncertain work; cannot dispose'));
      state = 'disposing';
      disposing = Promise.resolve().then(async () => {
        if (typeof backend?.deleteConversation !== 'function') throw new Error('Conversation disposal is unavailable on this backend');
        await backend.deleteConversation(id);
        state = 'disposed';
      }).catch(error => {
        // A failed response may follow partial deletion. Only retry disposal;
        // starting new work here could resurrect a half-removed conversation.
        state = 'dispose-failed';
        throw error;
      }).finally(() => { disposing = undefined; });
      return disposing;
    };
  }
  return handle;
}

export function transformHiddenForkDisposal(source) {
  const startMarker = 'function createModConversationHandle(options) {';
  const endMarker = 'var init_conversation_handle';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0 || source.indexOf(startMarker, start + 1) !== -1) throw new Error('Hidden fork disposal: upstream handle contract missing/ambiguous');
  const original = source.slice(start, end);
  if (createHash('sha256').update(original).digest('hex') !== UPSTREAM_HANDLE_SHA256) throw new Error('Hidden fork disposal: upstream handle hash mismatch');
  const renamed = original.replaceAll('createModConversationHandle', 'hearthsideOriginalConversationHandle');
  // Read source, not Function#toString: test/build loaders may inject helpers
  // into live functions, and Windows checkouts may use CRLF. Neither may alter
  // the executable copy or make it depend on a loader-specific closure.
  const ownSource = readFileSync(new URL(import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const ownStart = ownSource.indexOf('export function hearthsideScopedConversation(');
  const ownEnd = ownSource.indexOf('\nexport function transformHiddenForkDisposal(', ownStart);
  if (ownStart < 0 || ownEnd < ownStart) throw new Error('Hidden fork disposal: owned implementation missing');
  const implementation = ownSource.slice(ownStart + 'export '.length, ownEnd).trimEnd();
  const replacement = `${renamed}\n${implementation}\nfunction createModConversationHandle(options) {\n  return hearthsideScopedConversation(hearthsideOriginalConversationHandle(options), options.backend);\n}\n`;
  return source.slice(0, start) + replacement + source.slice(end);
}

export function transformHiddenForkDisposalTypes(source) {
  if (createHash('sha256').update(source).digest('hex') !== 'f9ce6a14b0b340af28bf4f6e46ba4abba7f95f5c89c6c0e327dd9b1264b89257') throw new Error('Hidden fork disposal: upstream types hash mismatch');
  const anchor = 'export interface ModConversationHandle {\n    id: string | null;';
  if (source.split(anchor).length !== 2 || source.includes('dispose?: () => Promise<void>')) throw new Error('Hidden fork disposal: upstream types contract mismatch');
  return source.replace(anchor, `${anchor}\n    /** Hearthside only: owned hidden forks. Call after full successful stream consumption\n     * and result delivery. Rejects active/uncertain work; no cross-client idle guarantee.\n     * Deletion failures propagate and may be retried on this handle. */\n    dispose?: () => Promise<void>;`);
}
