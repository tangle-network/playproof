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

```bash
corepack enable
corepack prepare pnpm@11.17.0 --activate
pnpm install --frozen-lockfile
python -m compileall -q desktop native pyboy
pnpm ci
```

`pnpm ci` runs:

- repository-boundary checks;
- strict TypeScript checking, including examples;
- deterministic and adversarial framework tests;
- native desktop, Steam, Xbox, CLI, and OpenAI-compatible driver tests;
- the production build;
- exact npm archive inspection; and
- clean-consumer imports of every public subpath.

The real PyBoy/Tetris regression (`PLAYPROOF_ROM=... pnpm test:pyboy` followed by `pnpm exec tsx calibrate.mts`) runs locally with a legally obtained ROM that matches `pyboy/reference-tetris.json`; CI cannot obtain that ROM, so the release manager runs it before tagging.

The equivalent free-ROM regression (`pnpm test:pyboy-libbet`) runs in CI on every pull request, because the Libbet and the Magic Floor ROM is free software that the job downloads and verifies by hash.

## Cut a release

1. Update `package.json` and `CHANGELOG.md` in one pull request.
2. Merge only after all required checks are green.
3. Tag the exact tip of `main`:

   ```bash
   git tag -s v0.1.0 -m 'Playproof 0.1.0'
   git push origin v0.1.0
   ```

4. The `require-green-ci` job resolves the commit the tag points at and reads the `ci` workflow result for that commit. The release continues only when `ci` concluded `success` there and all six required jobs ran and passed.
5. The `verify` job rebuilds and verifies the source, creates one tarball, records its SHA-256, and uploads it as an ephemeral workflow artifact.
6. The publish job publishes that exact file and creates the immutable GitHub release with the same tarball and `SHA256SUMS`.

The workflow is idempotent: retrying an already-published version verifies the artifact identity and skips the npm mutation.

## The ci result gates the tag

`publish.yml` never publishes a commit that `ci` has not passed. The gate refuses on every answer except a green one:

| what the Actions API reports for the tagged commit | outcome |
|---|---|
| the `ci` workflow concluded `success`, and all six required jobs passed | publish |
| the `ci` workflow concluded `failure`, `cancelled`, `timed_out`, `neutral`, `skipped`, `stale` or `action_required` | refuse |
| no `ci` run exists for that commit | wait up to 10 minutes, then refuse |
| a `ci` run is still queued or running | wait up to 60 minutes, then refuse |
| a run is green but a required job is absent, or its gate step was skipped | refuse |
| the API cannot be read | refuse |

The six required job names live in `release-gate.mts` rather than being read from the tagged `ci.yml`, because a workflow file edited to remove a job would otherwise agree with itself. `release-gate.test.mts` fails when a name stops matching `ci.yml`, and states every refusal above as an executable case.

### Retry a release, and override a red ci

Run the `publish` workflow manually with `release_tag` set to the existing tag. The retry reads the `ci` result the same way a tag push does; it is not a way around the gate.

To publish although `ci` is not green, set `ci_override_reason` on the same manual run to at least 12 characters that say why. The run reports that it published on a human override, and the reason is recorded in the workflow log and the job summary. There is no override on a tag push.

## Release integrity without provenance

A release carries four pieces of evidence instead of a sigstore attestation: the tag resolves to the exact commit the verify job checked out, `package.json` version equals the tag, the complete gate passed on that tree, and the SHA-256 of the one archive that was built is recorded in `SHA256SUMS` on the GitHub release next to the archive itself. Compare the digest of the npm tarball with that receipt to confirm the registry holds the artifact this repository built.

## Prohibited release paths

- Do not publish from a developer laptop.
- Do not publish a different archive from the one the verification job produced.
- Do not publish from an unreviewed branch or a tag whose version differs from `package.json`.
- Do not move a published tag.
- Do not rely on unmeasured or unavailable costs as zero-cost evidence.
