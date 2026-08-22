import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const root = new URL('../', import.meta.url)
const rootPath = root.pathname
const ignored = new Set(['.git', 'dist', 'node_modules', '.pnpm-store'])
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
  'platform-evidence.ts',
  'platform-execute.ts',
  'platform.ts',
  'runtime.ts',
  'schema.ts',
])

const files = await walk(rootPath)
const violations = []
for (const path of files) {
  const rel = normalize(relative(rootPath, path))
  if (forbiddenRoots.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) {
    violations.push(`forbidden repository path: ${rel}`)
  }
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
