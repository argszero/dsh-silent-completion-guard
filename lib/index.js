/**
 * Report a reasoning-only model stop as an empty response, so the turn retries
 * or fails loudly instead of completing with nothing to show.
 *
 * The agent loop settles a step as `completed` whenever the assembled assistant
 * message carries no tool call (`packages/core/agent-loop/src/agent.ts`, the
 * `toolCalls.length === 0` branch). It consults only the finish reason for
 * `max-tokens`, so a provider that ends an attempt after streaming reasoning
 * and nothing else is indistinguishable from a normal stop: the turn ends
 * `completed`, the durable message holds one reasoning block, and nothing
 * retries. `EMPTY_RESPONSE` already exists for exactly this class of failure
 * and is already in the default retryable set, but it is only ever raised for a
 * response carrying no content blocks at all, and a reasoning block counts as
 * content.
 *
 * This plugin classifies that shape at the `llm/stream` response, which is the
 * frame handed to the loop: the terminal chunk of a qualifying attempt is
 * rewritten from `{kind:'stop'}` to `{kind:'error', failure:{code:'EMPTY_RESPONSE'}}`.
 * The loop then takes its error branch, retry policy decides whether to repeat
 * the request, and an exhausted retry budget fails the turn loudly.
 *
 * Boundaries, stated because they decide what this package can claim:
 * - Durable history is untouched. The rewritten attempt is recorded as
 *   `assistant/attempt`, and the original chunks still stream to every observer.
 * - The provider is untouched. No request is changed and no attempt is hidden.
 * - It is not the core fix. A turn that ends with a reason of its own, distinct
 *   from `completed`, needs the loop to own that reason; this plugin makes the
 *   existing empty-response path reachable.
 *
 * Fail-open by construction: it fires only on positive evidence of reasoning
 * and no evidence of visible text or a tool call, so any shape it does not
 * recognise leaves the stream exactly as the adapter produced it.
 *
 * @module dsh-silent-completion-guard
 */

import { EMPTY_RESPONSE_CODE, chunkHasVisibleText } from '@deepseek-ai/dsh-llm'

/** Plugin name reported by the loader. */
export const name = '@argszero/dsh-silent-completion-guard'

/**
 * Hard requirement: the seam is the LLM runtime's own waterfall, so an absent
 * instance must leave this plugin pending rather than loaded and inert.
 */
export const inject = ['llm']

/**
 * Failure text an operator sees when the retry budget runs out. It names the
 * cause, because "empty response" alone would be read as a provider fault.
 */
const FAILURE_MESSAGE = 'The model stopped after reasoning without emitting visible text or a tool call. '
  + 'Reporting an empty response so the request is retried instead of completing a turn with no reply.'

/**
 * Whether a string carries anything a reader would see. Whitespace-only output
 * is not visible text, which is the same rule the harness applies.
 * @param text - candidate fragment or block text.
 * @returns whether the value is a string with at least one non-whitespace character.
 */
function hasText(text) {
  return typeof text === 'string' && /\S/u.test(text)
}

/**
 * Accumulate the three facts that decide this classification from a live chunk
 * stream: visible text, a tool call, and reasoning.
 * @returns a detector whose `silent` property answers whether the attempt so far
 *   produced reasoning and nothing a reader could act on.
 */
