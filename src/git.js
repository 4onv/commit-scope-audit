import { spawnSync } from 'node:child_process';

const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const diffFlags = [
  '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
  '--no-relative', '--no-color', '--ignore-submodules=none',
];
const locationVariables = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX',
]);

export function decode(buffer) {
  try {
    return decoder.decode(buffer);
  } catch {
    throw new Error('Input or Git output contains bytes that are invalid UTF-8.');
  }
}

export function isCommitId(value) {
  return typeof value === 'string' && sha.test(value);
}

export function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !locationVariables.has(key.toUpperCase())));
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    env: {
      ...env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`git ${args[0]} could not complete (${result.error.code}).`);
  }
  if (result.status !== 0) {
    const reason = result.stderr.toString('utf8').trim().split('\n')[0];
    throw new Error(`git ${args[0]} failed: ${reason || result.signal || result.status}`);
  }
  return result.stdout;
}

export function gitText(cwd, ...args) {
  return decode(git(cwd, ...args)).replace(/\r?\n$/u, '');
}

export function gitPaths(cwd, ...args) {
  const output = decode(git(cwd, ...args));
  if (!output) return [];
  if (!output.endsWith('\0')) throw new Error('Unexpected Git path output.');
  return output.slice(0, -1).split('\0');
}

export function changedPaths(cwd, ...revisions) {
  return gitPaths(cwd, 'diff', ...diffFlags, ...revisions, '--');
}
