// Exact-contract Letta 0.34.36 recall fixes applied to the validated runtime copy.
function replaceExact(state, label, from, to, expected = 1) {
  const count = state.text.split(from).length - 1;
  if (count !== expected) throw new Error(`Recall reliability contract mismatch: expected ${expected} ${label} seam(s), found ${count}`);
  state.text = state.text.split(from).join(to);
}

function replaceFunction(state, label, start, end, replacement) {
  const starts = state.text.split(start).length - 1;
  if (starts !== 1) throw new Error(`Recall reliability contract mismatch: expected one ${label} start, found ${starts}`);
  const begin = state.text.indexOf(start);
  const finish = state.text.indexOf(end, begin);
  if (finish < 0) throw new Error(`Recall reliability contract mismatch: missing ${label} end`);
  state.text = state.text.slice(0, begin) + replacement + state.text.slice(finish);
}

export function transformRecallReliability(source) {
  const state = { text: source };

  // A message cursor is only meaningful inside the conversation returned by
  // search. Patch both bundled recall prompts (cloud and local variants).
  replaceExact(state, 'recall conversation option',
    '| \\`--after <message-id>\\` | Get messages after this ID (cursor) |',
    '| \\`--conversation <conversation-id>\\` | Conversation containing the search result (required for expansion) |\n| \\`--after <message-id>\\` | Get messages after this ID (cursor) |', 2);
  replaceExact(state, 'recall result identifiers',
    '2. Note the \\`message_id\\` of the most relevant result',
    '2. Note both the \\`message_id\\` and \\`conversation_id\\` of the most relevant result. Cursor IDs are conversation-scoped.', 2);
  replaceExact(state, 'recall before expansion',
    'letta messages list --before "message-xyz" --limit 10',
    'letta messages list --conversation "conversation-xyz" --before "message-xyz" --limit 10', 2);
  replaceExact(state, 'recall after expansion',
    'letta messages list --after "message-xyz" --order asc --limit 10',
    'letta messages list --conversation "conversation-xyz" --after "message-xyz" --order asc --limit 10', 2);
  replaceExact(state, 'recall conversation search output',
    '- \\`message_id\\` - Use for cursor-based expansion',
    '- \\`message_id\\` - Use for cursor-based expansion\n- \\`conversation_id\\` - Conversation containing the result; always pass it to \\`messages list --conversation\\`', 2);

  // Rank all eligible local conversations, not merely the newest `limit` rows.
  const localSearch = [
    'async function localSearchConversations(backend3, body3) {',
    '  const query3 = typeof body3.query === "string" ? body3.query.trim() : "";',
    '  if (!query3) {',
    '    return [];',
    '  }',
    '  const terms2 = query3.toLowerCase().split(/\\s+/).map((term) => term.trim()).filter(Boolean);',
    '  if (terms2.length === 0) {',
    '    return [];',
    '  }',
    '  const limit4 = typeof body3.limit === "number" ? body3.limit : 20;',
    '  if (!Number.isFinite(limit4) || limit4 <= 0) {',
    '    return [];',
    '  }',
    '  const agentId = typeof body3.agent_id === "string" ? body3.agent_id : undefined;',
    '  const conversations = [];',
    '  const seenConversationIds = /* @__PURE__ */ new Set();',
    '  const visitedCursors = /* @__PURE__ */ new Set();',
    '  let after;',
    '  const pageSize = 100;',
    '  while (true) {',
    '    const page = pageItems(await backend3.listConversations({',
    '      ...agentId ? { agent_id: agentId } : {},',
    '      limit: pageSize,',
    '      order: "desc",',
    '      order_by: "last_message_at",',
    '      ...after ? { after } : {}',
    '    }));',
    '    for (const conversation of page) {',
    '      if (seenConversationIds.has(conversation.id)) continue;',
    '      seenConversationIds.add(conversation.id);',
    '      conversations.push(conversation);',
    '    }',
    '    if (page.length === 0) break;',
    '    const nextAfter = page.at(-1)?.id;',
    '    if (!nextAfter || visitedCursors.has(nextAfter)) break;',
    '    visitedCursors.add(nextAfter);',
    '    after = nextAfter;',
    '  }',
    '  return conversations.map((conversation) => {',
    '    const summary = conversation.summary?.trim() ?? "";',
    '    if (!summary) {',
    '      return null;',
    '    }',
    '    const matchedTerms = countMatchedTerms(summary, terms2);',
    '    if (matchedTerms === 0) {',
    '      return null;',
    '    }',
    '    return {',
    '      embedded_text: summary,',
    '      conversation,',
    '      rrf_score: matchedTerms / terms2.length',
    '    };',
    '  }).filter((result3) => result3 !== null).sort((a2, b3) => b3.rrf_score - a2.rrf_score).slice(0, limit4);',
    '}',
  ].join('\n');
  replaceFunction(state, 'local conversation search',
    'async function localSearchConversations(backend3, body3) {',
    '\nasync function searchConversationsForBackend',
    localSearch);

  // Keep the current background lifecycle, but expose its result to the
  // initiating tool call and wait only when the selected subagent is recall.
  replaceExact(state, 'recall task result capture',
    '    bgTask.status = result3.success ? "completed" : "failed";\n    if (result3.error) {',
    '    bgTask.status = result3.success ? "completed" : "failed";\n    bgTask.hearthsideResult = result3;\n    if (result3.error) {');
  replaceExact(state, 'recall task failure capture',
    '    bgTask.status = "failed";\n    bgTask.error = errorMessage5;',
    '    bgTask.status = "failed";\n    bgTask.error = errorMessage5;\n    bgTask.hearthsideResult = { success: false, error: errorMessage5 };');
  replaceExact(state, 'recall lifecycle completion',
    '  bgTask.completion = subagentType === "memory" ? taskLifecycle : subagentExecution.then(swallow, swallow);',
    '  bgTask.completion = subagentType === "memory" || subagentType === "recall" && publishResult === true && shouldEmitCompletionNotification === false ? taskLifecycle : subagentExecution.then(swallow, swallow);');
  replaceExact(state, 'blocking recall launch mode',
    '  const callerNotification = args.notifyCaller ? {\n    emitCompletionNotification: false,\n    publishResult: true,\n    claimsParentRuntime: false\n  } : {};',
    '  const hhBlockingRecall = args.hhBlockingRecall === true;\n  const callerNotification = args.notifyCaller || hhBlockingRecall ? {\n    emitCompletionNotification: false,\n    publishResult: true,\n    claimsParentRuntime: args.notifyCaller ? false : true\n  } : {};');

  const foregroundRecall = [
    '  if (args.subagent_type === "recall") {',
    '    const recallTask = backgroundTasks.get(result3.task_id);',
    '    if (!recallTask?.completion) return `Error: Recall task ${result3.task_id} was not registered`;',
    '    let resolveAbort;',
    '    const aborted = new Promise((resolve) => { resolveAbort = resolve; });',
    '    const abortRecall = () => {',
    '      recallTask.abortController?.abort(args.signal?.reason);',
    '      resolveAbort("aborted");',
    '    };',
    '    args.signal?.addEventListener("abort", abortRecall, { once: true });',
    '    let waitOutcome;',
    '    try {',
    '      if (args.signal?.aborted) abortRecall();',
    '      waitOutcome = await Promise.race([recallTask.completion.then(() => "completed"), aborted]);',
    '    } finally {',
    '      args.signal?.removeEventListener("abort", abortRecall);',
    '    }',
    '    if (waitOutcome === "aborted") {',
    '      const abortReason = args.signal?.reason && typeof args.signal.reason === "object" && typeof args.signal.reason.message === "string" ? args.signal.reason.message : args.signal?.reason ? String(args.signal.reason) : "parent task interrupted";',
    '      return `Error: Recall interrupted: ${abortReason}\\nOutput file: ${result3.output_file}`;',
    '    }',
    '    const recallResult = recallTask.hearthsideResult;',
    '    if (!recallResult?.success) return `Error: ${recallResult?.error ?? "Recall task failed without a result"}\\nOutput file: ${result3.output_file}`;',
    '    const report = recallResult.report ?? "Recall completed without a textual report.";',
    '    const truncated = truncateByChars(report, LIMITS.TASK_OUTPUT_CHARS);',
    '    const truncationNotice = truncated.wasTruncated ? "\\n\\n[Recall result truncated; full output remains in the task transcript.]" : "";',
    '    return `Recall completed (task_id=${result3.task_id}, agent_id=${recallResult.agentId ?? result3.agent_id ?? "unknown"}, conversation_id=${recallResult.conversationId ?? result3.conversation_id ?? "unknown"}).\\n\\n${truncated.content}${truncationNotice}\\nOutput file: ${result3.output_file}`;',
    '  }',
    '',
  ].join('\n');
  replaceExact(state, 'blocking recall launch insertion',
    '  const result3 = await launchSubagent(args);',
    '  const hhBlockingRecall = args.subagent_type === "recall";\n  const result3 = await launchSubagent(hhBlockingRecall ? { ...args, hhBlockingRecall: true } : args);');
  replaceExact(state, 'blocking recall response insertion',
    '  const agentIdLine = result3.agent_id ? `',
    foregroundRecall + '  const agentIdLine = result3.agent_id ? `');

  return state.text;
}
