import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  decideRelease,
  minimumOverrideReason,
  readSettings,
  requiredCiJobs,
  type GateInput,
  type RequiredJob,
  type WorkflowJob,
  type WorkflowRun,
} from './release-gate.mts'

const sha = '5fb905db605adf7e95531a4be548899a343b85a1'
const other = '9ac5adde6d6c1db1db30faa6e4d3931751858fc2'
const minute = 60_000

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 32762965264,
    headSha: sha,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/tangle-network/playproof/actions/runs/32762965264',
    ...overrides,
  }
}

// Every required job green, with the step that does the work green inside it.
function greenJobs(runId = 32762965264, required: readonly RequiredJob[] = requiredCiJobs): WorkflowJob[] {
  return required.map((need) => ({
    runId,
    name: need.job,
    conclusion: 'success',
    steps: [
      { name: 'Set up job', conclusion: 'success' },
      ...(need.step === undefined ? [] : [{ name: need.step, conclusion: 'success' }]),
      { name: 'Complete job', conclusion: 'success' },
    ],
  }))
}

function gate(overrides: Partial<GateInput> = {}): GateInput {
  return {
    sha,
    runs: [run()],
    jobs: greenJobs(),
    required: requiredCiJobs,
    elapsedMs: 0,
    appearMs: 10 * minute,
    waitMs: 60 * minute,
    overrideReason: '',
    ...overrides,
  }
}

// Case 1 of 3 in the brief: ci succeeded on the tagged commit.
{
  const decision = decideRelease(gate())
  assert.equal(decision.verdict, 'allow')
  assert.equal(decision.overridden, false)
  assert.match(decision.reasons.join('\n'), /ci is green/u)
}

// Case 2 of 3: ci failed on the tagged commit. This is the 0.8.0 shape, with the
// RetroArch job red and the other five green.
{
  const decision = decideRelease(gate({ runs: [run({ conclusion: 'failure' })] }))
  assert.equal(decision.verdict, 'refuse')
  assert.match(decision.reasons.join('\n'), /concluded failure/u)
}
{
  const jobs = greenJobs().map((job) =>
    job.name.startsWith('RetroArch') ? { ...job, conclusion: 'failure' } : job,
  )
  const decision = decideRelease(gate({ jobs }))
  assert.equal(decision.verdict, 'refuse')
  assert.match(decision.reasons.join('\n'), /"RetroArch black-box host adapter on a real emulator" concluded failure/u)
}

// Case 3 of 3, and the dangerous one: ci has no result at all for this commit.
// Inside the appearance window the gate waits; past it, the absence refuses.
{
  const waiting = decideRelease(gate({ runs: [], elapsedMs: 4 * minute }))
  assert.equal(waiting.verdict, 'wait')
  const refused = decideRelease(gate({ runs: [], elapsedMs: 10 * minute }))
  assert.equal(refused.verdict, 'refuse')
  assert.match(refused.reasons.join('\n'), /never looked at cannot publish/u)
}

// A run that exists for a different commit is not a result for this one; the
// head_sha filter the API was asked for is checked again here.
{
  const decision = decideRelease(gate({ runs: [run({ headSha: other })], elapsedMs: 10 * minute }))
  assert.equal(decision.verdict, 'refuse')
  assert.match(decision.reasons.join('\n'), /no run on/u)
}

// A run still going is not a pass. It is worth waiting for, and worth refusing
// once the window closes.
{
  for (const status of ['queued', 'in_progress', 'waiting', 'pending']) {
    const unfinished = [run({ status, conclusion: null })]
    assert.equal(decideRelease(gate({ runs: unfinished, elapsedMs: 30 * minute })).verdict, 'wait')
    const refused = decideRelease(gate({ runs: unfinished, elapsedMs: 60 * minute }))
    assert.equal(refused.verdict, 'refuse')
    assert.match(refused.reasons.join('\n'), /an unfinished run is not a pass/u)
  }
}

// `success` is an allowlist, not "anything that is not failure".
{
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', null]) {
    const decision = decideRelease(gate({ runs: [run({ conclusion })] }))
    assert.equal(decision.verdict, 'refuse', `conclusion ${String(conclusion)} must refuse`)
  }
}

// Two runs on the same commit, one green and one red, refuse. Clearing a flake
// means re-running the red run, not dispatching a second one beside it.
{
  const decision = decideRelease(gate({ runs: [run(), run({ id: 1, conclusion: 'failure' })] }))
  assert.equal(decision.verdict, 'refuse')
  assert.match(decision.reasons.join('\n'), /run 1 \(push\) concluded failure/u)
}

// A green run that never ran a required job is "not looking", not "not failing".
{
  const jobs = greenJobs().filter((job) => !job.name.startsWith('ALE'))
  const decision = decideRelease(gate({ jobs }))
  assert.equal(decision.verdict, 'refuse')
  assert.match(decision.reasons.join('\n'), /without running the required job "ALE Atari adapter on a real emulator"/u)
}
{
  const decision = decideRelease(gate({ jobs: [] }))
  assert.equal(decision.verdict, 'refuse')
  assert.equal(decision.reasons.length, requiredCiJobs.length)
}

