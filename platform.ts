import type { Game } from './runtime'
import type { MilestoneContract } from './schema'

/**
 * Verification modes are deliberately not collapsed into one "supported"
 * boolean. They describe who can recreate or vouch for progression.
 */
export type VerificationMode =
  | 'replay'             // verifier owns deterministic execution and replays inputs
  | 'trusted-recorder'   // isolated recorder signs evidence from a non-replayable run
  | 'platform-attested'  // recorder captures normalized platform API/SDK receipts

export interface PlatformCapabilities {
  deterministicReplay: boolean
  checkpoints: boolean
  rawState: boolean
  persistedState: boolean
  eventStream: boolean
  frameCapture: boolean
  signedRecorder: boolean
  platformReceipts: boolean
}

export interface PlatformDescriptor {
  id: string
  family: 'emulator' | 'native-process' | 'platform-service'
  verificationMode: VerificationMode
  capabilities: PlatformCapabilities
}

export interface BenchmarkTarget<S> {
  platform: PlatformDescriptor
  game: Game<S>
  contract: MilestoneContract
  build: { id: string; digest: string }
  reference: readonly string[]
  dispose?(): void
}

export interface VerificationGuarantee {
  mode: VerificationMode
  hardClaim: string
  limitation: string
}

export function validatePlatform(platform: PlatformDescriptor): string[] {
  const errors: string[] = []
  if (!platform.id.trim()) errors.push('platform id is required')
  const c = platform.capabilities
  if (!(c.rawState || c.persistedState || c.eventStream || c.frameCapture || c.platformReceipts)) {
    errors.push(`${platform.id}: no evidence channel is available`)
  }
  if (platform.verificationMode === 'replay' && !c.deterministicReplay) {
    errors.push(`${platform.id}: replay mode requires deterministicReplay`)
  }
  if (platform.verificationMode === 'trusted-recorder' && !c.signedRecorder) {
    errors.push(`${platform.id}: trusted-recorder mode requires signedRecorder`)
  }
  if (platform.verificationMode === 'platform-attested' && !c.platformReceipts) {
    errors.push(`${platform.id}: platform-attested mode requires platformReceipts`)
  }
  return errors
}

export function verificationGuarantee(platform: PlatformDescriptor): VerificationGuarantee {
  switch (platform.verificationMode) {
    case 'replay':
      return {
        mode: 'replay',
        hardClaim: 'Every milestone is recomputed by a verifier-owned execution from the pinned inputs and seed.',
        limitation: 'Sound only when deterministic replay is continuously calibrated for this platform and game.',
      }
    case 'trusted-recorder':
      return {
        mode: 'trusted-recorder',
        hardClaim: 'The signed recorder observed the submitted inputs, accounting, and evidence without later mutation.',
        limitation: 'The recorder boundary is trusted; the verifier cannot independently reproduce the game state.',
      }
    case 'platform-attested':
      return {
        mode: 'platform-attested',
        hardClaim: 'A signed recorder captured normalized progression from the named platform API or title-side SDK and pinned the raw-response digest.',
        limitation: 'The local signature authenticates the recorder, not Steam or Xbox. Cryptographic platform attestation requires a provider-signed token or receipt that the adapter separately verifies.',
      }
  }
}
