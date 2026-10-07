import { build } from 'esbuild';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

for (const name of ['controller', 'counter', 'dates', 'status-chart', 'progress-bar',
  'burndown', 'status-pie', 'issue-list', 'user-list', 'user-leaderboard']) {
  const base = join('static', name);
  const output = join(base, 'dist');
  const entry = resolve(base, 'src.mjs');
  await mkdir(output, { recursive: true });
  await build({
    stdin: { contents: await readFile(entry, 'utf8'), resolveDir: dirname(entry), sourcefile: entry },
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    outfile: resolve(output, 'app.js'),
  });
  await cp(join(base, 'index.html'), join(output, 'index.html'));
  await cp(join('static', 'style.css'), join(output, 'style.css'));
}
