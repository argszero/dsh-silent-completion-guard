/**
 * Mutation harness: every arm is one behaviour the guard claims, broken by a
 * single textual edit, and the suite must fail. The control run comes first,
 * because a suite that fails on unmutated source proves nothing about any arm.
 *
 * A surviving arm is a gap in the suite, not an equivalent mutant: add the
 * missing negative case and re-run until every arm is CAUGHT.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'lib/index.js')
const specs = readdirSync(join(root, 'test'))
  .filter(name => name.endsWith('.spec.mjs'))
  .map(name => join('test', name))

const SILENT = '    return !unreadable && !visibleText && !toolCall && reasoning'

/** Each arm: one claim, one edit, the suite must go red. */
const arms = [
  ['only a plain stop qualifies', "reason.kind === 'stop' && detector.silent", "reason.kind !== 'stop' && detector.silent"],
  ['an unreadable chunk suppresses the rewrite', SILENT, '    return !visibleText && !toolCall && reasoning'],
  ['visible text vetoes the rewrite', SILENT, '    return !unreadable && !toolCall && reasoning'],
  ['a tool call vetoes the rewrite', SILENT, '    return !unreadable && !visibleText && reasoning'],
  ['reasoning is required', SILENT, '    return !unreadable && !visibleText && !toolCall'],
  ['whitespace text is not visible', '        if (hasText(chunk.text)) visibleText = true', '        if (typeof chunk.text === \'string\') visibleText = true'],
  ['a tool-call block start counts', "        if (chunk.blockType === 'tool-call') toolCall = true", "        if (chunk.blockType === 'tool-use') toolCall = true"],
  ['a streamed tool-call delta counts', "      case 'tool-call-delta':\n        toolCall = true\n        return", "      case 'tool-call-delta':\n        return"],
  ['a completed tool-call block counts', '    if (block.type === \'tool-call\') {\n      toolCall = true', '    if (block.type === \'tool-call\') {\n      toolCall = false'],
  ['a reasoning block must carry text', "    if (block.type === 'reasoning' && hasText(block.text)) reasoning = true", "    if (block.type === 'reasoning') reasoning = true"],
  ['the failure carries the canonical code', 'failure: { code: EMPTY_RESPONSE_CODE, message: FAILURE_MESSAGE }', "failure: { code: 'EMPTY', message: FAILURE_MESSAGE }"],
  ['replay state is dropped', '        const replacement = emptyResponseFinish()', '        const replacement = chunk.replayState === undefined ? emptyResponseFinish() : { ...emptyResponseFinish(), replayState: chunk.replayState }'],
  ['a disabled mount registers nothing', '  if (config?.enabled === false) {', '  if (config?.enabled === true) {'],
  ['a disabled mount reports itself disabled', '    return { enabled: false, stats: () => ({ rewrites: 0 }) }', '    return { enabled: true, stats: () => ({ rewrites: 0 }) }'],
  ['reading a chunk cannot abort the stream', '      try {\n        observe(chunk)\n      } catch {\n        unreadable = true\n      }', '      observe(chunk)'],
  ['chunks are forwarded as they arrive', '    for await (const chunk of stream) {', '    for (const chunk of await (async () => { const all = []; for await (const one of stream) all.push(one); return all })()) {'],
  ['the original frame is not also forwarded', '        yield replacement\n        continue', '        yield replacement'],
  ['an announcement happens', '        if (typeof onRewrite === \'function\') {', '        if (false) {'],
  ['a rewrite is counted', '      stats.rewrites += 1', '      stats.rewrites += 0'],
  ['announce can be turned off', '      if (!announce) return', '      if (announce) return'],
  ['only a finish chunk is considered', "  if (chunk.type !== 'finish') return false", "  if (chunk.type === 'finish') return false"],
  ['a finish without a reason is not qualifying', '  if (typeof reason !== \'object\' || reason === null) return false', '  if (reason === null) return false'],
]

function runSuite() {
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=20000', ...specs], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const original = readFileSync(target, 'utf8')
const control = runSuite()
assert.equal(control.code, 0, `control run must pass before any arm is meaningful:\n${control.output.slice(-2500)}`)
console.log('control: suite passes unmutated')

let caught = 0
const survivors = []
for (const [claim, from, to] of arms) {
  const occurrences = original.split(from).length - 1
  assert.equal(occurrences, 1, `arm "${claim}" must anchor exactly one site, found ${occurrences}`)
  writeFileSync(target, original.replace(from, to))
  const result = runSuite()
  writeFileSync(target, original)
  if (result.code === 0) {
    survivors.push(claim)
    console.log(`SURVIVED ${claim}`)
  } else {
    caught += 1
    console.log(`CAUGHT   ${claim}`)
  }
}
writeFileSync(target, original)
console.log(`\n${caught}/${arms.length} arms caught`)
if (survivors.length > 0) {
  console.error(`surviving arms (suite gaps to close): ${survivors.join('; ')}`)
  process.exitCode = 1
}
