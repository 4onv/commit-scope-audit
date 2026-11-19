#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import packageInfo from '../package.json' with { type: 'json' };
import { audit, auditAgainstUpstream, pin, readPlan } from '../src/audit.js';
import { demo } from '../src/demo.js';
import { quote, render } from '../src/report.js';

const help = `Usage:
  commit-scope-audit pin --allow <path> [--allow <path> ...] [--out <file>] [-C <repo>]
  commit-scope-audit check --plan <file> [--format text|json|markdown] [-C <repo>]
  commit-scope-audit check --base <full-commit-id> --allow <path> [--allow <path> ...]
                           [--format text|json|markdown] [-C <repo>]
  commit-scope-audit check --upstream <local-ref> --allow <path> [--allow <path> ...]
                           [--format text|json|markdown] [-C <repo>]
  commit-scope-audit demo

Paths are case-sensitive and relative to the repository root. Use a trailing /
to allow descendants of a directory. Save the plan outside the audited worktree.
Exit status for check: 0 within scope, 1 outside scope, 2 usage or audit error.`;

const repo = { type: 'string', short: 'C', default: '.' };
const allow = { type: 'string', multiple: true, default: [] };
const options = {
  pin: { repo, allow, out: { type: 'string' } },
  check: {
    repo, allow, plan: { type: 'string' }, base: { type: 'string' }, upstream: { type: 'string' },
    format: { type: 'string', default: 'text' },
  },
  demo: {},
};

function main([command, ...args]) {
  if (!command || command === '--help' || command === '-h') {
    console.log(help);
    return 0;
  }
  if (command === '--version') {
    console.log(packageInfo.version);
    return 0;
  }
  if (!Object.hasOwn(options, command)) throw new Error(`Unknown command ${quote(command)}.`);
  const { values } = parseArgs({
    args,
    options: { ...options[command], help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log(help);
    return 0;
  }
  if (command === 'demo') {
    console.log(demo());
    return 0;
  }
  if (command === 'pin') {
    const output = `${JSON.stringify(pin(values.repo, values.allow), null, 2)}\n`;
    if (values.out === undefined) process.stdout.write(output);
    else writeFileSync(values.out, output, { flag: 'wx', mode: 0o600 });
    return 0;
  }

  if (!['text', 'json', 'markdown'].includes(values.format)) {
    throw new Error('--format must be text, json, or markdown.');
  }
  const usePlan = values.plan !== undefined;
  const modes = [values.plan, values.base, values.upstream].filter(value => value !== undefined);
  if (modes.length !== 1 || (usePlan && values.allow.length)) {
    throw new Error('Use --plan FILE, --base COMMIT with --allow, or --upstream REF with --allow.');
  }
  const report = values.upstream !== undefined
    ? auditAgainstUpstream(values.repo, values.upstream, values.allow)
    : audit(values.repo, usePlan ? readPlan(values.plan) : { version: 1, base: values.base, allow: values.allow });
  console.log(render(report, values.format));
  return report.ok ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`commit-scope-audit: ${quote(error.message).slice(1, -1)}`);
  process.exitCode = 2;
}
