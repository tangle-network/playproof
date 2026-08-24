import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// A v* tag may publish only when the `ci` workflow is green on the exact commit
// the tag points at. The decision is a pure function of what the GitHub Actions
// API reports, so `release-gate.test.mts` can state every refusal without a tag
// push. `main` is the impure half: it reads the API, waits while the answer is
// still forming, and turns the verdict into an exit code.
//
// The gate answers "did CI look at this commit and pass", not "is CI failing".
// Every unknown is a refusal: no run, an unreadable API, a run still going past
// its window, a conclusion outside the single allowed value, a run that is green
// because a required job never existed.

export interface WorkflowRun {
  readonly id: number
  readonly headSha: string
  readonly event: string
  readonly status: string
  readonly conclusion: string | null
  readonly url: string
}

export interface JobStep {
  readonly name: string
  readonly conclusion: string | null
}

export interface WorkflowJob {
  readonly runId: number
  readonly name: string
  readonly conclusion: string | null
  readonly steps: readonly JobStep[]
}

// A job the release depends on, and optionally the step inside it that must have
// run and passed. The step matters where a job can conclude success without its
// gate running: `real-retroarch` marks its asset install `continue-on-error` and
// makes the adapter gate conditional, so a green job there is not by itself
// evidence that the emulator was driven.
export interface RequiredJob {
  readonly job: string
  readonly step?: string
}

export type Verdict = 'allow' | 'wait' | 'refuse'

export interface GateDecision {
  readonly verdict: Verdict
  readonly overridden: boolean
  readonly reasons: readonly string[]
}

export interface GateInput {
  readonly sha: string
  readonly runs: readonly WorkflowRun[]
  readonly jobs: readonly WorkflowJob[]
  readonly required: readonly RequiredJob[]
  readonly elapsedMs: number
  readonly appearMs: number
  readonly waitMs: number
  readonly overrideReason: string
}

// The six jobs `ci.yml` declares, and the step in each that does the work. The
// list is the release contract and is deliberately committed here rather than
// read from the tagged `ci.yml`: a workflow file edited to drop a job would
// otherwise agree with itself. `release-gate.test.mts` fails when a name here
// stops matching the workflow.
export const requiredCiJobs: readonly RequiredJob[] = [
  { job: 'framework, drivers, desktop, Steam, Xbox, package', step: 'Full release-equivalent gate' },
  { job: 'real emulator regression on a free ROM', step: 'Replay the reference run on the real emulator' },
  { job: 'Gymnasium environment adapter on real environments', step: 'Adapter gate' },
  { job: 'stable-retro multi-console adapter on a real emulator', step: 'Adapter gate' },
  { job: 'ALE Atari adapter on a real emulator', step: 'Adapter gate' },
  { job: 'RetroArch black-box host adapter on a real emulator', step: 'Adapter gate' },
]

// `success` is the only conclusion that releases. `cancelled`, `timed_out`,
// `neutral`, `skipped`, `stale`, `action_required` and a null conclusion all
// refuse, because each of them means the tests did not pass on this commit.
const passingConclusion = 'success'

// An override is a human taking responsibility in writing. A single character
// would make it the easy path, so the reason must say something.
export const minimumOverrideReason = 12

export function decideRelease(input: GateInput): GateDecision {
  const observed = readCi(input)
  const reason = input.overrideReason.trim()
  if (observed.verdict === 'allow' || reason.length === 0) return observed
  if (reason.length < minimumOverrideReason) {
    return refuse([
      ...observed.reasons,
      `the override reason must state why in at least ${minimumOverrideReason} characters; it is ${reason.length}`,
    ])
  }
  return {
    verdict: 'allow',
    overridden: true,
    reasons: [...observed.reasons, `overridden by a named human decision: ${reason}`],
  }
}

