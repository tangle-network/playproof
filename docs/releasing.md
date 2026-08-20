# Releasing Playproof

Playproof publishes one verified archive to npm and attaches the same archive and SHA-256 digest to the GitHub release.

## One-time setup

1. Create the public `tangle-network/playproof` repository with `main` as the default branch.
2. Enable GitHub Actions and branch protection for `main`.
3. Ensure the `@tangle-network` npm organization permits public package publication.
4. For the first publication, make the organization automation token available as the repository secret `NPM_TOKEN`.
5. After `@tangle-network/playproof` exists on npm, configure npm Trusted Publishing for:
   - organization: `tangle-network`;
   - repository: `playproof`;
   - workflow: `publish.yml`.
6. Remove the token from the repository when OIDC publication is proven.

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

The real PyBoy/Tetris job is also required and must not take a skip path.

## Cut a release

1. Update `package.json` and `CHANGELOG.md` in one pull request.
2. Merge only after all required checks are green.
3. Tag the exact tip of `main`:

   ```bash
   git tag -s v0.1.0 -m 'Playproof 0.1.0'
   git push origin v0.1.0
   ```

4. The `publish` workflow rebuilds and verifies the source, creates one tarball, records its SHA-256, uploads it as an ephemeral workflow artifact, and publishes that exact file.
5. The workflow then creates the immutable GitHub release with the same tarball and `SHA256SUMS`.

The workflow is idempotent: retrying an already-published version verifies the artifact identity and skips the npm mutation.

## Prohibited release paths

- Do not publish from a developer laptop.
- Do not publish a different archive from the one the verification job produced.
- Do not publish from an unreviewed branch or a tag whose version differs from `package.json`.
- Do not move a published tag.
- Do not rely on unmeasured or unavailable costs as zero-cost evidence.
