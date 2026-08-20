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
  'desktop/',
  'drivers/',
  'exploration/',
  'native/',
  'platforms/',
  'pyboy/',
]
const productionFiles = new Set([
  'artifact.ts',
  'attestation.ts',
  'authoring.ts',
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
