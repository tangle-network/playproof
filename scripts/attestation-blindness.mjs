/**
 * The attestation plane is structurally blind to the strategy it grades.
 *
 * `attestRun` replays the emitted input log against a verifier-owned game. It
 * never sees the program that produced those inputs, so a planner, a
 * hand-written controller and trained weights are the same shape to it. That
 * property is what makes one number comparable across arms, and until this file
 * existed it was asserted by a doc comment and by nothing else.
 *
 * A doc comment is not a guard. If somebody imported the driver seam into
 * `attestation.ts` and called the policy to "save a replay", every run would
 * still return `verdict: 'clean'` and every milestone would still be listed.
 * The verdict is computed from evidence the verifier recomputes, so a tainted
 * verifier produces output that is indistinguishable from an honest one. NO
 * RESULT-LEVEL CHECK CAN CATCH THIS. Only a structural one can, which is why
 * this audit reads the source rather than the answer.
 *
 * It parses with the TypeScript compiler rather than matching text, so a
 * violation cannot hide behind formatting. The bound on the claim is stated
 * plainly below: the audit sees static syntax, so an indirect call assembled at
 * run time is outside what it can decide.
 *
 * Used twice, in two roles, which is the only way to know it measures anything:
 * `scripts/check-boundary.mjs` requires `attestation.ts` to pass AND requires
 * `episode-loop.ts` to FAIL, because `episode-loop.ts` is the file whose job is
 * to invoke the policy. An audit that cleared both would be measuring nothing.
 */
import ts from 'typescript'

/**
 * Modules the attestation plane may read.
 *
 * An allowlist rather than a list of banned names: a new module in this package
 * is invisible to a denylist, and the failure mode of forgetting to ban one is
 * exactly the failure this audit exists to stop. `runtime` carries the game and
 * the input log; `schema` carries the contract. Neither can reach a policy.
 */
const ALLOWED_IMPORTS = new Set(['./runtime', './schema'])

/** Free functions that execute a string as code. */
const DYNAMIC_EXECUTION = new Set(['eval', 'Function', 'require', 'createRequire'])

/**
 * The AgentDriver seam's only member.
 *
 * A verifier that calls `.act(` is asking a policy what it would do, which is
 * the whole of what it must not do.
 */
const POLICY_INVOCATION = 'act'

/**
 * Audit one TypeScript source for the ways a verifier could come to see policy
 * code.
 *
 * Returns `{ blind, reasons }`. `blind` is true only when `reasons` is empty.
 *
 * Limits of the claim, stated because a guard that oversells itself is worse
 * than none: this reads static syntax. A call reached through a computed member
 * name, a value passed in by a caller, or a child process is not decided here.
 * The audit's job is to make the DIRECT paths impossible to add quietly, and to
 * fail loudly when the file's import surface changes at all.
 */
export function auditBlindness(source, fileName = 'attestation.ts') {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const reasons = []
  const foreignImports = new Set()
  const dynamicImport = new Set()
  const dynamicExecution = new Set()
  let invokesPolicy = false

  const specifierOf = (node) => (ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null)

  const walk = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier === undefined ? null : specifierOf(node)
      // A type-only import still names the module and still records what this
      // plane is allowed to know about. It is held to the same list.
      if (specifier !== null && !ALLOWED_IMPORTS.has(specifier)) foreignImports.add(specifier)
    }
    if (ts.isCallExpression(node)) {
      // `import(...)` parses as a call whose expression is the import keyword.
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0]
        dynamicImport.add(argument !== undefined && ts.isStringLiteral(argument) ? argument.text : '<computed>')
      }
      if (ts.isIdentifier(node.expression) && DYNAMIC_EXECUTION.has(node.expression.text)) {
        dynamicExecution.add(node.expression.text)
      }
      // `driver.act(...)`, `policy.act(...)` — the seam, however it is spelled.
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === POLICY_INVOCATION) {
        invokesPolicy = true
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && DYNAMIC_EXECUTION.has(node.expression.text)) {
      dynamicExecution.add(`new ${node.expression.text}`)
    }
    ts.forEachChild(node, walk)
  }
  walk(tree)

  if (foreignImports.size > 0) {
    reasons.push(
      `imports outside the attestation plane: ${[...foreignImports].sort().map((m) => `"${m}"`).join(', ')}`
      + ` (allowed: ${[...ALLOWED_IMPORTS].sort().map((m) => `"${m}"`).join(', ')})`,
    )
  }
  if (dynamicImport.size > 0) {
    reasons.push(`dynamic import machinery ${[...dynamicImport].sort().map((m) => `import("${m}")`).join(', ')}`)
  }
  if (dynamicExecution.size > 0) {
    reasons.push(`dynamic execution ${[...dynamicExecution].sort().join(', ')}`)
  }
  if (invokesPolicy) {
    reasons.push(`calls .${POLICY_INVOCATION}(), which asks a policy what it would do`)
  }

  return { blind: reasons.length === 0, reasons }
}

/** One line for a report or a failing check. */
export function describeBlindness(fileName, verdict) {
  return verdict.blind
    ? `${fileName}: blind — it reads only the game, the log and the contract`
    : `${fileName}: NOT blind — ${verdict.reasons.join('; ')}`
}
