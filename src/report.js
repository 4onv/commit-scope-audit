export function quote(value) {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function render(report, format = 'text') {
  if (format === 'json') return JSON.stringify(report, null, 2);

  const count = report.paths.filter(path => path.allowedBy === null).length;
  const lines = [
    `${report.ok ? 'PASS' : 'FAIL'}  ${count} out-of-scope path(s) of ${report.paths.length} changed`,
    `Base    ${report.base}`,
    `HEAD    ${report.head}`,
    `Range   ${report.commitCount} first-parent commit(s)`,
    `Allow   ${report.allow.map(quote).join(', ')}`,
  ];
  const paths = [...report.paths].sort((a, b) => Number(a.allowedBy !== null) - Number(b.allowedBy !== null));
  for (const { path, layers, commits, allowedBy } of paths) {
    const status = allowedBy === null ? 'OUTSIDE' : 'ALLOWED';
    const origins = layers.map(layer => layer === 'committed'
      ? `committed (${commits.map(id => id.slice(0, 12)).join(', ')})`
      : layer);
    lines.push(`  ${status.padEnd(7)} ${quote(path)}  ${origins.join(', ')}`);
  }
  const summary = lines.join('\n');
  return format === 'markdown' ? `~~~text\n${summary}\n~~~` : summary;
}
