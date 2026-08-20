# Security Policy

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories for the Playproof repository. Do not publish exploit details before maintainers have assessed and remediated the issue.

Include:

- affected version or commit;
- adapter and verification mode;
- a minimal reproduction;
- the claimed security property that fails; and
- whether the issue can forge milestones, signatures, identities, accounting, or resource bounds.

## Supported versions

The latest minor release is supported. Pre-1.0 APIs may change, but published run-envelope schemas remain explicit and versioned.

## Security model

Playproof protects benchmark integrity through verifier-owned replay where possible and signed recorder artifacts otherwise. It does not provide anti-cheat bypasses, game-process injection, credential extraction, arbitrary memory writes, or provider cryptographic attestation unless an adapter explicitly verifies a provider-signed proof.

A local recorder signature authenticates the recorder, not an external platform. Deterministic replay is the strongest supported verification mode.
