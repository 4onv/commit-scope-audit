import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import packageInfo from '../package.json' with { type: 'json' };

const archive = resolve(process.argv[2] ?? `4onv-commit-scope-audit-${packageInfo.version}.tgz`);
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run with npm run check:package.');
const dir = mkdtempSync(join(tmpdir(), 'scope-audit-install-'));

function run(...args) {
  const result = spawnSync(process.execPath, args, {
    cwd: dir, encoding: 'utf8', timeout: 45_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? ''));
  return result.stdout;
}

try {
  const filename = basename(archive);
  copyFileSync(archive, join(dir, filename));
  const output = run(npm, '--prefix', '.', 'exec', '--offline', '--yes',
    `--package=./${filename}`, '--', 'commit-scope-audit', 'demo');
  assert.match(output, /git status --porcelain: \(empty\)/);
  assert.match(output, /OUTSIDE "outside-plan.txt"  committed/);
  run(npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive);
  const binary = process.platform === 'win32' ? 'commit-scope-audit.cmd' : 'commit-scope-audit';
  assert.ok(existsSync(join(dir, 'node_modules', '.bin', binary)), 'npm did not link the executable');
  assert.equal(run(npm, 'exec', '--offline', '--', 'commit-scope-audit', '--version').trim(), packageInfo.version);
  console.log('Verified the offline quick start and installed the archive with a working CLI.');
} finally {
  rmSync(dir, { force: true, recursive: true });
}
