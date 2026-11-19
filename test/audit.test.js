import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { audit, pin, readPlan, validatePlan } from '../src/audit.js';
import { gitText } from '../src/git.js';
import { render } from '../src/report.js';

const cliPath = fileURLToPath(new URL('../bin/commit-scope-audit.js', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'scope-audit-test-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const git = (...args) => gitText(repo, ...args);
  const write = (path, contents = 'sample') => {
    const target = join(repo, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const commit = message => {
    git('add', '-A', '--');
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const cli = (...args) => spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repo, encoding: 'utf8', windowsHide: true,
  });

  git('init', '--initial-branch=main', '--template=');
  git('config', 'user.name', 'Synthetic Scope Audit Test');
  git('config', 'user.email', 'scope-test@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'core.hooksPath', '.git/no-hooks');
  write('src/file.txt', 'base');
  write('notes.txt', 'base');
  write('.gitignore', '*.ignored\n');
  const base = commit('Synthetic baseline');
  return { dir, repo, write, git, cli, commit, base };
}

test('upstream audit recalculates the base after a real rebase and checks local edits', t => {
  const { git, write, commit, cli, base } = fixture(t);
  git('switch', '-c', 'task');
  write('src/file.txt', 'task change');
  commit('Task change');
  git('switch', 'main');
  write('notes.txt', 'upstream change');
  const upstream = commit('Upstream change');
  git('switch', 'task');
  git('rebase', 'main');
  const check = (...flags) => cli('check', ...flags, '--allow', 'src/', '--format', 'json');
  const againstOldBase = check('--base', base);
  assert.equal(againstOldBase.status, 1);
  const againstUpstream = check('--upstream', 'refs/heads/main');
  assert.equal(againstUpstream.status, 0, againstUpstream.stderr);
  const report = JSON.parse(againstUpstream.stdout);
  assert.equal(report.base, upstream);
  assert.equal(report.upstream.commit, upstream);
  assert.deepEqual(report.paths.map(row => row.path), ['src/file.txt']);
  write('new-notes.txt');
  assert.equal(check('--upstream', 'main').status, 1);
  assert.equal(check('--upstream', 'does-not-exist').status, 2);
  assert.equal(check('--upstream', 'main', '--base', base).status, 2);
});

test('reports a committed violation when the worktree is clean', t => {
  const f = fixture(t);
  const plan = pin(f.repo, ['src/']);
  f.write('src/file.txt', 'within scope');
  f.write('notes.txt', 'outside scope');
  const head = f.commit('Scope violation');
  assert.equal(f.git('diff', '--stat'), '');
  assert.equal(f.git('status', '--porcelain'), '');

  const report = audit(f.repo, plan);
  assert.equal(report.ok, false);
  assert.equal(report.base, f.base);
  assert.equal(report.head, head);
  assert.equal(report.commitCount, 1);
  assert.deepEqual(report.paths, [
    { path: 'notes.txt', commits: [head], layers: ['committed'], allowedBy: null },
    { path: 'src/file.txt', commits: [head], layers: ['committed'], allowedBy: 'src/' },
  ]);
});

test('includes the original change and the revert when endpoint trees match', t => {
  const f = fixture(t);
  const plan = pin(f.repo, ['src/']);
  f.write('notes.txt', 'temporary violation');
  const change = f.commit('Outside scope');
  f.write('notes.txt', 'base');
  const revert = f.commit('Revert outside scope');
  assert.equal(f.git('diff', '--name-only', f.base, 'HEAD'), '');
  assert.deepEqual(audit(f.repo, plan).paths, [
    { path: 'notes.txt', commits: [change, revert], layers: ['committed'], allowedBy: null },
  ]);
});

test('separates index, working tree and untracked paths without changing the index', t => {
  const f = fixture(t);
  const plan = pin(f.repo, ['src/']);
  f.write('notes.txt', 'staged violation');
  f.git('add', 'notes.txt');
  f.write('notes.txt', 'base');
  f.write('src/café space.txt', 'intent to add');
  f.git('add', '-N', '--', 'src/café space.txt');
  f.write('src-extra/sibling.txt');
  f.write('src/other.txt');
  f.write('private.ignored');
  const indexFile = join(f.repo, '.git/index');
  const before = readFileSync(indexFile);

  const report = audit(join(f.repo, 'src'), plan);
  assert.equal(report.ok, false);
  assert.deepEqual(report.paths.map(p => [p.path, p.layers, p.allowedBy]), [
    ['notes.txt', ['staged', 'unstaged'], null],
    ['src-extra/sibling.txt', ['untracked'], null],
    ['src/café space.txt', ['unstaged'], 'src/'],
    ['src/other.txt', ['untracked'], 'src/'],
  ]);
  assert.deepEqual(readFileSync(indexFile), before);
  assert.equal(f.git('rev-parse', 'HEAD'), f.base);
});

test('rename into an allowed directory includes the outside source path', t => {
  const f = fixture(t);
  const plan = pin(f.repo, ['src/']);
  f.git('mv', 'notes.txt', 'src/notes.txt');
  const report = audit(f.repo, plan);
  assert.equal(report.ok, false);
  assert.deepEqual(report.paths.map(p => [p.path, p.layers, p.allowedBy]), [
    ['notes.txt', ['staged'], null],
    ['src/notes.txt', ['staged'], 'src/'],
  ]);
});

test('reports a merge as a first-parent diff and rejects a second-parent base', t => {
  const f = fixture(t);
  const plan = pin(f.repo, ['src/']);
  f.git('switch', '-c', 'side');
  f.write('notes.txt', 'side branch work');
  const side = f.commit('Side changes');
  f.git('switch', 'main');
  f.git('merge', '--no-ff', 'side', '-m', 'Merge side branch');
  const merge = f.git('rev-parse', 'HEAD');
  const report = audit(f.repo, plan);
  assert.equal(report.commitCount, 1);
  assert.deepEqual(report.paths[0].commits, [merge]);
  assert.throws(() => audit(f.repo, { ...plan, base: side }), /outside HEAD’s first-parent/);
});

test('rejects incomplete history and index flags that hide tracked changes', t => {
  const f = fixture(t);
  const plan = pin(f.repo, ['src/']);
  f.write('src/file.txt', 'within scope');
  f.commit('Within scope');
  const shallow = join(f.dir, 'shallow');
  f.git('clone', '--quiet', '--no-local', '--depth', '1', '.', shallow);
  assert.throws(() => audit(shallow, plan), /git rev-parse failed/);
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    f.git('update-index', `--${flag}`, 'notes.txt');
    assert.throws(() => audit(f.repo, plan), /skip-worktree or assume-unchanged/);
    f.git('update-index', `--no-${flag}`, 'notes.txt');
  }
  assert.equal(audit(f.repo, plan).ok, true);
});

test('audits a detached linked worktree from a nested directory', t => {
  const f = fixture(t);
  const plan = pin(f.repo, ['src/file.txt']);
  const linked = join(f.dir, 'linked worktree');
  f.git('worktree', 'add', '--detach', linked, f.base);
  writeFileSync(join(linked, 'src/file.txt'), 'allowed');
  writeFileSync(join(linked, 'notes.txt'), 'outside');
  const report = audit(join(linked, 'src'), plan);
  assert.deepEqual(report.paths.map(p => [p.path, p.allowedBy]), [
    ['notes.txt', null],
    ['src/file.txt', 'src/file.txt'],
  ]);
  assert.equal(audit(f.repo, plan).paths.length, 0);
});

test('keeps unusual paths intact and escaped in terminal and Markdown reports', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const plan = pin(f.repo, ['src/']);
  const path = 'outside\n~~~\n\u202e.txt';
  f.write(path);
  const report = audit(f.repo, plan);
  assert.equal(report.paths[0].path, path);
  const summary = render(report, 'markdown');
  assert.match(summary, /"outside\\n~~~\\n\\u202e\.txt"/);
  assert.equal(summary.split('\n').filter(line => line.startsWith('~~~')).length, 2);
});

test('plan validation rejects ambiguous relative rules and unsupported schema', () => {
  const plan = { version: 1, base: 'a'.repeat(40), allow: ['src/', 'docs/setup.md'] };
  assert.deepEqual(validatePlan(plan), plan);
  for (const rule of ['', '/', '../src/', 'src//', 'C:/src', 'src/../', 'a\\b']) {
    assert.throws(() => validatePlan({ ...plan, allow: [rule] }), /repository-relative/);
  }
  assert.throws(() => validatePlan({ ...plan, base: 'main' }), /full base commit ID/);
  assert.throws(() => validatePlan({ ...plan, version: 2 }), /version 1/);
});

test('reads only regular UTF-8 JSON plans within the size limit', t => {
  const f = fixture(t);
  const filename = join(f.dir, 'plan.json');
  assert.throws(() => readPlan(f.dir), /regular file|EISDIR/);
  writeFileSync(filename, Buffer.alloc(128 * 1024 + 1, 32));
  assert.throws(() => readPlan(filename), /exceeds 128 KiB/);
  writeFileSync(filename, Buffer.from([0xff]));
  assert.throws(() => readPlan(filename), /valid UTF-8 JSON/);
  writeFileSync(filename, '\ufeff' + JSON.stringify(pin(f.repo, ['src/'])));
  assert.equal(readPlan(filename).base, f.base);
});

test('CLI pins without overwriting and provides distinct exit codes for checks', t => {
  const f = fixture(t);
  const planFile = join(f.dir, 'task.json');
  let result = f.cli('pin', '--allow', 'src/', '--out', planFile);
  assert.equal(result.status, 0, result.stderr);
  const plan = readFileSync(planFile, 'utf8');
  result = f.cli('pin', '--allow', 'notes.txt', '--out', planFile);
  assert.equal(result.status, 2);
  assert.equal(readFileSync(planFile, 'utf8'), plan);
  f.write('src/file.txt', 'allowed');
  result = f.cli('check', '--plan', planFile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PASS/);
  f.write('notes.txt', 'violation');
  result = f.cli('check', '--base', f.base, '--allow', 'src/', '--format', 'json');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).paths[0].path, 'notes.txt');
  result = f.cli('check', '--plan', planFile, '--base', f.base);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Use --plan/);
  assert.equal(f.cli('pin', '--allow', 'src/').status, 2);
});