function readCi({ sha, runs, jobs, required, elapsedMs, appearMs, waitMs }: GateInput): GateDecision {
  // The API was asked to filter by head_sha; the filter is checked here rather
  // than trusted, because the whole gate rests on which commit was tested.
  const own = runs.filter((run) => run.headSha === sha)
  if (own.length === 0) {
    if (elapsedMs < appearMs) return wait([`no ci run has appeared for ${sha} yet`])
    return refuse([`the ci workflow has no run on ${sha}; a commit CI never looked at cannot publish`])
  }

  const unfinished = own.filter((run) => run.status !== 'completed')
  if (unfinished.length > 0) {
    const named = unfinished.map((run) => `run ${run.id} is ${run.status}`)
    if (elapsedMs < waitMs) return wait(named)
    return refuse([...named, `no verdict after ${Math.round(waitMs / 60_000)} minutes; an unfinished run is not a pass`])
  }

  const red = own.filter((run) => run.conclusion !== passingConclusion)
  if (red.length > 0) {
    return refuse(red.map((run) => `ci run ${run.id} (${run.event}) concluded ${run.conclusion ?? 'nothing'}: ${run.url}`))
  }

  const ids = new Set(own.map((run) => run.id))
  const observed = jobs.filter((job) => ids.has(job.runId))
  const faults: string[] = []
  for (const need of required) {
    const named = observed.filter((job) => job.name === need.job)
    if (named.length === 0) {
      faults.push(`ci passed on ${sha} without running the required job "${need.job}"`)
      continue
    }
    const green = named.filter((job) => job.conclusion === passingConclusion)
    if (green.length === 0) {
      faults.push(`required job "${need.job}" concluded ${named.map((job) => job.conclusion ?? 'nothing').join(', ')}`)
      continue
    }
    if (need.step === undefined) continue
    const step = need.step
    const ran = green.some((job) => job.steps.some((entry) => entry.name === step && entry.conclusion === passingConclusion))
    if (!ran) faults.push(`required job "${need.job}" is green but its "${step}" step did not run and pass`)
  }
  if (faults.length > 0) return refuse(faults)

  const events = [...new Set(own.map((run) => run.event))].join(', ')
  return {
    verdict: 'allow',
    overridden: false,
    reasons: [`ci is green on ${sha}: ${own.length} run(s) (${events}), all ${required.length} required jobs passed`],
  }
}

function wait(reasons: readonly string[]): GateDecision {
  return { verdict: 'wait', overridden: false, reasons }
}

function refuse(reasons: readonly string[]): GateDecision {
  return { verdict: 'refuse', overridden: false, reasons }
}

export interface GithubApi {
  readonly baseUrl: string
  readonly repository: string
  readonly token: string
}

export async function listCiRuns(api: GithubApi, workflowFile: string, sha: string): Promise<WorkflowRun[]> {
  const path = `/repos/${api.repository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`
  const body = await request(api, path)
  const runs = readArray(body, 'workflow_runs', path)
  return runs.map((entry) => {
    const run = readRecord(entry, path)
    return {
      id: Number(run.id),
      headSha: String(run.head_sha),
      event: String(run.event),
      status: String(run.status),
      conclusion: run.conclusion === null || run.conclusion === undefined ? null : String(run.conclusion),
      url: String(run.html_url ?? ''),
    }
  })
}

export async function listRunJobs(api: GithubApi, runId: number): Promise<WorkflowJob[]> {
  const path = `/repos/${api.repository}/actions/runs/${runId}/jobs?per_page=100`
  const body = await request(api, path)
  const jobs = readArray(body, 'jobs', path)
  return jobs.map((entry) => {
    const job = readRecord(entry, path)
    const steps = Array.isArray(job.steps) ? job.steps : []
    return {
      runId,
      name: String(job.name),
      conclusion: job.conclusion === null || job.conclusion === undefined ? null : String(job.conclusion),
      steps: steps.map((raw) => {
        const step = readRecord(raw, path)
        return {
          name: String(step.name),
          conclusion: step.conclusion === null || step.conclusion === undefined ? null : String(step.conclusion),
        }
      }),
    }
  })
}

async function request(api: GithubApi, path: string): Promise<unknown> {
  const response = await fetch(`${api.baseUrl}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${api.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'playproof-release-gate',
    },
  })
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status} ${response.statusText}`)
  return await response.json()
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`GET ${path} returned an entry that is not an object`)
  return value as Record<string, unknown>
}

function readArray(body: unknown, key: string, path: string): unknown[] {
  const record = readRecord(body, path)
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`GET ${path} returned no ${key} array`)
  return value
}