export function createSilentStopDetector() {
  let visibleText = false
  let toolCall = false
  let reasoning = false
  // Set when a chunk could not be read at all. An unreadable stream is not
  // evidence of silence, so it suppresses the rewrite rather than guessing.
  let unreadable = false

  function observeBlock(block) {
    if (typeof block !== 'object' || block === null) return
    if (block.type === 'tool-call') {
      toolCall = true
      return
    }
    if (block.type === 'reasoning' && hasText(block.text)) reasoning = true
  }

  function observe(chunk) {
    // Once either fact is known the answer is settled, so stop reading.
    if (visibleText || toolCall) return
    if (typeof chunk !== 'object' || chunk === null) return
    switch (chunk.type) {
      case 'text-delta':
        if (hasText(chunk.text)) visibleText = true
        return
      case 'reasoning-delta':
        if (hasText(chunk.text)) reasoning = true
        return
      case 'tool-call-delta':
        toolCall = true
        return
      case 'block-start':
        if (chunk.blockType === 'tool-call') toolCall = true
        return
      case 'block-end':
        observeBlock(chunk.block)
        if (chunkHasVisibleText(chunk)) visibleText = true
        return
      default:
        return
    }
  }

  return {
    /**
     * Record one chunk. A chunk this detector cannot read leaves the stream
     * untouched instead of aborting it.
     * @param chunk - next stream chunk.
     */
    push(chunk) {
      try {
        observe(chunk)
      } catch {
        unreadable = true
      }
    },
    /** Whether the attempt produced reasoning and no visible text and no tool call. */
    get silent() {
      return !unreadable && !visibleText && !toolCall && reasoning
    },
    /** Current evidence, for diagnostics and tests. */
    get state() {
      return { visibleText, toolCall, reasoning, unreadable }
    },
  }
}

/**
 * Whether one chunk is the terminal frame of an attempt that should be reported
 * as an empty response.
 * @param chunk - candidate chunk.
 * @param detector - detector fed with every chunk of the same attempt.
 * @returns whether the chunk is a `stop` finish whose attempt produced only reasoning.
 */
export function qualifiesAsSilentCompletion(chunk, detector) {
  if (typeof chunk !== 'object' || chunk === null) return false
  if (chunk.type !== 'finish') return false
  const reason = chunk.reason
  if (typeof reason !== 'object' || reason === null) return false
  // `max-tokens`, `aborted`, `error` and `tool-calls` each already carry their
  // own meaning into the loop; only a plain stop is ambiguous.
  return reason.kind === 'stop' && detector.silent
}

/**
 * The terminal chunk substituted for a qualifying attempt. Replay state is
 * dropped because a failed attempt has no response envelope to replay.
 * @returns a fresh finish chunk carrying the harness's empty-response failure.
 */
export function emptyResponseFinish() {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { code: EMPTY_RESPONSE_CODE, message: FAILURE_MESSAGE },
    },
  }
}

/**
 * Wrap one attempt's chunk stream, substituting the terminal frame when the
 * attempt streamed reasoning and nothing else. Every other chunk is yielded
 * unchanged, in order, as it arrives.
 * @param stream - the chunk iterable the adapter produced.
 * @param options - `onRewrite` is called once per replacement, and its failure
 *   never affects the stream.
 * @returns the guarded iterable.
 */
export function guardStream(stream, options = {}) {
  const detector = createSilentStopDetector()
  const onRewrite = options.onRewrite
  return (async function* guarded() {
    for await (const chunk of stream) {
      detector.push(chunk)
      if (qualifiesAsSilentCompletion(chunk, detector)) {
        const replacement = emptyResponseFinish()
        if (typeof onRewrite === 'function') {
          try {
            onRewrite(replacement)
          } catch {
            // An announcement is a courtesy; it must not decide the stream.
          }
        }
        yield replacement
        continue
      }
      yield chunk
    }
  })()
}

/**
 * Mount the guard on one context.
 * @param ctx - plugin context providing the `llm` service.
 * @param config - `enabled` (default true) and `announce` (default true).
 * @returns the guard's counters, so a mount is inspectable.
 */
export function apply(ctx, config) {
  if (config?.enabled === false) {
    return { enabled: false, stats: () => ({ rewrites: 0 }) }
  }
  const announce = config?.announce !== false
  const stats = { rewrites: 0 }
  // Prepend so the rewrite happens at the outermost frame the loop receives,
  // even when another listener wraps the stream after this one.
  ctx.on('llm/stream', (options, next) => guardStream(next(), {
    onRewrite: () => {
      stats.rewrites += 1
      if (!announce) return
      ctx.logger?.warn?.(
        name + ': model "' + String(options?.model) + '" on provider "' + String(options?.provider)
        + '" stopped after reasoning with no visible text or tool call; reporting an empty response so the'
        + ' request is retried instead of completing a turn with no reply.',
      )
    },
  }), { prepend: true })
  return { enabled: true, stats: () => ({ ...stats }) }
}

export default { name, inject, apply }
