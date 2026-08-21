import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const work = mkdtempSync(join(tmpdir(), 'playproof-pack-'))
try {
  const packageDir = join(work, 'packages')
  mkdirSync(packageDir)
  const packed = spawnSync('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packageDir,
  ], { encoding: 'utf8' })
  if (packed.status !== 0) fail(`npm pack failed:\n${packed.stderr}`)
  const report = JSON.parse(packed.stdout)
  if (!Array.isArray(report) || report.length !== 1 || typeof report[0]?.filename !== 'string') {
    fail(`unexpected npm pack report: ${packed.stdout}`)
  }
  const tarball = join(packageDir, report[0].filename)
  if (!existsSync(tarball)) fail(`packed tarball missing: ${tarball}`)

  const list = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  if (list.status !== 0) fail(`tar listing failed:\n${list.stderr}`)
  const entries = list.stdout.trim().split('\n').filter(Boolean)
  const required = [
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/SECURITY.md',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/drivers/cli.js',
    'package/dist/drivers/openai-compatible.js',
    'package/dist/adapters/native-desktop.js',
    'package/dist/adapters/native-2048.js',
    'package/dist/adapters/gymnasium.js',
    'package/dist/adapters/pyboy-generic.js',
    'package/dist/adapters/stable-retro.js',
    'package/dist/adapters/retroarch.js',
    'package/dist/adapters/ale.js',
    'package/dist/platforms/steam.js',
    'package/dist/platforms/xbox.js',
    'package/dist/desktop/worker.py',
    'package/dist/gym/worker.py',
    'package/dist/gym/reference-cartpole.json',
    'package/dist/native/worker.py',
    'package/dist/pyboy/worker.py',
    'package/dist/retro/worker.py',
    'package/dist/retro/reference-airstriker.json',
    'package/dist/ale/worker.py',
    'package/dist/ale/reference-breakout.json',
    'package/dist/retroarch/worker.py',
  ]
  for (const path of required) if (!entries.includes(path)) fail(`packed artifact missing ${path}`)
  for (const path of entries) {
    if (/\.(?:test|spec)\.(?:m?[jt]s|py)$/u.test(path)) fail(`packed artifact leaked test ${path}`)
    if (path.startsWith('package/examples/')) fail(`packed artifact leaked example ${path}`)
    if (/^package\/(?:\.evolve|papers|projects|runs)\//u.test(path)) fail(`packed artifact leaked lab path ${path}`)
    if (/^package\/(?!dist\/).*\.(?:ts|mts)$/u.test(path)) fail(`packed artifact leaked source ${path}`)
  }

  const extractDir = join(work, 'extract')
  mkdirSync(extractDir)
  const extract = spawnSync('tar', ['-xzf', tarball, '-C', extractDir], { encoding: 'utf8' })
  if (extract.status !== 0) fail(`tar extraction failed:\n${extract.stderr}`)
  const manifest = JSON.parse(readFileSync(join(extractDir, 'package', 'package.json'), 'utf8'))
  // The declared version is the release identity; a hardcoded copy here only
  // goes stale one bump later.
  const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (manifest.name !== '@tangle-network/playproof' || manifest.version !== declared.version) {
    fail(`packed identity mismatch: ${manifest.name}@${manifest.version}`)
  }
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
    fail('packed framework must not have runtime dependencies')
  }

  const consumer = join(work, 'consumer')
  const installed = join(consumer, 'node_modules', '@tangle-network', 'playproof')
  mkdirSync(dirname(installed), { recursive: true })
  cpSync(join(extractDir, 'package'), installed, { recursive: true })
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: 'module', private: true }))
  writeFileSync(join(consumer, 'verify.mjs'), `
    import * as core from '@tangle-network/playproof'
    import * as drivers from '@tangle-network/playproof/drivers'
    import { createCliAgentDriver } from '@tangle-network/playproof/drivers/cli'
    import { createOpenAICompatibleDriver } from '@tangle-network/playproof/drivers/openai-compatible'
    import { makeNativeDesktopAdapter } from '@tangle-network/playproof/adapters/native-desktop'
    import { makeNative2048 } from '@tangle-network/playproof/adapters/native-2048'
    import { makeGymnasium } from '@tangle-network/playproof/adapters/gymnasium'
    import { makePyBoyGeneric } from '@tangle-network/playproof/adapters/pyboy-generic'
    import { makeStableRetro } from '@tangle-network/playproof/adapters/stable-retro'
    import { makeRetroArch, channelsFromDiscovery } from '@tangle-network/playproof/adapters/retroarch'
    import { makeAle } from '@tangle-network/playproof/adapters/ale'
    import { SteamWebApiEvidenceSource } from '@tangle-network/playproof/platforms/steam'
    import { XboxRestEvidenceSource } from '@tangle-network/playproof/platforms/xbox'
    const required = [
      core.executeBenchmark,
      core.playEpisode,
      drivers.renderCliAgentPrompt,
      createCliAgentDriver,
      createOpenAICompatibleDriver,
      makeNativeDesktopAdapter,
      makeNative2048,
      makeGymnasium,
      makePyBoyGeneric,
      makeStableRetro,
      makeRetroArch,
      channelsFromDiscovery,
      makeAle,
      SteamWebApiEvidenceSource,
      XboxRestEvidenceSource,
    ]
    if (required.some((value) => typeof value !== 'function')) throw new Error('packed export missing')
    console.log('packed Playproof imports verified')
  `)
  const verify = spawnSync(process.execPath, [join(consumer, 'verify.mjs')], {
    cwd: consumer,
    encoding: 'utf8',
  })
  if (verify.status !== 0) fail(`clean consumer import failed:\n${verify.stderr}`)
  process.stdout.write(verify.stdout)
  console.log(`playproof-package: ${entries.length} packed entries verified`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

function fail(message) {
  throw new Error(message)
}
