# dsh-silent-completion-guard

A deepseek-harness plugin that turns a **reasoning-only model stop** into an
empty-response failure, so a turn retries or fails loudly instead of ending
"completed" with nothing to show.

```sh
npm i github:argszero/dsh-silent-completion-guard
```

## The gap it covers

The agent loop settles a step as `completed` whenever the assembled assistant
message carries no tool call. It reads the finish reason only for `max-tokens`.
A provider that ends an attempt after streaming reasoning and nothing else is
therefore indistinguishable from an ordinary stop:

```
assistant/message   one reasoning block, no text, no tool call
turn/end            reason: { kind: 'completed' }
```

Nothing retries, nothing warns, and the user sees a turn that produced no reply.

The harness already has the vocabulary for this failure — `EMPTY_RESPONSE` is a
canonical provider-neutral code and is already in the default retryable set. It
is only raised for a response carrying **no content blocks at all**, and a
reasoning block counts as content, so this shape falls through.

## What the plugin does

It wraps the `llm/stream` response — the frame handed to the loop — and rewrites
**only the terminal chunk** of a qualifying attempt:

```
{ type: 'finish', reason: { kind: 'stop' } }
        ↓
{ type: 'finish', reason: { kind: 'error',
    failure: { code: 'EMPTY_RESPONSE', message: … } } }
```

The loop then takes its existing error branch: retry policy decides whether to
repeat the request, and an exhausted retry budget fails the turn loudly with the
reason named. Every attempt also emits one attributable warning naming the
provider and model.

## When it fires

Only when **all** of these hold for one attempt:

- the terminal finish reason is `stop`;
- the attempt streamed at least one reasoning block;
- the attempt streamed **no visible text** — whitespace-only text does not count,
  matching the harness's own `chunkHasVisibleText` predicate;
- the attempt streamed **no tool call**, streamed or as a completed block.

It never fires on `max-tokens`, `aborted`, `error` or `tool-calls`, and it never
touches an attempt that produced a tool call — a normal turn is passed through
untouched, chunk for chunk.

## Boundaries — what this cannot claim

- **It changes the frame handed to the loop, not durable history.** A rewritten
  attempt is recorded as `assistant/attempt`; the original chunks still stream to
  every observer and are not rewritten in place.
- **It does not touch the provider.** No request is changed and no attempt is
  hidden; a provider that keeps answering with reasoning only keeps being asked,
  until the retry budget is spent and the turn fails visibly.
- **It is not the core fix.** The real fix is a turn-end reason of its own,
  distinct from `completed`, owned by the loop. This plugin makes the existing
  empty-response path reachable from the plugin layer in the meantime.

## Configuration

Mount it through a `dsh.bundle` patch (the package ships `cordis.patch.yml`) or
directly:

```yaml
- insert:
    - id: silent-completion-guard
      name: '@argszero/dsh-silent-completion-guard'
      config:
        enabled: true    # default true; false registers no listener at all
        announce: true   # default true; one warning per rewrite
```

`apply()` returns `{ enabled, stats() }`, where `stats().rewrites` counts the
frames it substituted for the mounting session's diagnostics.

## Verification

- `npm test` — 39 tests: the positive case, the four negatives (`max-tokens`,
  `aborted`, `error`, any tool call), fail-open rules, laziness, back-pressure,
  and two loop-outcome arms that run the **harness's own `BlockAssembler`**:
  without the guard the same chunk list yields `completed`, with it `failed`.
- `npm run smoke` — mounts the published `@deepseek-ai/cordis` runtime plus the
  guard, drives one reasoning-only and one normal attempt through the real
  `llm/stream` waterfall, and confirms disposing the plugin restores the
  unguarded stream.
- `npm run mutation` — 22 arms, control run first, every one caught. A surviving
  arm is treated as a gap in the suite, not an equivalent mutant.

## License

MIT
