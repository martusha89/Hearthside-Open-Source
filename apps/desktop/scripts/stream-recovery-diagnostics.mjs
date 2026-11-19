// Embedded into the already exact-hash-validated runtime; no runtime imports/assets.
import { readFileSync } from 'node:fs';
export function createRecoveryDiagnostics(write = line => console.warn(line), now = () => Date.now()) {
  const buckets = new Map();
  return (caller, stage, metadata, error) => {
    try {
      if (!['busy-resume', 'recorded-turn-resolution'].includes(caller) ||
          !['request', 'opened', 'error'].includes(stage)) return;
      const key = `${caller}:${stage}`, time = now();
      let bucket = buckets.get(key);
      if (!bucket) { bucket = { at: time, count: 0, suppressed: 0 }; buckets.set(key, bucket); }
      if (time - bucket.at >= 60000) { bucket.at = time; bucket.count = 0; }
      if (bucket.count >= 4) { bucket.suppressed = Math.min(1000000, bucket.suppressed + 1); return; }
      bucket.count++;
      const entry = { event: 'hearthside.stream-recovery', caller, stage,
        suppressed: bucket.suppressed };
      bucket.suppressed = 0;
      // No input strings are copied. Presence/equality only; no identifier cache.
      for (const field of ['defaultScope', 'agentPresent', 'otidPresent', 'runPresent', 'aborted']) {
        const value = metadata?.[field];
        if (typeof value === 'boolean') entry[field] = value;
      }
      if (stage === 'error') {
        const status = error?.status, name = error?.name, code = error?.code;
        entry.status = [400, 401, 403, 404, 409, 429, 500, 502, 503, 504].includes(status) ? status : 'unclassified';
        entry.name = ['AbortError', 'TimeoutError', 'APIError', 'NotFoundError'].includes(name) ? name : 'unclassified';
        entry.code = ['ABORT_ERR', 'ETIMEDOUT', 'ECONNRESET'].includes(code) ? code : 'unclassified';
      }
      write(JSON.stringify(entry));
    } catch { /* Diagnostics must never replace the original outcome. */ }
  };
}

export function instrumentRecovery(source) {
  const start = source.indexOf('async function tryResumeBusyConversationStream(params) {');
  const end = source.indexOf('\nasync function resolveStaleApprovals', start);
  const recordedStart = source.indexOf('async function resolveRecordedRunId(backend3, record6, pendingApprovals) {');
  const recordedEnd = source.indexOf('\nvar init_recorded_run_resolution', recordedStart);
  if (start < 0 || end <= start || recordedStart < end || recordedEnd <= recordedStart ||
      source.indexOf('async function tryResumeBusyConversationStream(params) {', start + 1) !== -1 ||
      source.indexOf('async function resolveRecordedRunId(backend3, record6, pendingApprovals) {', recordedStart + 1) !== -1) throw new Error('Runtime recovery diagnostics contract mismatch');
  let text = source.slice(start, end) + '\n/* hh recovery boundary */\n' + source.slice(recordedStart, recordedEnd);
  const replace = (from, to) => {
    if (text.split(from).length !== 2) throw new Error('Runtime recovery diagnostics contract mismatch');
    text = text.replace(from, to);
  };
  replace('      const resumeStream = await backend3.streamConversationMessages(conversationId, {',
    `      try { hhRecoveryDiagnostic('busy-resume', 'request', { defaultScope: conversationId === 'default', agentPresent: typeof runtime.agentId === 'string', otidPresent: typeof messageOtid === 'string', aborted: abortSignal?.aborted === true }); } catch {}
      const resumeStream = await backend3.streamConversationMessages(conversationId, {`);
  replace('      resumeAbortRelay?.attach(resumeStream);',
    `      try { hhRecoveryDiagnostic('busy-resume', 'opened'); } catch {}
      resumeAbortRelay?.attach(resumeStream);`);
  replace('    } catch (resumeError) {\n      resumeAbortRelay?.cleanup();',
    `    } catch (resumeError) {
      try { hhRecoveryDiagnostic('busy-resume', 'error', { aborted: abortSignal?.aborted === true }, resumeError); } catch {}
      resumeAbortRelay?.cleanup();`);
  replace('  const stream11 = await backend3.streamConversationMessages(record6.conversationId, {',
    `  try { hhRecoveryDiagnostic('recorded-turn-resolution', 'request', { defaultScope: record6.conversationId === 'default', agentPresent: typeof record6.agentId === 'string', otidPresent: typeof record6.requestOtid === 'string', runPresent: typeof record6.runId === 'string' }); } catch {}
  let stream11;
  try {
    stream11 = await backend3.streamConversationMessages(record6.conversationId, {`);
  replace('  }, { signal: AbortSignal.timeout(5000), maxRetries: 0 });\n  try {\n    for await (const chunk2 of stream11) {',
    `  }, { signal: AbortSignal.timeout(5000), maxRetries: 0 });
  } catch (error) {
    try { hhRecoveryDiagnostic('recorded-turn-resolution', 'error', undefined, error); } catch {}
    throw error;
  }
  try { hhRecoveryDiagnostic('recorded-turn-resolution', 'opened'); } catch {}
  try {
    for await (const chunk2 of stream11) {`);
  const [busy, recorded] = text.split('\n/* hh recovery boundary */\n');
  return source.slice(0, start) + busy + source.slice(end, recordedStart) + recorded + source.slice(recordedEnd);
}
// Build-time source extraction, not Function#toString: test/build loaders may
// rewrite function bodies, producing different bytes and invalidating the pin.
// The emitted runtime still has no imports or additional asset dependency.
const helperText = readFileSync(new URL(import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const helperStart = helperText.indexOf('export function createRecoveryDiagnostics(');
const helperEnd = helperText.indexOf('\nexport function instrumentRecovery(', helperStart);
if (helperStart < 0 || helperEnd <= helperStart) throw new Error('Recovery diagnostic source contract mismatch');
const helperSource = helperText.slice(helperStart + 'export '.length, helperEnd).trimEnd();
export const recoveryPrelude = `\nconst hhRecoveryDiagnostic = (${helperSource})();\n`;
