import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audit, pin } from './audit.js';
import { git, gitText } from './git.js';
import { render } from './report.js';

export function demo() {
  const dir = mkdtempSync(join(tmpdir(), 'commit-scope-demo-'));
  const run = (...args) => git(dir, '-c', 'core.hooksPath=.git/disabled-hooks',
    '-c', 'commit.gpgSign=false', '-c', 'user.name=Scope Audit Demo',
    '-c', 'user.email=demo@example.invalid', ...args);
  try {
    run('init', '--template=', '--initial-branch=main');
    writeFileSync(join(dir, 'allowed.txt'), 'original\n');
    run('add', '-f', '--', 'allowed.txt');
    run('commit', '-m', 'Synthetic baseline');
    const plan = pin(dir, ['allowed.txt']);

    writeFileSync(join(dir, 'allowed.txt'), 'intentional change\n');
    writeFileSync(join(dir, 'outside-plan.txt'), 'unrelated synthetic change\n');
    run('add', '-f', '--', 'allowed.txt', 'outside-plan.txt');
    run('commit', '-m', 'Synthetic executor change');

    const clean = gitText(dir, 'status', '--porcelain=v1') === '';
    const report = audit(dir, plan);
    const outside = report.paths.find(path => path.path === 'outside-plan.txt');
    if (!clean || report.ok || !outside?.layers.includes('committed')) {
      throw new Error('Demo did not reproduce the expected scope violation.');
    }
    return [
      'Synthetic demo in a disposable Git repository',
      'git status --porcelain: (empty)',
      '',
      render(report),
      '',
      'Expected violation found. The temporary repository was removed.',
    ].join('\n');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}