// A required job that was skipped is not a required job that passed.
{
  const jobs = greenJobs().map((job) => (job.name.startsWith('Gymnasium') ? { ...job, conclusion: 'skipped' } : job))
  const decision = decideRelease(gate({ jobs }))
  assert.equal(decision.verdict, 'refuse')
  assert.match(decision.reasons.join('\n'), /"Gymnasium environment adapter on real environments" concluded skipped/u)
}

// The measured shape of the RetroArch job: its asset install is
// `continue-on-error` and its adapter gate is conditional, so the job can
// conclude success with the emulator never driven. A green job alone does not
// release; the step inside it must have run.
{
  const jobs = greenJobs().map((job) =>
    job.name.startsWith('RetroArch')
      ? {
          ...job,
          steps: [
            { name: 'Install RetroArch, the gambatte core, and the free ROM', conclusion: 'failure' },
            { name: 'Adapter gate', conclusion: 'skipped' },
            { name: 'Report an unusable pool', conclusion: 'success' },
          ],
        }
      : job,
  )
  const decision = decideRelease(gate({ jobs }))
  assert.equal(decision.verdict, 'refuse')
  assert.match(decision.reasons.join('\n'), /is green but its "Adapter gate" step did not run and pass/u)
}

// Jobs belonging to a run on another commit do not satisfy this commit.
{
  const decision = decideRelease(gate({ jobs: greenJobs(999) }))
  assert.equal(decision.verdict, 'refuse')
  assert.equal(decision.reasons.length, requiredCiJobs.length)
}

// A job added to ci.yml beyond the required set does not block a release.
{
  const jobs = [...greenJobs(), { runId: 32762965264, name: 'a new job', conclusion: 'success', steps: [] }]
  assert.equal(decideRelease(gate({ jobs })).verdict, 'allow')
}

// workflow_dispatch is subject to the same reading, and the override is a named
// human decision rather than the default path.
{
  const red = gate({ runs: [run({ conclusion: 'failure' })] })
  assert.equal(decideRelease({ ...red, overrideReason: '' }).verdict, 'refuse')
  assert.equal(decideRelease({ ...red, overrideReason: '   ' }).verdict, 'refuse')

  const short = decideRelease({ ...red, overrideReason: 'flake' })
  assert.equal(short.verdict, 'refuse')
  assert.match(short.reasons.join('\n'), /at least 12 characters; it is 5/u)
  assert.ok('flake'.length < minimumOverrideReason)

  const named = decideRelease({ ...red, overrideReason: 'RetroArch replay flake, re-ran green on main' })
  assert.equal(named.verdict, 'allow')
  assert.equal(named.overridden, true)
  assert.match(named.reasons.join('\n'), /concluded failure/u)
  assert.match(named.reasons.join('\n'), /overridden by a named human decision/u)
}

// The override covers absence and an unfinished run too, and always says so.
{
  const absent = decideRelease(gate({ runs: [], elapsedMs: 10 * minute, overrideReason: 'ci pool offline, tested locally' }))
  assert.equal(absent.verdict, 'allow')
  assert.equal(absent.overridden, true)
  const unfinished = decideRelease(gate({ runs: [run({ status: 'in_progress', conclusion: null })], overrideReason: 'ci pool offline, tested locally' }))
  assert.equal(unfinished.verdict, 'allow')
  assert.equal(unfinished.overridden, true)
}

// A green ci is never reported as an override.
{
  const decision = decideRelease(gate({ overrideReason: 'not needed, ci is green' }))
  assert.equal(decision.verdict, 'allow')
  assert.equal(decision.overridden, false)
}

// The required list is the release contract; it fails loudly when ci.yml moves
// underneath it.
{
  const workflow = readFileSync(new URL('./.github/workflows/ci.yml', import.meta.url), 'utf8')
  for (const need of requiredCiJobs) {
    assert.ok(workflow.includes(`name: ${need.job}`), `ci.yml no longer declares the job "${need.job}"`)
    if (need.step !== undefined) {
      assert.ok(workflow.includes(`name: ${need.step}`), `ci.yml no longer declares the step "${need.step}"`)
    }
  }
}

// Settings fail closed: no token, no repository, no commit, no gate.
{
  const complete = {
    GITHUB_REPOSITORY: 'tangle-network/playproof',
    GITHUB_TOKEN: 'token',
    RELEASE_SHA: sha,
    RELEASE_TAG: 'v0.8.0',
  }
  const settings = readSettings(complete)
  assert.equal(settings.api.baseUrl, 'https://api.github.com')
  assert.equal(settings.workflowFile, 'ci.yml')
  assert.equal(settings.appearMs, 10 * minute)
  assert.equal(settings.waitMs, 60 * minute)
  assert.equal(settings.overrideReason, '')
  for (const name of ['GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'RELEASE_SHA']) {
    const partial = { ...complete, [name]: '' }
    assert.throws(() => readSettings(partial), new RegExp(`${name} is not set`, 'u'))
  }
  assert.throws(() => readSettings({ ...complete, CI_WAIT_MINUTES: 'soon' }), /expected a number of minutes/u)
  assert.equal(readSettings({ ...complete, CI_WAIT_MINUTES: '5' }).waitMs, 5 * minute)
}

console.log(`playproof-release-gate: ${requiredCiJobs.length} required jobs; absent, unfinished and red ci all refuse`)
