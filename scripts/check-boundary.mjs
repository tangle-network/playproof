import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { auditBlindness, describeBlindness } from './attestation-blindness.mjs'

const root = new URL('../', import.meta.url)
const rootPath = root.pathname
const ignored = new Set(['.git', 'dist', 'node_modules', '.pnpm-store'])
/**
 * Research output that must never become part of the package.
 *
 * The rule is that nothing under these paths is TRACKED, not that the paths do
 * not exist. `runs/` is where a study writes its cells, and a study has to be
 * runnable inside a checkout; what must never happen is a run being committed.
 * Asking git is the exact question, so it is the question this asks. When git
 * cannot answer, the check falls back to the stricter "must not exist", so a
 * missing git is never a way to smuggle a directory past this.
 */
const forbiddenRoots = ['.evolve', 'papers', 'runs', 'projects']
const forbiddenProductionText = [
  '@tangle-network/agent-eval',
  '@tangle-network/agent-runtime',
  'TANGLE_API_KEY',
  'streaming-router',
  'runs/playproof',
  'BUDGET_USD',
  'PLAYPROOF_MAX_TOKENS',
  'deepseek-',
  'qwen/',
  'glm-',
]
const productionPrefixes = [
  'adapters/',
  'ale/',
  'desktop/',
  'drivers/',
  'exploration/',
  'gym/',
  'native/',
  'platforms/',
  'pyboy/',
  'pyshared/',
  'retro/',
  'retroarch/',
]
const productionFiles = new Set([
  'artifact.ts',
  'attestation.ts',
  'authoring.ts',
  'calibration.ts',
  'campaign.ts',
  'episode.ts',
  'episode-loop.ts',
  'execute.ts',
  'index.ts',
  'matrix.ts',
  'matrix-run.ts',
  'platform-evidence.ts',
  'platform-execute.ts',
  'platform.ts',
  'runtime.ts',
  'schema.ts',
])

const files = await walk(rootPath)
const violations = []

// Research output must not be TRACKED. See `forbiddenRoots` above for why this
// asks git rather than the filesystem, and what it does when git cannot answer.
let tracked = null
try {
  tracked = execFileSync('git', ['ls-files', '--', ...forbiddenRoots], { cwd: rootPath, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
} catch {
  tracked = null
}
if (tracked === null) {
  for (const path of files) {
    const rel = normalize(relative(rootPath, path))
    if (forbiddenRoots.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) {
      violations.push(`forbidden repository path (git unavailable, so existence is the check): ${rel}`)
    }
  }
} else {
  for (const path of tracked) violations.push(`research output is tracked and would ship: ${path}`)
}

for (const path of files) {
  const rel = normalize(relative(rootPath, path))
  if (forbiddenRoots.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue
  if (!isProduction(rel)) continue
  if (!/\.(?:ts|mts|mjs|js|py|json)$/u.test(rel)) continue
  const text = await readFile(path, 'utf8')
  for (const token of forbiddenProductionText) {
    if (text.includes(token)) violations.push(`${rel} contains forbidden production dependency/text: ${token}`)
  }
}

// The evidence boundary, checked rather than only asserted in prose.
//
// `Observation` is the agent's channel and `Evidence` is the harness's. The
// two rules below are the parts of that boundary a static check can state: the
// function that builds every observation must not read the privileged channel,
// and a driver must not name it at all. Whether an ADAPTER puts privileged
// state into an image caption cannot be decided here, because a caption is
// arbitrary text; `observation.test.mts` covers that case with a game whose
// evidence carries a value the agent channel must never show.
const runtimeText = await readFile(new URL('../runtime.ts', import.meta.url), 'utf8')
const observationStart = runtimeText.indexOf('export function observationOf')
const observationEnd = runtimeText.indexOf('\n}\n', observationStart)
if (observationStart < 0 || observationEnd < 0) {
  violations.push('runtime.ts no longer defines observationOf; the observation boundary check cannot run')
} else if (/evidence/iu.test(runtimeText.slice(observationStart, observationEnd))) {
  violations.push('observationOf reads evidence; the privileged channel must never reach the agent')
}
for (const path of files) {
  const rel = normalize(relative(rootPath, path))
  if (!rel.startsWith('drivers/') || !rel.endsWith('.ts')) continue
  if (/\bevidence\b/iu.test(await readFile(path, 'utf8'))) {
    violations.push(`${rel} names evidence; a driver reads the observation channel only`)
  }
}

// The attestation plane is structurally blind to the strategy it grades.
//
// `attestRun` replays the emitted input log; it never sees the program that
// produced it. That is what makes one number comparable across a planner, a
// hand controller and trained weights. A verifier that loaded the policy would
// still report every run `clean` and every milestone verified, so NO
// RESULT-LEVEL CHECK COULD CATCH IT — only this one, which reads the source.
//
// It is asserted in both directions on purpose. `episode-loop.ts` is the file
// whose job IS to invoke the policy, so the audit must refuse it. An audit that
// cleared both files would be measuring nothing, and would have been "used"
// rather than tested.
const attestationSource = await readFile(new URL('../attestation.ts', import.meta.url), 'utf8')
const attestationVerdict = auditBlindness(attestationSource, 'attestation.ts')
if (!attestationVerdict.blind) violations.push(describeBlindness('attestation.ts', attestationVerdict))

const loopSource = await readFile(new URL('../episode-loop.ts', import.meta.url), 'utf8')
const loopVerdict = auditBlindness(loopSource, 'episode-loop.ts')
if (loopVerdict.blind) {
  violations.push(
    'episode-loop.ts audited blind, but it is the file that DOES invoke the policy'
    + ' — the blindness audit cannot tell the two roles apart, so it is measuring nothing',
  )
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (packageJson.name !== '@tangle-network/playproof') violations.push('package name must be @tangle-network/playproof')
if (packageJson.private === true) violations.push('package must not be private')
if (packageJson.license !== 'Apache-2.0') violations.push('package license must be Apache-2.0')
if (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0) {
  violations.push('framework runtime dependencies must remain empty')
}
if (packageJson.peerDependencies && Object.keys(packageJson.peerDependencies).length > 0) {
  violations.push('framework peer dependencies must remain empty')
}
for (const [key, target] of Object.entries(packageJson.exports ?? {})) {
  const values = typeof target === 'string' ? [target] : Object.values(target)
  for (const value of values) {
    if (typeof value !== 'string' || !value.startsWith('./dist/')) {
      violations.push(`export ${key} escapes dist: ${String(value)}`)
    }
  }
}
for (const entry of packageJson.files ?? []) {
  if (/test|example|\.ts$/iu.test(String(entry))) violations.push(`published files entry is not a release artifact: ${entry}`)
}

if (violations.length > 0) {
  console.error(violations.map((violation) => `- ${violation}`).join('\n'))
  process.exit(1)
}
console.log(`playproof-boundary: ${files.length} files checked; framework is research-harness- and provider-neutral`)

function isProduction(path) {
  return productionFiles.has(path) || productionPrefixes.some((prefix) => path.startsWith(prefix))
}

async function walk(dir) {
  const output = []
  for (const name of await readdir(dir)) {
    if (ignored.has(name)) continue
    const path = join(dir, name)
    const info = await stat(path)
    if (info.isDirectory()) output.push(...await walk(path))
    else if (info.isFile()) output.push(path)
  }
  return output
}

function normalize(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}
