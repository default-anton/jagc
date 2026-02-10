# Release runbook

This is the canonical publish procedure for `jagc`.

## Scope

- Release channel: **latest** only (stable tags `vX.Y.Z`).
- Publish target: npm package **`jagc`**.
- Owner account: npm user **`akuzmenko`**.

## One-time setup

1. Ensure npm package ownership includes `akuzmenko`:
   - `npm owner ls jagc`
2. Enable npm trusted publishing for this repository in npm package settings.
   - Provider: GitHub Actions
   - Repo: `<github-owner>/jagc`
3. Ensure GitHub Actions is enabled and can request OIDC tokens.
   - Workflow must have `permissions: id-token: write`.
4. Do **not** configure npm publish tokens (`NODE_AUTH_TOKEN` / `NPM_TOKEN`) for this repo.
   - Release workflow enforces tokenless publish and fails if token auth is present.

> 2FA remains enabled on the npm account. Trusted publishing avoids long-lived npm tokens in repo secrets.

### First-release bootstrap (only if needed)

If npm does not allow trusted publishing setup before the package exists, do one manual bootstrap publish from a trusted local machine:

1. `pnpm release:gate`
2. `npm login` (account: `akuzmenko`)
3. `npm publish --access public`
4. Configure trusted publishing for this repo.
5. All subsequent releases use tag-driven GitHub Actions only.

## Changelog format (required)

`CHANGELOG.md` must always contain:

- `## [Unreleased]`
- Version sections formatted as `## [X.Y.Z] - YYYY-MM-DD`
- Structured subsections (`Added`, `Changed`, `Fixed`, optional `Removed`/`Security`)

## Release steps

1. **Prepare release commit**
   - Move completed entries from `## [Unreleased]` into a new section:
     - `## [X.Y.Z] - YYYY-MM-DD`
   - Reset `## [Unreleased]` back to placeholders.
   - Bump package version in `package.json` to `X.Y.Z`.

2. **Validate locally**
   - Run: `pnpm release:gate`

3. **Commit + merge to main**
   - Commit changelog/version/docs updates.
   - Merge PR to `main`.

4. **Tag release**
   - `git tag -a vX.Y.Z -m "release: vX.Y.Z"`
   - `git push origin vX.Y.Z`

5. **Automated publish**
   - GitHub Actions `release` workflow runs on the tag.
   - Workflow verifies tag/version/changelog consistency.
   - Workflow runs `pnpm release:gate`.
   - Workflow publishes with:
     - `NPM_CONFIG_PROVENANCE=false npm publish --access public`
   - Workflow creates/updates GitHub release notes from the matching changelog section.
   - Note: npm provenance is currently unsupported for private GitHub repositories.

6. **Post-release verification**
   - `npm view jagc version dist-tags --json`
   - Fresh install smoke:
     - `npm install -g jagc@latest`
     - `jagc --help`

## Failure + rollback

- If publish fails before npm upload: fix and re-run workflow.
- If a bad version is published:
  1. Deprecate bad version:
     - `npm deprecate jagc@X.Y.Z "broken release; upgrade to >=X.Y.Z+1"`
  2. Cut hotfix `X.Y.Z+1` via same runbook.
- Do **not** unpublish stable versions except for exceptional legal/security cases.
