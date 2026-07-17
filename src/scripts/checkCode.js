import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['src', 'electron', 'build'];
const files = roots.flatMap((root) => sourceFiles(path.resolve(root)));
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
  }
}

if (failed) process.exit(1);
console.log(`Checked ${files.length} JavaScript files.`);

function sourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(?:js|cjs|mjs)$/.test(entry.name) ? [fullPath] : [];
  });
}
