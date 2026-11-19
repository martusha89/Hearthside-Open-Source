// Exact-contract Letta 0.34.36 fix applied to the validated runtime copy.
//
// On the local backend a turn's model request could not be stopped. The
// provider stream is handed back with an AbortController that nothing listens
// to: cancelling a run aborts that controller, marks the run cancelled and
// answers the person at once, while the request to the model runs on to its
// end and its whole reply is saved into the conversation afterwards (a tester
// stopped a reply and found it completed in the chat almost a minute later).
//
// Each turn now gets its own cancel handle that the provider request does
// listen to. The adapter keeps one optional signal for its whole life, so the
// turn runs on a view of the adapter carrying this turn's signal instead; the
// adapter holds no other per-instance state.
//
// That handle is deliberately NOT the stream's `controller`. The listener
// aborts `stream.controller` on its own account too: its stall check does so
// after 60 seconds without a first chunk, expecting to drop a dead read and
// resume. Upstream that abort does nothing on the local backend. Wired to the
// provider request it ended every turn whose model took more than a minute to
// start answering (a large local model loading, a long compaction) as
// "cancelled", with nobody having pressed Stop. So `controller` stays the
// inert one upstream hands back, and the real handle is registered only where
// a run is cancelled on purpose: the backend's cancel of that run.
//
// A cancelled stream ends as cancelled rather than as an error. What had
// streamed is not kept: the store rolls back an unfinished reply when a run is
// cancelled, as it did before this change.
function replaceExact(state, label, from, to) {
  const count = state.text.split(from).length - 1;
  if (count !== 1) throw new Error(`Local turn cancel contract mismatch: expected 1 ${label} seam, found ${count}`);
  state.text = state.text.split(from).join(to);
}

const CANCELLED = '{ message_type: "stop_reason", stop_reason: "cancelled" }';

export function transformLocalTurnCancel(source) {
  const state = { text: source };

  replaceExact(state, 'provider stream controller',
    `function createProviderLettaStream(events, contextTokensEstimate) {
  const controller = new AbortController;`,
    `function createProviderLettaStream(events, contextTokensEstimate, hearthsideTurnCancel) {
  const controller = new AbortController;
  const hearthsideCancel = hearthsideTurnCancel ?? controller;`);

  replaceExact(state, 'provider stream handle',
    `  const hearthsideCancel = hearthsideTurnCancel ?? controller;
  return {
    controller,`,
    `  const hearthsideCancel = hearthsideTurnCancel ?? controller;
  return {
    controller,
    hearthsideCancel,`);

  replaceExact(state, 'provider stream loop',
    `      try {
        for await (const event of events) {
          if (event.type === "error") {
            yield* createProviderErrorChunks(event.error);
            return;
          }
          if (event.type === "local-message") {`,
    `      try {
        for await (const event of events) {
          if (hearthsideCancel.signal.aborted) {
            yield ${CANCELLED};
            return;
          }
          if (event.type === "error") {
            yield* createProviderErrorChunks(event.error);
            return;
          }
          if (event.type === "local-message") {`);

  replaceExact(state, 'provider stream end',
    `        if (pendingStopReason) {
          yield pendingStopReason;
        } else if (sawToolCall) {
          yield {
            message_type: "stop_reason",
            stop_reason: "requires_approval"
          };
        }
      } catch (error4) {
        yield* createProviderErrorChunks(error4);
      }
    }
  };
}`,
    `        if (hearthsideCancel.signal.aborted) {
          yield ${CANCELLED};
        } else if (pendingStopReason) {
          yield pendingStopReason;
        } else if (sawToolCall) {
          yield {
            message_type: "stop_reason",
            stop_reason: "requires_approval"
          };
        }
      } catch (error4) {
        if (hearthsideCancel.signal.aborted) {
          yield ${CANCELLED};
          return;
        }
        yield* createProviderErrorChunks(error4);
      }
    }
  };
}`);

  replaceExact(state, 'provider turn executor',
    `  async execute(input) {
    const providerInput = buildProviderTurnInput(input);
    const events = await this.adapter.stream(providerInput);
    return createProviderLettaStream(events, estimateProviderContextTokens(providerInput));
  }`,
    `  async execute(input) {
    const providerInput = buildProviderTurnInput(input);
    const hearthsideTurnCancel = new AbortController;
    const hearthsideAdapter = Object.create(this.adapter);
    hearthsideAdapter.abortSignal = this.adapter.abortSignal ? AbortSignal.any([this.adapter.abortSignal, hearthsideTurnCancel.signal]) : hearthsideTurnCancel.signal;
    const events = await hearthsideAdapter.stream(providerInput);
    return createProviderLettaStream(events, estimateProviderContextTokens(providerInput), hearthsideTurnCancel);
  }`);

  // Cancelling the run on purpose is what reaches the provider.
  replaceExact(state, 'run cancel registration',
    'this.runControllerByRunId.set(run.id, stream11.controller);',
    'this.runControllerByRunId.set(run.id, stream11.hearthsideCancel ?? stream11.controller);');
  replaceExact(state, 'late start cancel',
    'late.controller.abort()',
    '(late.hearthsideCancel ?? late.controller).abort()');

  return state.text;
}
