/**
 * The blindness audit is watched going RED before it is trusted going green.
 *
 * An instrument that has only ever run on the thing it measures has been USED,
 * not tested. Every forbidden construct below is injected into a copy of the
 * real `attestation.ts` and the audit must refuse that copy; then the shipped
 * file must pass; then `episode-loop.ts` — the file whose job is to invoke the
 * policy — must be refused, because an audit that cleared both roles would be
 * measuring nothing.
 *
 * The last case is the one that matters most. It demonstrates, rather than
 * asserting, that no result-level check could have caught a tainted verifier:
 * a run attested by the honest path reports `clean` with its milestones
 * verified, which is exactly what a tainted one would report too.
 */
import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { auditBlindness, describeBlindness } from './scripts/attestation-blindness.mjs'
import { attestRun } from './attestation'
import { logFrom } from './runtime'
import { engineCrawler, engineCrawlerContract, ENGINE_CRAWLER_REFERENCE } from './adapters/engine-crawler'

const clean = await readFile(new URL('./attestation.ts', import.meta.url), 'utf8')

// ---- RED: every way a verifier could come to see the policy ----------------

const injections: { label: string; source: string; expect: RegExp }[] = [
  {
    label: 'dynamic import',
    source: `const loaded = await import('./drivers/cli')\n${clean}`,
    expect: /dynamic import machinery/u,
  },
  {
    label: 'importing the driver seam',
    source: `import { createCliAgentDriver } from './drivers/cli'\n${clean}`,
    expect: /imports outside the attestation plane/u,
  },
  {
    label: 'importing the episode module',
    source: `import type { AgentDriver } from './episode'\n${clean}`,
    expect: /imports outside the attestation plane/u,
  },
  {
    label: 'eval',
    source: `${clean}\nfunction replayFast(src: string) { return eval(src) }\n`,
    expect: /dynamic execution eval/u,
  },
  {
    label: 'the Function constructor',
    source: `${clean}\nfunction compile(src: string) { return new Function(src) }\n`,
    expect: /dynamic execution new Function/u,
  },
  {
    label: 'require',
    source: `${clean}\nconst policy = require('./policy')\n`,
    expect: /dynamic execution require/u,
  },
  {
    label: 'asking the policy what it would do',
    source: `${clean}\nasync function peek(driver: { act: (f: string) => Promise<unknown> }) { return driver.act('') }\n`,
    expect: /calls \.act\(\)/u,
  },
]

for (const injection of injections) {
  const verdict = auditBlindness(injection.source, 'attestation.ts')
  assert.equal(
    verdict.blind,
    false,
    `RED case "${injection.label}" audited blind; the check cannot see this way of reaching a policy`,
  )
  assert.match(
    verdict.reasons.join('; '),
    injection.expect,
    `RED case "${injection.label}" was refused for the wrong reason: ${verdict.reasons.join('; ')}`,
  )
}

// A red case must fail for its OWN reason and not because the injected line
// happened to break something else. Each one above names its expected reason,
// and the shipped file below proves the audit is not simply always red.

// ---- GREEN: the shipped attestation plane is blind -------------------------

const shipped = auditBlindness(clean, 'attestation.ts')
assert.equal(shipped.blind, true, describeBlindness('attestation.ts', shipped))

// ---- The two roles must be distinguishable ---------------------------------

const loop = await readFile(new URL('./episode-loop.ts', import.meta.url), 'utf8')
const loopVerdict = auditBlindness(loop, 'episode-loop.ts')
assert.equal(
  loopVerdict.blind,
  false,
  'episode-loop.ts audited blind, but it is the file that invokes the policy —'
  + ' an audit that clears both roles is measuring nothing',
)
assert.match(
  loopVerdict.reasons.join('; '),
  /calls \.act\(\)/u,
  `episode-loop.ts must be refused for invoking the policy, got: ${loopVerdict.reasons.join('; ')}`,
)

// ---- Why no result-level check could have caught it ------------------------

// The honest verifier's answer on a real run. A verifier that had loaded the
// policy would produce this same shape — `clean`, with milestones verified — so
// nothing downstream of the verdict can tell the two apart. Only the source can.
{
  const contract = engineCrawlerContract()
  const attestation = attestRun(engineCrawler, contract, 0, logFrom(0, [...ENGINE_CRAWLER_REFERENCE]), [])
  assert.equal(attestation.verdict, 'clean', 'the fixture run must verify, or this demonstration proves nothing')
  assert.ok(attestation.verified.length > 0, 'the fixture run must earn milestones')
}

console.log(
  `playproof attestation blindness: ${injections.length} red cases each refused for their own reason,`
  + ' attestation.ts is blind, and episode-loop.ts is correctly refused for invoking the policy',
)
