# Commit Scope Audit

Catch out-of-scope files after a coding agent commits its work. Pin the task's starting commit and allowed paths, then see which commits, staged edits, unstaged edits, and untracked files touched anything outside that list.

[![CI](https://github.com/4onv/commit-scope-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/4onv/commit-scope-audit/actions/workflows/ci.yml)

## Try it in a disposable repository

Run the demo directly from the GitHub release with Node.js 22+ and Git on your path. Review the [release assets and checksums](https://github.com/4onv/commit-scope-audit/releases/tag/v0.1.0) to download and install the archive locally.

```sh
npm exec --yes --package=https://github.com/4onv/commit-scope-audit/releases/download/v0.1.0/4onv-commit-scope-audit-0.1.0.tgz -- commit-scope-audit demo
```

The demo creates and cleans up a temporary repository with synthetic files. Git status is empty after the executor commits, and the audit still identifies the committed path.

```text
git status --porcelain: (empty)

FAIL  1 out-of-scope path(s) of 2 changed
  OUTSIDE "outside-plan.txt"  committed (…)
  ALLOWED "allowed.txt"      committed (…)
```

From a source checkout, run `node bin/commit-scope-audit.js demo` with no install.

## Review a task

Install the downloaded archive with `npm install --global ./4onv-commit-scope-audit-0.1.0.tgz`. Start with a clean task branch or linked worktree. Save the plan somewhere outside that worktree that the executor cannot edit.

```sh
commit-scope-audit pin --allow src/parser/ --allow tests/parser.test.js --out ../parser-task.json
# Run the task in this worktree.
commit-scope-audit check --plan ../parser-task.json
```

An entry ending in `/` allows descendants of that directory. Every other entry allows one exact path. Rules are case-sensitive, relative to the repository root, and use `/` separators. They are literal strings. Run from a nested directory or use `-C path/to/worktree` to select a checkout. The plan filename is relative to your shell's working directory.

Each first-parent commit is compared to its parent, so a path changed in one commit and reverted in another still appears. A rename contributes its old and new paths. The index and worktree diffs are checked separately, so an unstaged reversal of a staged edit still appears in both layers.

- Exit `0` means every reported path was allowed.
- Exit `1` means at least one reported path was outside the allowlist.
- Exit `2` means the audit could not run. Check the error and retry.

Use `--format json` for the versioned report with full commit IDs, layer names, and the matching rule or `null` for each path. Use `--format markdown` for a copyable report in a review. An audited checkout can also be checked with `check --base <full-commit-id> --allow <path>` using a base and rules supplied by a trusted caller.

## GitHub Actions

The composite action runs the same CLI and writes the report to the job summary. Use a full checkout with Node.js 22+ and Git available. This example assumes the checked-out PR head contains the trusted base in its first-parent history. If the target branch advanced, rebase the task branch or use the original trusted task base.

```yaml
name: Task scope
on: pull_request
permissions:
  contents: read
jobs:
  scope:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - uses: 4onv/commit-scope-audit@v0.1.0
        with:
          base: ${{ github.event.pull_request.base.sha }}
          allow: |
            src/parser/
            tests/parser.test.js
```

Use a trusted workflow and allowlist when enforcing a gate. The action fails on a scope violation or audit error and exposes `exit-code` so callers can distinguish them.

## Audit boundaries

The checker reads Git metadata in a trusted local checkout after edits have stopped. Keep the plan and checker under reviewer control. The report covers paths, and a reviewer still needs to assess file contents, runtime effects, and whether the task was completed.

Git's ignore rules apply to untracked files. An embedded repository or submodule may appear as a single path, with no recursive file inspection. A merge contributes its changes relative to its first parent. Individual side-branch commits, rewritten-away commits, and transient edits absent from the observed layers are outside the audit. Git's configured filters and filesystem behavior can affect what Git reports.

The tool rejects a base outside first-parent history, index flags that hide tracked edits, malformed plans, and invalid UTF-8 paths. It audits up to 100 first-parent commits and 20,000 distinct paths.

## Development

Run `npm test` and `npm run demo`. CI also installs the packed archive offline on Linux and Windows and tests both outcomes of the composite action. [November 11 research and comparisons](docs/research-2026-11-11.md)

MIT licensed.
