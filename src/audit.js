import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { changedPaths, decode, gitPaths, gitText, isCommitId } from './git.js';

const version = 1;
const maxPlanBytes = 128 * 1024;
const maxCommits = 100;
const maxPaths = 20_000;

export function validatePlan(plan) {
  if (!plan || plan.version !== version || !isCommitId(plan.base) ||
      !Array.isArray(plan.allow) || plan.allow.length === 0 ||
      plan.allow.length > 256 || Object.keys(plan).length !== 3) {
    throw new Error('Expected a version 1 plan with a full base commit ID and 1–256 allowed paths.');
  }
  for (const path of plan.allow) {
    if (typeof path !== 'string' || /[\\\u0000-\u001f]/u.test(path) ||
        /^[a-z]:/iu.test(path) ||
        path.replace(/\/$/u, '').split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Allowed paths must be literal, repository-relative paths with forward slashes.');
    }
  }
  const clean = { version, base: plan.base, allow: [...new Set(plan.allow)] };
  if (Buffer.byteLength(JSON.stringify(clean, null, 2)) + 1 > maxPlanBytes) {
    throw new Error('Plan exceeds 128 KiB.');
  }
  return clean;
}

export function readPlan(filename) {
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error('The plan must be a regular file.');
    const buffer = Buffer.alloc(maxPlanBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxPlanBytes) throw new Error('Plan exceeds 128 KiB.');
    let plan;
    try {
      plan = JSON.parse(decode(buffer.subarray(0, length)).replace(/^\ufeff/u, ''));
    } catch {
      throw new Error('The plan must contain valid UTF-8 JSON.');
    }
    return validatePlan(plan);
  } finally {
    closeSync(fd);
  }
}

function repository(cwd) {
  const root = gitText(cwd, 'rev-parse', '--show-toplevel');
  const head = gitText(root, 'rev-parse', '--verify', 'HEAD^{commit}');
  if (!isCommitId(head)) throw new Error('Git did not return a full HEAD commit ID.');
  return { root, head };
}

function commitRange(root, base, head) {
  if (base === head) return [];
  if (gitText(root, 'rev-parse', '--verify', `${base}^{commit}`) !== base) {
    throw new Error('The plan base must be a commit ID.');
  }
  const rows = gitText(root, 'rev-list', '--first-parent', '--parents',
    `--max-count=${maxCommits + 1}`, `${base}..${head}`, '--');
  const commits = rows ? rows.split(/\r?\n/u).map(row => row.split(' ')) : [];
  if (commits.length > maxCommits) {
    throw new Error(`The plan spans more than ${maxCommits} first-parent commits.`);
  }
  if (commits.at(-1)?.[1] !== base) {
    throw new Error('The base is outside HEAD’s first-parent history. Check the checkout and fetch depth.');
  }
  return commits.reverse().map(([id, parent]) => ({ id, parent }));
}

function inspectWorkingTree(root, head) {
  for (const entry of gitPaths(root, 'ls-files', '-v', '-z', '--')) {
    if (/^[Sa-z] /u.test(entry)) {
      throw new Error('The index uses skip-worktree or assume-unchanged. Use a full, ordinary checkout.');
    }
  }
  return [
    ['staged', changedPaths(root, '--cached', '--ita-invisible-in-index', head)],
    ['unstaged', changedPaths(root, '--ita-invisible-in-index')],
    ['untracked', gitPaths(root, 'ls-files', '--others', '--exclude-standard', '-z', '--')],
  ];
}

export function audit(cwd, input) {
  const plan = validatePlan(input);
  return auditResolved(repository(cwd), plan);
}

/** Derive a fresh comparison base for rebased branches and CI checkouts. */
export function auditAgainstUpstream(cwd, upstream, allow) {
  const checkout = repository(cwd);
  const { root, head } = checkout;
  if (typeof upstream !== 'string' || !upstream || upstream.startsWith('-') ||
      /[\u0000-\u0020\u007f]/u.test(upstream)) {
    throw new Error('Provide a local upstream commit or ref.');
  }
  const upstreamCommit = gitText(root, 'rev-parse', '--verify', '--end-of-options', upstream + '^{commit}');
  if (!isCommitId(upstreamCommit)) throw new Error('Git did not return a full upstream commit ID.');
  const bases = gitText(root, 'merge-base', '--all', upstreamCommit, head).split(/\r?\n/u);
  if (bases.length !== 1 || !isCommitId(bases[0])) {
    throw new Error('Upstream mode requires a single merge base. Supply an explicit first-parent base instead.');
  }
  const plan = validatePlan({ version, base: bases[0], allow });
  return { ...auditResolved(checkout, plan), upstream: { commit: upstreamCommit } };
}

function auditResolved({ root, head }, plan) {
  const commits = commitRange(root, plan.base, head);
  const changes = new Map();

  function record(paths, layer, commit) {
    for (const path of new Set(paths)) {
      if (!changes.has(path)) {
        if (changes.size === maxPaths) throw new Error(`Audit exceeds ${maxPaths} distinct paths.`);
        changes.set(path, { path, commits: [], layers: [] });
      }
      const entry = changes.get(path);
      if (commit) entry.commits.push(commit);
      if (!entry.layers.includes(layer)) entry.layers.push(layer);
    }
  }

  for (const { id, parent } of commits) record(changedPaths(root, parent, id), 'committed', id);
  for (const [layer, paths] of inspectWorkingTree(root, head)) record(paths, layer);
  if (gitText(root, 'rev-parse', '--verify', 'HEAD^{commit}') !== head) {
    throw new Error('HEAD moved during the audit. Stop concurrent edits and retry.');
  }
  const paths = [...changes.keys()].sort().map(path => {
    const allowedBy = plan.allow.find(rule => rule.endsWith('/') ? path.startsWith(rule) : path === rule);
    return { ...changes.get(path), allowedBy: allowedBy ?? null };
  });
  return {
    version,
    base: plan.base,
    head,
    allow: plan.allow,
    commitCount: commits.length,
    ok: paths.every(path => path.allowedBy !== null),
    paths,
  };
}

export function pin(cwd, allow) {
  const { head } = repository(cwd);
  const plan = validatePlan({ version, base: head, allow });
  const report = audit(cwd, plan);
  if (report.head !== head || report.paths.length) {
    throw new Error('Pin a clean worktree before starting the task.');
  }
  return plan;
}
