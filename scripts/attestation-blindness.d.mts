/**
 * Types for the blindness audit.
 *
 * The implementation is `.mjs` because `scripts/check-boundary.mjs` runs under
 * plain node, before anything is built, and must import it without a loader.
 * This declaration is what lets `blindness.test.mts` type-check against it; a
 * signature that drifts from the implementation fails the typecheck.
 */

/** What the audit found, or did not, in one source file. */
export interface BlindnessVerdict {
  /** True only when `reasons` is empty. */
  blind: boolean
  /** Every way this file could reach a policy, one clause each. */
  reasons: string[]
}

export function auditBlindness(source: string, fileName?: string): BlindnessVerdict

export function describeBlindness(fileName: string, verdict: BlindnessVerdict): string
