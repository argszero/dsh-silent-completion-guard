/** Mount suite: the guard on the real cordis runtime and the real LLM waterfall. */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

import guardPlugin from '../lib/index.js'

const reasoning = () => ({ type: 'reasoning-delta', index: 0, text: 'Thinking it through.' })
const textDelta = () => ({ type: 'text-delta', index: 1, text: 'The answer.' })
const finishStop = () => ({ type: 'finish', reason: { kind: 'stop' } })

/** An adapter that replays one fixed chunk list and records each request it receives. */
class ChunkAdapter extends LlmAdapter {
  constructor(chunks) {
    super()
    this.chunks = chunks
    this.requests = 0
  }

  providerInfo(provider) {
    return { id: provider, name: `Chunk ${provider}` }
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async *stream() {
    this.requests += 1
    for (const chunk of this.chunks) yield chunk
  }
}

function request() {
  return {
    provider: 'guarded',
    model: 'reasoner',
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    tools: [],
  }
}

async function drain(ctx) {
  const chunks = []
  for await (const chunk of ctx.llm.stream(request())) chunks.push(chunk)
  return chunks
}

/** Mount the runtime and the guard together; returns the pieces a test needs. */
async function mount(chunks, config = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ChunkAdapter(chunks)
  ctx.llm.registerAdapter(['guarded'], adapter)
  const warnings = []
  const fiber = ctx.plugin(guardPlugin, config, `${guardPlugin.name}-test`)
  await fiber
  return { ctx, adapter, fiber, warnings }
}

test('mounts on a real context and hands the loop an empty-response finish', async () => {
  const { ctx } = await mount([reasoning(), finishStop()])
  const chunks = await drain(ctx)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[1].reason.kind, 'error')
  assert.equal(chunks[1].reason.failure.code, 'EMPTY_RESPONSE')
})

test('control: the same mount leaves a normal text stop untouched', async () => {
  const { ctx } = await mount([reasoning(), textDelta(), finishStop()])
  const chunks = await drain(ctx)
  assert.equal(chunks.length, 3)
  assert.equal(chunks[2].reason.kind, 'stop')
})

test('teardown is observable: after dispose the same route completes silently again', async () => {
  const { ctx, fiber } = await mount([reasoning(), finishStop()])
  assert.equal((await drain(ctx))[1].reason.kind, 'error')
  await fiber.dispose()
  const after = await drain(ctx)
  assert.equal(after[1].reason.kind, 'stop', 'the guard must be gone, not merely idle')
})

test('waits for the llm service instead of loading inert', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(guardPlugin, {})
  await fiber
  const before = await ctx.waterfall(ctx, 'llm/stream', request(), () => (async function* () {
    yield reasoning()
    yield finishStop()
  })())
  const collected = []
  for await (const chunk of before) collected.push(chunk)
  assert.equal(collected[1].reason.kind, 'stop', 'with no llm service the guard cannot be active')

  await ctx.plugin(LlmRuntime)
  const adapter = new ChunkAdapter([reasoning(), finishStop()])
  ctx.llm.registerAdapter(['guarded'], adapter)
  const after = await drain(ctx)
  assert.equal(after[1].reason.kind, 'error', 'once the service arrives the guard activates')
})

test('a disabled mount on a real context changes nothing', async () => {
  const { ctx } = await mount([reasoning(), finishStop()], { enabled: false })
  const chunks = await drain(ctx)
  assert.equal(chunks[1].reason.kind, 'stop')
})