export interface GateSettings {
  readonly api: GithubApi
  readonly workflowFile: string
  readonly sha: string
  readonly tag: string
  readonly appearMs: number
  readonly waitMs: number
  readonly pollMs: number
  readonly overrideReason: string
}

export function readSettings(env: NodeJS.ProcessEnv): GateSettings {
  return {
    api: {
      baseUrl: env.GITHUB_API_URL && env.GITHUB_API_URL.length > 0 ? env.GITHUB_API_URL : 'https://api.github.com',
      repository: required(env, 'GITHUB_REPOSITORY'),
      token: required(env, 'GITHUB_TOKEN'),
    },
    workflowFile: env.CI_WORKFLOW_FILE && env.CI_WORKFLOW_FILE.length > 0 ? env.CI_WORKFLOW_FILE : 'ci.yml',
    sha: required(env, 'RELEASE_SHA'),
    tag: env.RELEASE_TAG ?? '(no tag given)',
    appearMs: minutes(env.CI_APPEAR_MINUTES, 10),
    waitMs: minutes(env.CI_WAIT_MINUTES, 60),
    pollMs: 30_000,
    overrideReason: env.CI_OVERRIDE_REASON ?? '',
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set`)
  return value
}

function minutes(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback * 60_000
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`expected a number of minutes, got '${value}'`)
  return parsed * 60_000
}

async function main(): Promise<never> {
  const settings = readSettings(process.env)
  const started = Date.now()
  const deadline = Math.max(settings.appearMs, settings.waitMs)
  let unreadable = 0
  let previous = ''
  for (;;) {
    const elapsedMs = Date.now() - started
    let decision: GateDecision
    try {
      const runs = await listCiRuns(settings.api, settings.workflowFile, settings.sha)
      const own = runs.filter((run) => run.headSha === settings.sha)
      const complete = own.filter((run) => run.status === 'completed')
      const jobs = (await Promise.all(complete.map((run) => listRunJobs(settings.api, run.id)))).flat()
      unreadable = 0
      decision = decideRelease({
        sha: settings.sha,
        runs,
        jobs,
        required: requiredCiJobs,
        elapsedMs,
        appearMs: settings.appearMs,
        waitMs: settings.waitMs,
        overrideReason: settings.overrideReason,
      })
    } catch (error) {
      // An instrument that cannot be read reports nothing, and nothing is a
      // refusal. A short burst of API failures is retried; a persistent one
      // ends the release.
      unreadable += 1
      const message = error instanceof Error ? error.message : String(error)
      console.log(`could not read the ci result (${unreadable}): ${message}`)
      decision =
        unreadable < 3 && elapsedMs < deadline
          ? wait([`the Actions API is unreadable: ${message}`])
          : refuse([`the ci result for ${settings.sha} could not be read: ${message}`])
    }

    if (decision.verdict === 'wait') {
      const state = decision.reasons.join('; ')
      if (state !== previous) {
        console.log(`waiting: ${state}`)
        previous = state
      }
      await new Promise((resolve) => setTimeout(resolve, settings.pollMs))
      continue
    }

    report(settings, decision)
    process.exit(decision.verdict === 'allow' ? 0 : 1)
  }
}

function report(settings: GateSettings, decision: GateDecision): void {
  const headline =
    decision.verdict === 'allow'
      ? decision.overridden
        ? `${settings.tag} publishes on a human override, not on a green ci`
        : `${settings.tag} may publish`
      : `${settings.tag} must not publish`
  const lines = [`${headline} (commit ${settings.sha})`, ...decision.reasons.map((reason) => `- ${reason}`)]
  console.log(lines.join('\n'))
  if (decision.verdict === 'refuse') console.log(`::error::${headline}: ${decision.reasons.join('; ')}`)
  if (decision.overridden) console.log(`::warning::${headline}`)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary === undefined || summary.length === 0) return
  const body = [
    `## Release gate: ${headline}`,
    '',
    `Commit \`${settings.sha}\`, workflow \`${settings.workflowFile}\`.`,
    '',
    ...decision.reasons.map((reason) => `- ${reason}`),
    '',
  ].join('\n')
  appendFileSync(summary, body)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main()
}
