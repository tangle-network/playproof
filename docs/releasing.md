# Releasing Playproof

Playproof publishes one verified archive to npm and attaches the same archive and SHA-256 digest to the GitHub release.

## One-time setup

1. Create the public `tangle-network/playproof` repository with `main` as the default branch.
2. Enable GitHub Actions and branch protection for `main`.
3. Ensure the `@tangle-network` npm organization permits public package publication.
4. For the first publication, make the organization automation token available as the repository secret `NPM_TOKEN`.
5. Keep the token in place. npm provenance and npm Trusted Publishing both require a GitHub-hosted runner; they reject a self-hosted one with `Unsupported GitHub Actions runner environment`. This organization publishes from its own pool, so the package ships without a sigstore attestation.
6. Configure npm Trusted Publishing only when GitHub-hosted runners are available to this repository again.

## Release gates

Merge `origin/main` and qualify the affected surface before merging source changes. The maintained admitted release-equivalent reference is:

```bash
beelink-gate auto https://github.com/tangle-network/playproof.git <full-sha> -- bash -lc 'python3 -m compileall -q ale desktop gym native pyboy pyshared retro retroarch && pnpm ci'
```

Workflow and documentation-only changes use actionlint, YAML, content, and exact-source structural checks. Automatic PR/main-push qualification is retired; the same six-job population runs within publication before the writer receives authority.

`pnpm ci` runs:

- repository-boundary checks;
- strict TypeScript checking, including examples;
- deterministic and adversarial framework tests;
- native desktop, Steam, Xbox, CLI, and OpenAI-compatible driver tests;
- the production build;
- exact npm archive inspection; and
- clean-consumer imports of every public subpath.

The real PyBoy/Tetris regression (`PLAYPROOF_ROM=... pnpm test:pyboy` followed by `pnpm exec tsx calibrate.mts`) runs locally with a legally obtained ROM that matches `pyboy/reference-tetris.json`; CI cannot obtain that ROM, so the release manager runs it before tagging.

The equivalent free-ROM regression (`pnpm test:pyboy-libbet`) runs in the publication-owned qualification, because the Libbet and the Magic Floor ROM is free software that the job downloads and verifies by hash.

## Cut a release

1. Update `package.json` and `CHANGELOG.md` in one pull request.
2. Merge after the admitted local gate and all applicable review findings are resolved.
3. Tag the exact tip of `main`:

   ```bash
   git tag -s v0.1.0 -m 'Playproof 0.1.0'
   git push origin v0.1.0
   ```

4. The `verify` job resolves and validates the tag and package version, rebuilds and verifies that exact source, creates one tarball, records its SHA-256, and uploads it as an ephemeral workflow artifact.
5. The `require-green-ci` job calls the retained `ci.yml` with the full source SHA from `verify`. All six jobs check out that SHA and must succeed before publication.
6. The publish job publishes that exact file and creates the immutable GitHub release with the same tarball and `SHA256SUMS`.

The workflow is idempotent: retrying an already-published version verifies the artifact identity and skips the npm mutation.

## Qualification belongs to publication

`publish.yml` calls the retained six-job qualification directly after `verify` resolves the tag: framework/package, free-ROM PyBoy, Gymnasium, ALE, Stable Retro, and RetroArch. Their work steps, toolchains, timeouts and runner placement are unchanged. Each checkout binds to the verified full source SHA; a manual standalone `ci` run uses its dispatched SHA. Qualification receives read-only repository access and no npm publication secret.

The package writer still needs both `verify` and `require-green-ci`. A failed, cancelled, timed-out or skipped required job prevents the writer from running. Publication no longer waits for a separate branch-triggered `ci` run or polls the Actions API. The existing six-job names and work steps remain the source contract recorded by `release-gate.mts` and its retained assertions; that standalone polling helper is no longer invoked by publication.

### Retry a release

Run the `publish` workflow manually with `release_tag` set to the existing tag. The retry validates its identity and runs the same source-bound qualification. There is no CI override input.

## Release integrity without provenance

A release carries four pieces of evidence instead of a sigstore attestation: the tag resolves to the exact commit the verify job checked out, `package.json` version equals the tag, the complete gate passed on that tree, and the SHA-256 of the one archive that was built is recorded in `SHA256SUMS` on the GitHub release next to the archive itself. Compare the digest of the npm tarball with that receipt to confirm the registry holds the artifact this repository built.

## Prohibited release paths

- Do not publish from a developer laptop.
- Do not publish a different archive from the one the verification job produced.
- Do not publish from an unreviewed branch or a tag whose version differs from `package.json`.
- Do not move a published tag.
- Do not rely on unmeasured or unavailable costs as zero-cost evidence.
