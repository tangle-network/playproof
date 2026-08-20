# Contributing

Playproof favors small, evidence-backed changes over platform-specific forks.

## Before opening a change

1. Search for the existing runtime, verifier, adapter, driver, or evidence primitive.
2. State the exact guarantee being added or changed.
3. Add a known-good case and at least one failure or adversarial case.
4. Keep credentials, ROMs, commercial game assets, private platform data, and experiment outputs out of the repository.
5. Run the release-equivalent gate:

```bash
corepack enable
corepack prepare pnpm@11.17.0 --activate
pnpm install --frozen-lockfile
python -m compileall -q desktop native pyboy
pnpm ci
```

## Design rules

- One game loop, one contract language, one publication format.
- `AgentDriver` remains smaller than any model or orchestration SDK; provider integrations are optional drivers or examples.
- Platform adapters normalize execution and evidence; they do not implement a second scorer.
- Verification strength must be explicit: replay, trusted recorder, or recorder-captured platform evidence.
- Unknown agent inputs are no-ops.
- Every external byte stream must have a deadline and size bound.
- Semantic progress uses normalized predicates; exact hashes are identity checks.
- Missing cost or evidence is unavailable, not silently inferred or marked passed.
- Do not claim provider cryptographic attestation without verifying a provider-signed proof.
- Production code must not depend on a research harness, a model vendor, or Tangle Agent Runtime.

## Pull requests

Explain what changed, why it belongs in the shared framework, the trust boundary, and the tests that would fail without the change. Do not include generated attribution or model/tool co-authorship in commits or pull requests.
