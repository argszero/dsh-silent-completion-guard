/** Unit suite for the reasoning-only stop classifier and its stream wrapper. */
import assert from 'node:assert/strict'
import test from 'node:test'

import { BlockAssembler, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'

import {
  apply,
  createSilentStopDetector,
  emptyResponseFinish,
  guardStream,
  qualifiesAsSilentCompletion,
} from '../lib/index.js'

const reasoning = (text = 'Let me think about this carefully.') => ({ type: 'reasoning-delta', index: 0, text })
const reasonDone = (text = 'That settles it.') => ({ type: 'block-end', index: 0, block: { type: 'reasoning', text } })
const textDelta = (text = 'Here is the answer.') => ({ type: 'text-delta', index: 1, text })
const textDone = (text = 'Here is the answer.') => ({ type: 'block-end', index: 1, block: { type: 'text', text } })
const finishStop = () => ({ type: 'finish', reason: { kind: 'stop' } })
const finishAs = kind => ({ type: 'finish', reason: { kind } })
const toolDelta = () => ({ type: 'tool-call-delta', index: 2, id: 'call_1', name: 'bash', argumentsDelta: '{"command":"ls"}' })
const toolBlock = { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' }

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function streamOf(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

const runGuarded = (chunks, options) => collect(guardStream(streamOf(chunks), options))

/**
 * The loop's own decision, taken through the harness's real assembler: the
 * branch order is `agent.ts`'s, over the chunks a guarded attempt hands it.
 */
function loopOutcome(chunks) {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') return { kind: 'failed', failure: finish.failure }
  const blocks = assembler.blocks()
  if (finish.kind === 'max-tokens') return { kind: 'max-tokens', blocks }
  const toolCalls = blocks.filter(block => block.type === 'tool-call')
  if (toolCalls.length === 0) return { kind: 'completed', blocks }
  return { kind: 'tool-calls', toolCalls }
}

test('rewrites a reasoning-only stop into an empty-response error', async () => {
  const out = await runGuarded([reasoning(), finishStop()])
  assert.equal(out.length, 2)
  assert.deepEqual(out[1], {
    type: 'finish',
    reason: { kind: 'error', failure: { code: EMPTY_RESPONSE_CODE, message: out[1].reason.failure.message } },
  })
})

test('names the cause in the failure so an exhausted retry budget is readable', async () => {
  const out = await runGuarded([reasoning(), finishStop()])
  const { failure } = out[1].reason
  assert.equal(failure.code, 'EMPTY_RESPONSE')
  assert.match(failure.message, /reasoning/u)
  assert.match(failure.message, /retried/u)
})

test('drops replay state, because a failed attempt has no envelope to replay', async () => {
  const chunk = { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { id: 'msg_1' } } }
  const out = await runGuarded([reasoning(), chunk])
  assert.equal(Object.hasOwn(out[1], 'replayState'), false)
  assert.equal(Object.hasOwn(out[1].reason, 'failure'), true)
})

test('keeps the chunk count and the identity of every untouched chunk', async () => {
  const first = reasoning()
  const last = finishStop()
  const out = await runGuarded([first, last])
  assert.equal(out[0], first)
  assert.notEqual(out[1], last)
})

test('rewrites every qualifying terminal frame, never twice for one frame', async () => {
  const out = await runGuarded([reasoning(), finishStop(), finishStop()])
  assert.equal(out.length, 3)
  assert.equal(out.filter(chunk => chunk.type === 'finish').length, 2)
  assert.equal(out.filter(chunk => chunk.reason?.kind === 'error').length, 2)
})

test('leaves a max-tokens stop untouched', async () => {
  const last = finishAs('max-tokens')
  const out = await runGuarded([reasoning(), last])
  assert.equal(out[1], last)
})

test('leaves an aborted finish untouched', async () => {
  const last = { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stopped' } } }
  const out = await runGuarded([reasoning(), last])
  assert.equal(out[1], last)
})

test('leaves an error finish untouched', async () => {
  const last = { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'boom' } } }
  const out = await runGuarded([reasoning(), last])
  assert.equal(out[1], last)
  assert.equal(out[1].reason.failure.code, 'SERVER')
})

test('leaves a reasoning stop carrying a streamed tool call untouched', async () => {
  const last = finishStop()
  const out = await runGuarded([reasoning(), toolDelta(), last])
  assert.equal(out[2], last)
})

test('leaves a reasoning stop carrying a completed tool-call block untouched', async () => {
  const last = finishStop()
  const out = await runGuarded([reasoning(), { type: 'block-end', index: 2, block: toolBlock }, last])
  assert.equal(out[2], last)
})

test('leaves a reasoning stop carrying a tool-call block start untouched', async () => {
  const last = finishStop()
  const out = await runGuarded([reasoning(), { type: 'block-start', index: 2, blockType: 'tool-call' }, last])
  assert.equal(out[2], last)
})

test('leaves a reasoning stop that also produced visible text untouched', async () => {
  const last = finishStop()
  const out = await runGuarded([reasoning(), textDelta(), last])
  assert.equal(out[2], last)
})

test('counts text that only arrived as a completed block', async () => {
  const last = finishStop()
  const out = await runGuarded([reasoning(), textDone(), last])
  assert.equal(out[2], last)
})

test('counts reasoning that only arrived as a completed block', async () => {
  const out = await runGuarded([reasonDone(), finishStop()])
  assert.equal(out[1].reason.kind, 'error')
  assert.equal(out[1].reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('leaves a whitespace-only reasoning block untouched, because it is not a reasoning block', async () => {
  const last = finishStop()
  const out = await runGuarded([{ type: 'block-end', index: 0, block: { type: 'reasoning', text: ' \n\t ' } }, last])
  assert.equal(out[1], last)
})

test('leaves a stop with no reasoning and no text untouched, which the adapter owns', async () => {
  const last = finishStop()
  const out = await runGuarded([last])
  assert.equal(out[0], last)
})

test('leaves a whitespace-only reasoning stop untouched, because it carries no reasoning block', async () => {
  const last = finishStop()
  const out = await runGuarded([reasoning('   \n  '), last])
  assert.equal(out[1], last)
})

test('treats whitespace-only text as invisible, matching the harness predicate', async () => {
  const out = await runGuarded([reasoning(), textDelta('  \n\t '), finishStop()])
  assert.equal(out[2].reason.kind, 'error')
  assert.equal(out[2].reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('passes unrecognised chunk types through without deciding anything', async () => {
  const odd = { type: 'quantum-flux', index: 9 }
  const last = finishStop()
  const out = await runGuarded([odd, last])
  assert.equal(out[0], odd)
  assert.equal(out[1], last)
})

test('never throws on a chunk it cannot read, and fails open', async () => {
  const malformed = { type: 'text-delta', index: 0, get text() { throw new Error('unreadable') } }
  const last = finishStop()
  const out = await runGuarded([malformed, reasoning(), last])
  assert.equal(out[0], malformed)
  assert.equal(out[2], last, 'an unreadable stream is not evidence of silence')
})

test('propagates an adapter failure unchanged', async () => {
  const failing = (async function* () {
    yield reasoning()
    throw new Error('transport died')
  })()
  await assert.rejects(collect(guardStream(failing)), /transport died/u)
})

test('streams lazily: no chunk waits for the ones behind it', async () => {
  const produced = []
  const stream = (async function* () {
    produced.push('reasoning')
    yield reasoning()
    await new Promise(resolve => setTimeout(resolve, 80))
    produced.push('finish')
    yield finishStop()
  })()
  const iterator = guardStream(stream)[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.value.type, 'reasoning-delta')
  assert.deepEqual(produced, ['reasoning'], 'the adapter must not have produced the finish yet')
  const second = await iterator.next()
  assert.equal(second.value.reason.kind, 'error')
})

test('propagates an early consumer break to the adapter iterator', async () => {
  let returned = false
  const stream = (async function* () {
    try {
      yield reasoning()
      yield textDelta()
      yield finishStop()
    } finally {
      returned = true
    }
  })()
  for await (const chunk of guardStream(stream)) {
    assert.equal(chunk.type, 'reasoning-delta')
    break
  }
  assert.equal(returned, true)
})

test('does not mutate the chunks it forwards', async () => {
  const frozen = Object.freeze({ type: 'text-delta', index: 1, text: 'visible' })
  const out = await runGuarded([reasoning(), frozen, finishStop()])
  assert.equal(out[1], frozen)
  assert.equal(out[1].text, 'visible')
})

test('announces once per rewrite and never lets the announcement break the stream', async () => {
  const announced = []
  const out = await runGuarded([reasoning(), finishStop(), finishStop()], {
    onRewrite: (replacement) => {
      announced.push(replacement.reason.failure.code)
      throw new Error('announcer exploded')
    },
  })
  assert.deepEqual(announced, ['EMPTY_RESPONSE', 'EMPTY_RESPONSE'])
  assert.equal(out.filter(chunk => chunk.reason?.kind === 'error').length, 2)
})

test('the detector answers silent only for reasoning without text or tool call', () => {
  const detector = createSilentStopDetector()
  detector.push(reasoning())
  assert.equal(detector.silent, true)
  assert.deepEqual(detector.state, { visibleText: false, toolCall: false, reasoning: true, unreadable: false })
  detector.push(textDelta())
  assert.equal(detector.silent, false)
})

test('a substitute finish carries the canonical code and no extra fields', () => {
  assert.deepEqual(Object.keys(emptyResponseFinish()), ['type', 'reason'])
  assert.equal(emptyResponseFinish().reason.failure.code, EMPTY_RESPONSE_CODE)
})

test('a finish chunk is only qualifying when its reason is a plain stop', () => {
  const silent = createSilentStopDetector()
  silent.push(reasoning())
  assert.equal(qualifiesAsSilentCompletion(finishStop(), silent), true)
  assert.equal(qualifiesAsSilentCompletion(finishAs('tool-calls'), silent), false)
  assert.equal(qualifiesAsSilentCompletion({ type: 'text-delta', index: 0, text: 'x' }, silent), false)
  assert.equal(qualifiesAsSilentCompletion(null, silent), false)
  assert.equal(qualifiesAsSilentCompletion({ type: 'finish' }, silent), false)
})

test('loop outcome: a reasoning-only stop fails instead of completing silently', async () => {
  const raw = loopOutcome([reasoning(), finishStop()])
  assert.equal(raw.kind, 'completed', 'the harness reports this as a completed turn without the guard')
  assert.equal(raw.blocks.length, 1)

  const guarded = loopOutcome(await runGuarded([reasoning(), finishStop()]))
  assert.equal(guarded.kind, 'failed')
  assert.equal(guarded.failure.code, EMPTY_RESPONSE_CODE)
})

test('loop outcome control: a normal text stop still completes', async () => {
  const guarded = loopOutcome(await runGuarded([reasoning(), textDelta(), finishStop()]))
  const raw = loopOutcome([reasoning(), textDelta(), finishStop()])
  assert.deepEqual(guarded, raw)
  assert.equal(guarded.kind, 'completed')
  assert.deepEqual(guarded.blocks.map(block => block.type), ['reasoning', 'text'])
})

test('loop outcome control: a tool-call stop still dispatches its tool', async () => {
  const chunks = [
    reasoning(),
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    toolDelta(),
    { type: 'block-end', index: 2, block: toolBlock },
    finishStop(),
  ]
  const guarded = loopOutcome(await runGuarded(chunks))
  assert.equal(guarded.kind, 'tool-calls')
  assert.equal(guarded.toolCalls.length, 1)
})

test('a mounted guard is inert when configuration disables it', async () => {
  let registered = 0
  const ctx = { on: () => { registered += 1 }, logger: { warn: () => {} } }
  const result = apply(ctx, { enabled: false })
  assert.equal(registered, 0)
  assert.equal(result.enabled, false)
  assert.deepEqual(result.stats(), { rewrites: 0 })
})

test('a mounted guard reports its rewrites to the mounting caller', async () => {
  const listeners = []
  const warnings = []
  const ctx = {
    on: (event, handler, options) => { listeners.push({ event, handler, options }) },
    logger: { warn: message => warnings.push(message) },
  }
  const result = apply(ctx, {})
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'llm/stream')
  assert.equal(listeners[0].options.prepend, true)
  const guarded = listeners[0].handler({ provider: 'p', model: 'm' }, () => streamOf([reasoning(), finishStop()]))
  const out = await collect(guarded)
  assert.equal(out[1].reason.kind, 'error')
  assert.deepEqual(result.stats(), { rewrites: 1 })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /provider "p"/u)
  assert.match(warnings[0], /model "m"/u)
})

test('an unannounced mount still rewrites', async () => {
  const listeners = []
  const warnings = []
  const ctx = {
    on: (event, handler) => { listeners.push({ handler }) },
    logger: { warn: message => warnings.push(message) },
  }
  const result = apply(ctx, { announce: false })
  const out = await collect(listeners[0].handler({ provider: 'p', model: 'm' }, () => streamOf([reasoning(), finishStop()])))
  assert.equal(out[1].reason.kind, 'error')
  assert.deepEqual(warnings, [])
  assert.deepEqual(result.stats(), { rewrites: 1 })
})
