/**
 * The install face — what a unit test of the source cannot see.
 *
 * `dsh plugin add` exits 0 and the entry appears in the composed config even when
 * the installed module cannot be imported at all: a profile resolves the plugin's
 * own `dependencies`, and the harness tree lives under the `dsh` CLI, out of reach
 * of a module loaded from a profile. These arms read the BUILD, and pin each
 * carried primitive to the real module — resolvable here, and nowhere in a profile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EMPTY_RESPONSE_CODE, chunkHasVisibleText } from '@deepseek-ai/dsh-llm'

/** A value import of the harness-only peer, which a profile cannot resolve. */
const LLM_PEER_VALUE_IMPORT = /(?:^|\n)\s*import\s[^;\n]*?from\s*['"]@deepseek-ai\/dsh-llm['"]/

test('the built entry imports no harness peer a profile cannot resolve', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, LLM_PEER_VALUE_IMPORT,
    'a value import of dsh-llm throws ERR_MODULE_NOT_FOUND when the installed copy is loaded from a profile')
})

test('the carried empty-response code is the harness\'s own', () => {
  assert.equal(EMPTY_RESPONSE_CODE, 'EMPTY_RESPONSE')
})

test('the carried chunk predicate agrees with the harness on every chunk shape', async () => {
  const { chunkHasVisibleText: carried, EMPTY_RESPONSE_CODE: carriedCode } =
    (await import('../lib/index.js')).carriedLlmPrimitives
  assert.equal(carriedCode, EMPTY_RESPONSE_CODE, 'the carried failure code is the harness\'s own')
  const chunks = [
    { type: 'text-delta', text: 'a' },
    { type: 'text-delta', text: '   ' },
    { type: 'text-delta', text: '' },
    { type: 'text-delta', text: '\n' },
    { type: 'block-end', block: { type: 'text', text: 'done' } },
    { type: 'block-end', block: { type: 'text', text: '\n\t ' } },
    { type: 'block-end', block: { type: 'reasoning', text: 'thinking' } },
    { type: 'block-end', block: { type: 'tool-call', id: 'x' } },
    { type: 'block-start', block: { type: 'text' } },
  ]
  for (const chunk of chunks) {
    assert.equal(carried(chunk), chunkHasVisibleText(chunk), `chunk ${JSON.stringify(chunk).slice(0, 60)}`)
  }
})
