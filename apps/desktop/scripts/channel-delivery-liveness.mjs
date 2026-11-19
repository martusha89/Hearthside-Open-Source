// Applied only inside prepare-runtime's exact upstream version/hash gate.
// A timed-out remote operation is NOT cancelled: its lane requires definitive
// completion; transport failure quarantines it for this gateway generation.
export const deliveryPrelude = `
const hhAdmissionLimitMs = 30000;
let hhDiagnosticWindow = 0, hhDiagnosticCount = 0, hhDiagnosticDropped = 0;
function hhDeliveryLog(record) {
  const now = performance.now();
  if (now - hhDiagnosticWindow >= 60000) { hhDiagnosticWindow = now; hhDiagnosticCount = 0; }
  if (hhDiagnosticCount++ >= 2048) { hhDiagnosticDropped++; return; }
  if (hhDiagnosticDropped) { record.suppressed = hhDiagnosticDropped; hhDiagnosticDropped = 0; }
  console.error("[HearthsideDelivery] " + JSON.stringify(record));
}
function hhDeliveryTrace(delivery, phase, extra = {}) {
  const ticket = delivery.hhDelivery;
  if (!ticket) return;
  hhDeliveryLog({
    delivery: ticket.id, runtime: ticket.runtimeId, phase,
    clientIdHash: ticket.clientIdHash,
    sourceMessageHashes: ticket.sourceMessageHashes, sourceMessageCount: ticket.sourceMessageCount,
    ageMs: Math.max(0, Math.round(performance.now() - ticket.arrived)), ...extra
  });
}
function hhDeliveryIdHash(id) {
  return typeof id === "string" && id.length <= 1024 ? createHash21("sha256").update(id, "utf8").digest("hex") : undefined;
}
function hhDeliveryTicket(delivery) {
  if (delivery.hhDelivery) return delivery.hhDelivery;
  const ids = [...new Set((delivery.turnSources ?? delivery.sources ?? []).map(source => source.messageId).filter(id => typeof id === "string"))];
  return delivery.hhDelivery = { id: crypto.randomUUID(), arrived: performance.now(), expired: false, submitted: false,
    sourceMessageHashes: ids.slice(0, 8).map(hhDeliveryIdHash).filter(Boolean), sourceMessageCount: ids.length };
}
function hhDeliveryCheck(delivery) {
  const ticket = delivery.hhDelivery;
  if (!ticket) return;
  if (ticket.expired || performance.now() - ticket.arrived >= hhAdmissionLimitMs) {
    ticket.expired = true;
    throw new Error("Channel admission expired before submission");
  }
}
// A person's message that Hearthside could not hand over gets one visible notice
// on the same chat. Managed bot input (hhAdmission) and shutdown stay silent.
// Only "dropped" may invite a resend: the message never reached the runtime
// and nothing is blocking the next one. "held" and "unconfirmed" must not,
// because the original may still be queued or the next send would be rejected.
const hhUndeliveredNotice = {
  dropped: "Hearthside could not hand this message to your companion in time, so it was not delivered. Please send it again.",
  held: "Hearthside is still waiting to confirm that an earlier message reached your companion, so this one was not delivered. Please wait a little before sending again.",
  unconfirmed: "Delivery couldn't be confirmed. Your message may already be queued or processing. Please don't resend it yet; check your companion's activity first."
};
const hhNoticeCooldownMs = 60000;
const hhNoticeCooldown = new Map();
let hhNotifyUndelivered = null;
function hhDeliveryNotify(delivery, kind) {
  const ticket = delivery.hhDelivery;
  if (!ticket || ticket.notified || delivery.hhAdmission) return;
  ticket.notified = true;
  try { hhNotifyUndelivered?.(delivery, kind); } catch {}
}
// Re-resolve the route at send time: a muted route resolves to nothing, and a
// route moved to another agent/conversation no longer names this source. For
// Discord the committed account owner must still be this agent.
function hhNoticeAuthorized(source) {
  try {
    const route = loadRouteForInboundMessage({ channel: source.channel, chatId: source.chatId, chatType: source.chatType, threadId: source.threadId ?? null }, source.accountId);
    if (!route || route.agentId !== source.agentId || route.conversationId !== source.conversationId || route.outboundEnabled === false) return false;
    if (source.channel === "discord" && !hhPolicy.committedOwnerMatches(getChannelDir("discord"), source.accountId, source.agentId)) return false;
    return true;
  } catch { return false; }
}
function hhSendUndeliveredNotice(registry, delivery, kind) {
  const now = performance.now();
  for (const source of delivery.turnSources ?? delivery.sources ?? []) {
    if (!source?.channel || !source.chatId) continue;
    if (!hhNoticeAuthorized(source)) { hhDeliveryTrace(delivery, "notice-failed", { kind, reason: "unauthorized" }); continue; }
    const key = [source.channel, source.accountId ?? "", source.chatId, source.threadId ?? ""].join("|");
    const last = hhNoticeCooldown.get(key);
    if (last !== undefined && now - last < hhNoticeCooldownMs) { hhDeliveryTrace(delivery, "notice-suppressed", { kind }); continue; }
    if (hhNoticeCooldown.size >= 1024) hhNoticeCooldown.delete(hhNoticeCooldown.keys().next().value);
    hhNoticeCooldown.set(key, now);
    const adapter = registry.getAdapter?.(source.channel, source.accountId);
    if (!adapter?.sendDirectReply || adapter.isRunning?.() === false) { hhDeliveryTrace(delivery, "notice-failed", { kind, reason: "adapter-unavailable" }); continue; }
    Promise.resolve().then(() => adapter.sendDirectReply(source.chatId, hhUndeliveredNotice[kind], { replyToMessageId: source.messageId ?? undefined, threadId: source.threadId ?? null }))
      .then(() => hhDeliveryTrace(delivery, "notice-sent", { kind }), () => hhDeliveryTrace(delivery, "notice-failed", { kind, reason: "send-error" }));
  }
}
`;
export function transformChannelDeliveryLiveness(text) {
  const replace = (from, to) => {
    if (text.split(from).length !== 2) throw new Error(`Channel liveness contract mismatch: ${from.slice(0, 90)}`);
    text = text.replace(from, to);
  };
  replace('  registrationQueue = Promise.resolve();', `  registrationLanes = new Map();
  hhClosed = false;
  hhTickets = new Set();
  hhReceiptMaps = new Map();
  hhRuntimeIds = new Map();
  hhQuarantinedKeys = new Set();
  hhSubmissionLanes = new Map();
  hhSubmissionDepths = new Map();
  hhUnconfirmedSubmissions = new Set();`);
  replace('  close() {\n    for (const dispose2 of this.disposers.splice(0))', `  close() {
    this.hhClosed = true;
    for (const expire of this.hhTickets) expire("shutdown");
    for (const dispose2 of this.disposers.splice(0))`);
  replace('  async submit(delivery) {\n    const state2', '  async submit(delivery) {\n    if (this.hhClosed) { hhDeliveryTicket(delivery); hhDeliveryTrace(delivery, "expired-unsubmitted", { reason: "shutdown" }); return false; }\n    const state2');
  replace('    const submission = state2.submissionQueue.then(() => this.submitDelivery(state2, delivery));', `    const ticket = hhDeliveryTicket(delivery);
    ticket.runtimeId ??= state2.hhOpaqueId;
    ticket.clientIdHash ??= hhDeliveryIdHash(delivery.clientMessageId);
    const hhKey = runtimeKey(delivery.runtime);
    if (state2.hhReceipts.has(delivery.clientMessageId)) return state2.hhReceipts.get(delivery.clientMessageId).promise;
    if (this.hhUnconfirmedSubmissions.has(hhKey)) {
      hhDeliveryTrace(delivery, "expired-unsubmitted", { reason: "prior-receipt-unconfirmed" });
      hhDeliveryNotify(delivery, "held");
      this.finishRejectedDelivery(state2, delivery);
      return false;
    }
    const hhDepth = this.hhSubmissionDepths.get(hhKey) ?? 0;
    const hhUnresolved = [...state2.hhReceipts.values()].filter(receipt => receipt.status === "pending" || receipt.status === "unconfirmed").length;
    if (hhDepth >= 256 || hhUnresolved >= 256 || state2.pendingSourcesByClientMessageId.size >= 256) {
      hhDeliveryTrace(delivery, "expired-unsubmitted", { reason: "admission-capacity" });
      hhDeliveryNotify(delivery, "dropped");
      this.finishRejectedDelivery(state2, delivery);
      return false;
    }
    hhDeliveryTrace(delivery, "admission", { depth: hhDepth });
    this.hhSubmissionDepths.set(hhKey, hhDepth + 1);
    let settle;
    const receipt = new Promise(resolve => { settle = resolve; });
    const receiptEntry = { promise: receipt, status: "pending" };
    state2.hhReceipts.set(delivery.clientMessageId, receiptEntry);
    let done = false;
    const expire = (reason) => {
      if (done) return;
      ticket.expired = true;
      if (ticket.submitted) {
        this.hhUnconfirmedSubmissions.add(hhKey);
        hhDeliveryTrace(delivery, "submit-unconfirmed", { reason });
        // Bookkeeping stays; the outbound notice is only for a genuine timeout.
        if (reason !== "shutdown" && reason !== "cancel-request" && this.states.get(runtimeKey(delivery.runtime)) === state2) hhDeliveryNotify(delivery, "unconfirmed");
        // Preserve pending source and client ID: remote acceptance is unknown.
        finish(null);
      } else {
        state2.pendingSourcesByClientMessageId.delete(delivery.clientMessageId);
        if (this.states.get(runtimeKey(delivery.runtime)) === state2) this.finishRejectedDelivery(state2, delivery);
        hhDeliveryTrace(delivery, "expired-unsubmitted", { reason });
        // A mute, ownership move or recreate before expiry supersedes this state:
        // another owner handles the room now, so no notice from here.
        const superseded = this.hhClosed || this.states.get(runtimeKey(delivery.runtime)) !== state2;
        // While this runtime is quarantined or awaiting a receipt, a resend would
        // be rejected or duplicated, so the notice must ask the person to wait.
        const blocked = this.hhQuarantinedKeys.has(hhKey) || this.hhUnconfirmedSubmissions.has(hhKey);
        if (!superseded && ["admission-deadline", "admission-capacity", "prior-receipt-unconfirmed", "registration-unconfirmed"].includes(reason)) hhDeliveryNotify(delivery, blocked ? "held" : "dropped");
        finish(false);
      }
    };
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.hhTickets.delete(expire);
      receiptEntry.status = value === null ? "unconfirmed" : value ? "accepted" : "rejected";
      settle(value);
      this.hhPruneReceipts(state2);
    };
    const timer = setTimeout(() => expire("admission-deadline"), Math.max(0, hhAdmissionLimitMs - (performance.now() - ticket.arrived)));
    timer.unref?.();
    expire.runtimeKey = runtimeKey(delivery.runtime);
    this.hhTickets.add(expire);
    const submission = (this.hhSubmissionLanes.get(hhKey) ?? Promise.resolve()).then(() => {
      if (this.hhClosed) { expire("shutdown"); return false; }
      if (this.hhUnconfirmedSubmissions.has(hhKey)) { expire("prior-receipt-unconfirmed"); return false; }
      hhDeliveryCheck(delivery);
      return this.submitDelivery(state2, delivery);
    });
    submission.then(value => {
      const depth = (this.hhSubmissionDepths.get(hhKey) ?? 1) - 1;
      if (depth) this.hhSubmissionDepths.set(hhKey, depth); else this.hhSubmissionDepths.delete(hhKey);
      if (ticket.expired && !ticket.submitted) expire("admission-deadline");
      else finish(value);
    }, (error) => {
      const depth = (this.hhSubmissionDepths.get(hhKey) ?? 1) - 1;
      if (depth) this.hhSubmissionDepths.set(hhKey, depth); else this.hhSubmissionDepths.delete(hhKey);
      if (ticket.submitted) expire("receipt-error");
      else expire(/registration is unconfirmed/.test(String(error?.message ?? "")) ? "registration-unconfirmed" : "registration-or-policy-error");
    });`);
  replace('    state2.submissionQueue = submission.then(() => {', '    const hhTail = submission.then(() => {');
  replace('    return submission;\n  }\n  async submitDelivery', `    this.hhSubmissionLanes.set(hhKey, hhTail);
    hhTail.then(() => { if (this.hhSubmissionLanes.get(hhKey) === hhTail) this.hhSubmissionLanes.delete(hhKey); });
    return receipt;
  }
  async submitDelivery`);
  replace('      await this.enqueueRegistration(async () => {\n        state2.routedSources', `      hhDeliveryTrace(delivery, "registration-queue");
      await this.enqueueRegistration([delivery.runtime], async () => {
        hhDeliveryCheck(delivery);
        if (this.hhClosed || this.states.get(runtimeKey(delivery.runtime)) !== state2) throw new Error("Channel runtime superseded");
        hhDeliveryTrace(delivery, "registration-start");
        state2.routedSources`);
  replace('      const response = await this.client.submitInput({', `      hhDeliveryCheck(delivery);
      if (this.hhClosed || this.states.get(runtimeKey(delivery.runtime)) !== state2) throw new Error("Channel runtime superseded");
      delivery.hhDelivery.submitted = true;
      hhDeliveryTrace(delivery, "submit-start");
      const response = await this.client.submitInput({`);
  replace('      if (!response.accepted) {\n        state2.pendingSourcesByClientMessageId', `      hhDeliveryTrace(delivery, response.accepted ? (response.disposition === "queued" ? "ack-queued" : "ack-accepted") : "ack-rejected");
      this.hhUnconfirmedSubmissions.delete(runtimeKey(delivery.runtime));
      this.hhRecordReceipt(state2, delivery.clientMessageId, response.accepted === true);
      if (!response.accepted) {
        if (this.hhClosed || this.states.get(runtimeKey(delivery.runtime)) !== state2) return false;
        state2.pendingSourcesByClientMessageId`);
  replace(`    } catch (error5) {
      state2.pendingSourcesByClientMessageId.delete(delivery.clientMessageId);
      if (workAtSubmit && !state2.active)
        this.finishRejectedDelivery(state2, delivery);
      throw error5;
    }
  }
  remainingSources`, `    } catch (error5) {
      // The admission owner performs cleanup exactly once. A submit transport
      // error must retain sources/identity because acceptance is unknown.
      throw error5;
    }
  }
  remainingSources`);
  replace('        if (workAtSubmit && !state2.active) this.finishRejectedDelivery(state2, delivery);', '        this.finishRejectedDelivery(state2, delivery);');
  replace('        if (workAtSubmit && !state2.active)\n          this.finishRejectedDelivery(state2, delivery);', '        this.finishRejectedDelivery(state2, delivery);');
  replace('      if (!hhQueuedDeliveryAllowed(delivery)) {\n        state2.pendingSourcesByClientMessageId.delete', '      if (!hhQueuedDeliveryAllowed(delivery)) {\n        hhDeliveryTrace(delivery, "policy-rejected");\n        state2.pendingSourcesByClientMessageId.delete');
  replace('  async submitApprovalResponse(runtime, response) {', `  hhCancelAdmissions(runtime) {
    let cancelled = false;
    for (const expire of this.hhTickets) {
      if (expire.runtimeKey === runtimeKey(runtime)) { expire("cancel-request"); cancelled = true; }
    }
    return cancelled;
  }
  async submitApprovalResponse(runtime, response) {`);
  replace('  let gateway;\n  gateway = new ChannelGateway(client, {', '  hhNotifyUndelivered = (delivery, kind) => hhSendUndeliveredNotice(registry4, delivery, kind);\n  let gateway;\n  gateway = new ChannelGateway(client, {');
  replace('  registry4.setCancelHandler(async ({ runtime }) => {', '  registry4.setCancelHandler(async ({ runtime }) => {\n    gateway.hhCancelAdmissions(runtime);');
  // Every coordinated mutation reserves its runtime(s), including publication
  // before a state exists. Reserve the complete set synchronously: no deadlock.
  replace('    await this.enqueueRegistration(async () => {\n      if (state2.active)', '    await this.enqueueRegistration([delivery.runtime], async () => {\n      if (this.states.get(key4) !== state2) throw new Error("Channel runtime superseded");\n      if (state2.active)');
  replace('    await this.enqueueRegistration(async () => {\n      this.setRoutedSources', '    await this.enqueueRegistration([runtime], async () => {\n      if (this.states.get(runtimeKey(runtime)) !== state2) throw new Error("Channel runtime superseded");\n      this.setRoutedSources');
  replace('      const tool = await this.hooks.buildExternalTool(runtime, sources);', '      const tool = await this.hhBuildTool(runtime, sources);\n      if (this.hhClosed) throw new Error("Channel gateway closed");\n      if (this.states.has(runtimeKey(runtime))) return false;');
  replace('    return await this.enqueueRegistration(async () => {', '    return await this.enqueueRegistration([runtime], async () => {');
  replace('    await this.enqueueRegistration(async () => {\n      const key4', '    await this.enqueueRegistration([runtime], async () => {\n      const key4');
  replace('      getKnownRuntimes: () => gateway.getKnownRuntimes(),', '      getKnownRuntimes: () => gateway.getKnownRuntimes(),\n      runtimeId: runtime => gateway.hhRuntimeId(runtime),');
  replace('  updateRoutedRuntimeTools(updates, routedSources) {', '  updateRoutedRuntimeTools(updates, routedSources, hhAllowed = () => true) {');
  replace('      publish: (updates, routedSources) => gateway.updateRoutedRuntimeTools(updates, routedSources)', '      publish: (updates, routedSources, hhAllowed) => gateway.updateRoutedRuntimeTools(updates, routedSources, hhAllowed)');
  replace('    return this.enqueueRegistration(async () => {\n      if (updates.length', '    return this.enqueueRegistration([...updates.flatMap(update => update.runtimes), ...routedSources.map(update => update.runtime)], async () => {\n      if (!hhAllowed()) throw new Error("Channel refresh expired before publication");\n      const hhSourceStates = new Map(routedSources.map(update => { const state = this.states.get(runtimeKey(update.runtime)); return [runtimeKey(update.runtime), { state, revision: state?.hhRevision }]; }));\n      if (updates.length');
  replace('      for (const update3 of routedSources) {\n        this.setRoutedSources', '      if (!hhAllowed() || this.hhClosed) return;\n      for (const update3 of routedSources) {\n        const previous = hhSourceStates.get(runtimeKey(update3.runtime));\n        const current = this.states.get(runtimeKey(update3.runtime));\n        if (current !== previous.state || current?.hhRevision !== previous.revision) continue;\n        this.setRoutedSources');
  replace('        pendingSourcesByClientMessageId: new Map,', '        hhOpaqueId: this.hhRuntimeId(runtime),\n        hhReceipts: this.hhReceiptMaps.get(key4) ?? new Map(),\n        pendingSourcesByClientMessageId: new Map,');
  replace('      this.states.set(key4, state2);', '      state2.hhRevision = 0;\n      this.states.set(key4, state2);\n      this.hhReceiptMaps.set(key4, state2.hhReceipts);');
  replace('  setRoutedSources(runtime, sources) {\n    this.getState(runtime).routedSources = uniqueRoutedSources(sources);', `  setRoutedSources(runtime, sources) {
    const state = this.getState(runtime);
    state.hhRevision++;
    state.routedSources = uniqueRoutedSources(sources);`);
  replace('  adoptQueuedDelivery(delivery) {\n    const state2 = this.getState(delivery.runtime);', '  adoptQueuedDelivery(delivery) {\n    const state2 = this.getState(delivery.runtime);\n    state2.hhRevision++;');
  replace('        if (state2.active !== active)\n          return;', '        if (this.hhClosed || this.states.get(key4) !== state2 || state2.active !== active)\n          return;');
  replace('        state2.routedSources = previousRoutedSources;', '        if (this.states.get(key4) === state2 && state2.hhRevision === hhAdoptRevision) state2.routedSources = previousRoutedSources;');
  replace('      const previousRoutedSources = state2.routedSources;', '      const hhAdoptRevision = state2.hhRevision;\n      const previousRoutedSources = state2.routedSources;');
  replace('        if (!stateExisted && state2.active === null)\n          this.states.delete(key4);', '        if (!stateExisted && state2.active === null && this.states.get(key4) === state2 && state2.hhRevision === hhAdoptRevision)\n          this.states.delete(key4);');
  replace('      this.rememberAcceptedClientMessageId(state2, delivery.clientMessageId);\n      for (const source', `      this.rememberAcceptedClientMessageId(state2, delivery.clientMessageId);
      if (this.hhClosed || this.states.get(runtimeKey(delivery.runtime)) !== state2) return true;
      for (const source`);
  replace('  rememberAcceptedClientMessageId(state2, clientMessageId) {', `  hhPruneReceipts(state) {
    for (const [id, receipt] of state.hhReceipts) {
      if (state.hhReceipts.size <= MAX_ACCEPTED_CLIENT_MESSAGE_IDS) break;
      // Pending/unknown status belongs to the stable receipt, NOT disposable
      // pendingSources. Deleting/recreating a runtime must never make it evictable.
      if (receipt.status === "accepted" || receipt.status === "rejected") state.hhReceipts.delete(id);
    }
  }
  hhRecordReceipt(state, id, accepted) {
    state.hhReceipts.set(id, { promise: Promise.resolve(accepted), status: accepted ? "accepted" : "rejected" });
    this.hhPruneReceipts(state);
  }
  rememberAcceptedClientMessageId(state2, clientMessageId) {
    this.hhRecordReceipt(state2, clientMessageId, true);`);
  replace('  enqueueHook(state2, hook) {\n    let pending2;', `  enqueueHook(state2, hook) {
    const originalHook = hook;
    hook = () => {
      if (this.states.get(runtimeKey(state2.runtime)) === state2) return originalHook();
    };
    let pending2;`);
  replace(`  enqueueRegistration(task2) {
    const result3 = this.registrationQueue.then(task2, task2);
    this.registrationQueue = result3.then(() => {
      return;
    }, () => {
      return;
    });
    return result3;
  }`, `  enqueueRegistration(runtimes, task2) {
    const keys = [...new Set(runtimes.map(runtimeKey))];
    if (keys.some(key => this.hhQuarantinedKeys.has(key))) return Promise.reject(new Error('Channel runtime registration is unconfirmed; reconciliation required'));
    const previous = keys.map(key => this.registrationLanes.get(key));
    let started = false, expired = false, rejectWait;
    const waitExpired = new Promise((_, reject) => { rejectWait = reject; });
    const timer = setTimeout(() => {
      if (started) return;
      expired = true;
      hhDeliveryLog({ phase: 'registration-barrier-expired', runtime: runtimes[0] ? this.hhRuntimeId(runtimes[0]) : undefined, depth: keys.length });
      rejectWait(new Error('Registration queue deadline exceeded'));
    }, hhAdmissionLimitMs);
    timer.unref?.();
    const work = Promise.all(previous).then(() => {
      if (expired || this.hhClosed) throw new Error("Channel registration cancelled before start");
      started = true;
      clearTimeout(timer);
      return task2();
    });
    const result = Promise.race([work, waitExpired]);
    const settled = result.then(() => {}, () => {});
    keys.forEach((key, index) => {
      // A cancelled, not-started barrier releases B, but never bypasses A's
      // preceding in-flight operation. Each tail retains its own predecessor.
      const tail = Promise.all([previous[index], settled]).then(() => {});
      this.registrationLanes.set(key, tail);
      tail.then(() => { if (this.registrationLanes.get(key) === tail) this.registrationLanes.delete(key); });
    });
    return result;
  }
  async hhBuildTool(runtime, sources, delivery) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        hhDeliveryLog({ phase: 'tool-build-expired', runtime: this.hhRuntimeId(runtime) });
        reject(new Error('Channel tool construction deadline exceeded'));
      }, delivery?.hhDelivery ? Math.max(0, hhAdmissionLimitMs - (performance.now() - delivery.hhDelivery.arrived)) : hhAdmissionLimitMs);
      timer.unref?.();
    });
    try { return await Promise.race([this.hooks.buildExternalTool(runtime, sources), deadline]); }
    finally { clearTimeout(timer); }
  }
  hhRuntimeId(runtime) {
    const key = runtimeKey(runtime);
    if (!this.hhRuntimeIds.has(key)) this.hhRuntimeIds.set(key, crypto.randomUUID());
    return this.hhRuntimeIds.get(key);
  }
  async hhRemoteMutation(method, args) {
    const runtimes = method === "runtimeStart" ? [args] : args.updates.flatMap(update => update.runtimes);
    try { return await this.client[method](args); }
    catch {
      for (const runtime of runtimes) this.hhQuarantinedKeys.add(runtimeKey(runtime));
      // Client timeout/disconnect is not a remote completion receipt. Keep the
      // lane quarantined for this gateway generation; restart/reconnect must
      // reconcile server state before reusing the runtime.
      hhDeliveryLog({ phase: 'registration-unconfirmed', runtime: runtimes[0] ? this.hhRuntimeId(runtimes[0]) : undefined, depth: runtimes.length, reason: 'remote-receipt-error' });
      return await new Promise(() => {});
    }
  }`);
  // All remote registration/tool mutations share the same ambiguity rule.
  const gatewayStart = text.indexOf('class ChannelGateway {');
  const gatewayEnd = text.indexOf('\nfunction ', gatewayStart);
  if (gatewayStart < 0 || gatewayEnd <= gatewayStart) throw new Error('Channel gateway boundary mismatch');
  let gateway = text.slice(gatewayStart, gatewayEnd);
  for (const [method, count] of [['runtimeStart', 1], ['runtimeExternalToolsUpdate', 3]]) {
    const from = `this.client.${method}({`;
    if (gateway.split(from).length !== count + 1) throw new Error(`Channel mutation contract mismatch: ${method}`);
    gateway = gateway.replaceAll(from, `this.hhRemoteMutation("${method}", {`);
  }
  text = text.slice(0, gatewayStart) + gateway + text.slice(gatewayEnd);
  replace('    const tool = await this.hooks.buildExternalTool(delivery.runtime, delivery.sources);', `    hhDeliveryCheck(delivery);
    const hhRevision = state2.hhRevision;
    hhDeliveryTrace(delivery, "tool-build-start");
    const tool = await this.hhBuildTool(delivery.runtime, delivery.sources, delivery);
    hhDeliveryTrace(delivery, "tool-build-end");
    hhDeliveryCheck(delivery);
    if (this.hhClosed || this.states.get(runtimeKey(delivery.runtime)) !== state2 || state2.hhRevision !== hhRevision) throw new Error("Channel runtime superseded");`);
  replace('      const agentRecord = response.agent;', `      // A release/close can invalidate this state while runtimeStart is in flight.
      // Never republish stale state; the runtime lane remains held until here.
      if (this.hhClosed || this.states.get(runtimeKey(delivery.runtime)) !== state2 || state2.hhRevision !== hhRevision) throw new Error("Channel runtime superseded");
      const agentRecord = response.agent;`);
  replace('      await registration;\n    } catch', '      await registration;\n      hhDeliveryTrace(delivery, "registration-end");\n      hhDeliveryCheck(delivery);\n    } catch');
  replace('  async stopAll() {\n    for (const adapter of Array.from(this.adapters.values())) {', `  async stopAll() {
    this.hhStopped = true;
    for (const delivery of this.buffer.splice(0)) {
      clearTimeout(delivery.hhDelivery?.bufferTimer);
      if (delivery.hhDelivery) delivery.hhDelivery.expired = true;
      hhDeliveryTrace(delivery, "expired-unsubmitted", { reason: "shutdown" });
    }
    for (const adapter of Array.from(this.adapters.values())) {`);
  replace('  deliverOrBuffer(delivery) {\n    if (!hhQueuedDeliveryAllowed(delivery)) return;', `  deliverOrBuffer(delivery) {
    hhDeliveryTicket(delivery);
    hhDeliveryTrace(delivery, "arrival");
    if (this.hhStopped) { delivery.hhDelivery.expired = true; hhDeliveryTrace(delivery, "expired-unsubmitted", { reason: "shutdown" }); return; }
    if (!hhQueuedDeliveryAllowed(delivery)) { hhDeliveryTrace(delivery, "policy-rejected"); return; }`);
  replace('    this.buffer.push(delivery);\n  }\n  flushBuffer()', `    if (this.buffer.length >= 256) { delivery.hhDelivery.expired = true; hhDeliveryTrace(delivery, "expired-unsubmitted", { reason: "readiness-capacity" }); hhDeliveryNotify(delivery, "dropped"); return; }
    hhDeliveryTrace(delivery, "readiness-buffer", { depth: this.buffer.length });
    this.buffer.push(delivery);
    const timer = setTimeout(() => {
      const index = this.buffer.indexOf(delivery);
      if (index < 0) return;
      this.buffer.splice(index, 1);
      delivery.hhDelivery.expired = true;
      hhDeliveryTrace(delivery, "expired-unsubmitted", { reason: "readiness-deadline" });
      hhDeliveryNotify(delivery, "dropped");
    }, Math.max(0, hhAdmissionLimitMs - (performance.now() - delivery.hhDelivery.arrived)));
    timer.unref?.();
    delivery.hhDelivery.bufferTimer = timer;
  }
  flushBuffer()`);
  replace('      if (item && hhQueuedDeliveryAllowed(item)) {\n        this.messageHandler(item);', `      if (item) {
        clearTimeout(item.hhDelivery?.bufferTimer);
        try { hhDeliveryCheck(item); } catch { hhDeliveryTrace(item, "expired-unsubmitted", { reason: "readiness-deadline" }); hhDeliveryNotify(item, "dropped"); continue; }
        if (!hhQueuedDeliveryAllowed(item)) { hhDeliveryTrace(item, "policy-rejected"); continue; }
        this.messageHandler(item);`);
  replace('      hhAdmission: delivery.hhAdmission,', '      hhAdmission: delivery.hhAdmission,\n      hhDelivery: delivery.hhDelivery,');
  replace('      if (!accepted) {\n        options.logger?.("[ChannelGateway] Harness rejected channel input");', '      if (accepted === false) {\n        options.logger?.("[ChannelGateway] Input was not submitted or was rejected; see HearthsideDelivery diagnostic");');
  const refreshStart = text.indexOf('  const runRefresh = async () => {', text.indexOf('function createRoutedRuntimeRegistrationRefresher(options)'));
  const refreshEnd = text.indexOf('  const refresh = () => {', refreshStart);
  if (refreshStart < 0 || refreshEnd < refreshStart) throw new Error('Channel refresh contract mismatch');
  text = text.slice(0, refreshStart) + `  const runRefresh = async () => {
    for (const channel of options.channelNames) loadRoutes(channel);
    const entries = new Map(groupSourcesByRuntime(options.registry.resolveRoutedTurnSources()).map(entry => [runtimeKey2(entry.runtime), entry]));
    for (const runtime of options.publisher.getKnownRuntimes?.() ?? []) {
      const key = runtimeKey2(runtime);
      if (!entries.has(key)) entries.set(key, { runtime, sources: [] });
    }
    for (const [key, published] of publishedSignatures) {
      if (!entries.has(key)) entries.set(key, { runtime: published.runtime, sources: [], remove: true });
    }
    // Tool construction and publication are independent by runtime. A hung A
    // cannot stop B's tool publication or hold B behind an aggregate build.
    const results = await Promise.allSettled([...entries].map(async ([key, entry]) => {
      let expired = false, timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          hhDeliveryLog({ phase: 'tool-refresh-expired', runtime: options.publisher.runtimeId?.(entry.runtime) });
          reject(new Error('Channel tool refresh deadline exceeded'));
        }, hhAdmissionLimitMs);
        timer.unref?.();
      });
      const work = (async () => {
        const tool = entry.remove ? null : await options.buildTool(entry.sources, entry.runtime);
        if (expired || closed) return;
        const externalTools = tool ? [{ tools: [tool] }] : [];
        const signature = JSON.stringify(externalTools);
        const updates = publishedSignatures.get(key)?.signature === signature ? [] : [{ runtimes: [entry.runtime], external_tools: externalTools }];
        await options.publisher.publish(updates, [{ runtime: entry.runtime, sources: entry.sources }], () => !expired && !closed);
        if (expired || closed) return;
        if (entry.remove) publishedSignatures.delete(key);
        else publishedSignatures.set(key, { runtime: entry.runtime, signature });
      })();
      try { await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
    }));
    if (results.some(result => result.status === 'rejected')) throw new Error('Channel tool refresh incomplete; see delivery diagnostics');
  };
` + text.slice(refreshEnd);
  replace(`  for (const recovered of recoveredByRuntime.values()) {
    const replayedRequestIds = await gateway.restoreRuntime(recovered.runtime, recovered.sources);
    for (const requestId of recovered.requestIds) {
      if (!replayedRequestIds.has(requestId)) {
        registry4.clearPendingControlRequest(requestId);
      }
    }
  }
  await routedRuntimeRegistrationRefresher.refresh();`, `  for (const recovered of recoveredByRuntime.values()) {
    // restoreRuntime reserves this runtime's lane synchronously before its first
    // await. Ready B must not wait for A's replay; new A still waits behind it.
    hhDeliveryLog({ phase: "recovery-start", runtime: gateway.hhRuntimeId(recovered.runtime) });
    gateway.restoreRuntime(recovered.runtime, recovered.sources).then(replayedRequestIds => {
      if (gateway.hhClosed) return;
      for (const requestId of recovered.requestIds) {
        if (!replayedRequestIds.has(requestId)) registry4.clearPendingControlRequest(requestId);
      }
      hhDeliveryLog({ phase: "recovery-complete", runtime: gateway.hhRuntimeId(recovered.runtime) });
    }).catch(() => {
      // Failed/ambiguous replay cannot prove an approval is obsolete. Keep its
      // persisted control request, and never log its private payload or ID.
      if (!gateway.hhClosed) hhDeliveryLog({ phase: "recovery-incomplete", runtime: gateway.hhRuntimeId(recovered.runtime), reason: "registration-error" });
    });
  }
  routedRuntimeRegistrationRefresher.requestRefresh();`);
  replace(`      try {
        await registry4.stopAll();
      } finally {
        gateway.close();
      }`, `      // Fence pending admissions/recovery before awaiting adapter shutdown.
      // A slow adapter stop must not allow a late registration to submit input.
      try {
        gateway.close();
      } finally {
        await registry4.stopAll();
      }`);
  return text;
}
