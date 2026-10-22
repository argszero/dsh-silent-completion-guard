/**
 * Standalone reading a reviewer can run in one command: mount the published
 * cordis runtime plus the guard, drive one reasoning-only attempt and one normal
 * attempt through the real `llm/stream` waterfall, and confirm that disposing the
 * plugin restores the unguarded stream.
 *
 * Run: node scripts/mount-smoke.mjs
 */
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

import guardPlugin from '../lib/index.js'

const reasoning = () => ({ type: 'reasoning-delta', index: 0, text: 'Thinking it through.' })
const textDelta = () => ({ type: 'text-delta', index: 1, text: 'The answer.' })
const finishStop = () => ({ type: 'finish', reason: { kind: 'stop' } })

class ChunkAdapter extends LlmAdapter {
  constructor(chunks) {
    super()
    this.chunks = chunks
  }

  providerInfo(provider) {
    return { id: provider, name: `Chunk ${provider}` }
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async *stream() {
    for (const chunk of this.chunks) yield chunk
  }
}

const ctx = new Context()
await ctx.plugin(LlmRuntime)
const silent = new ChunkAdapter([reasoning(), finishStop()])
const normal = new ChunkAdapter([reasoning(), textDelta(), finishStop()])
ctx.llm.registerAdapter(['silent'], silent)
ctx.llm.registerAdapter(['normal'], normal)

const warnings = []
const originalWarn = ctx.logger.warn
ctx.logger.warn = (message, ...rest) => {
  warnings.push(String(message))
  return originalWarn.call(ctx.logger, message, ...rest)
}

const fiber = ctx.plugin(guardPlugin, {})
await fiber

const drain = async provider => {
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider,
    model: 'reasoner',
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    tools: [],
  })) chunks.push(chunk)
  return chunks
}

const guardedSilent = await drain('silent')
assert.equal(guardedSilent.at(-1).reason.kind, 'error', 'a reasoning-only stop must fail')
assert.equal(guardedSilent.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
assert.equal(guardedSilent.length, 2, 'no chunk may be added or dropped')

const guardedNormal = await drain('normal')
assert.equal(guardedNormal.at(-1).reason.kind, 'stop', 'a normal stop must be untouched')
assert.equal(guardedNormal.length, 3)

assert.equal(warnings.length, 1, 'one attributable warning per rewrite')
const warning = warnings[0]
assert.match(warning, /reasoning/u)
assert.match(warning, /provider "silent"/u)

await fiber.dispose()
const restored = await drain('silent')
assert.equal(restored.at(-1).reason.kind, 'stop', 'teardown must be observable')

console.log('mount smoke: PASS')
console.log(`  reasoning-only stop -> ${guardedSilent.at(-1).reason.kind} / ${guardedSilent.at(-1).reason.failure.code}`)
console.log(`  normal stop         -> ${guardedNormal.at(-1).reason.kind}`)
console.log(`  attributable warnings: ${warnings.length}`)
console.log(`  teardown observable: ${restored.at(-1).reason.kind === 'stop'}`)
