import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'author-hq-smoke-'));
process.env.DATABASE_PATH = path.join(tempRoot, 'author-hq.sqlite');

try {
  const { createDatabaseBackup, databaseHealth, initializeDatabase, sqlite } = await import('../db/index.js');
  initializeDatabase();
  const health = databaseHealth();
  if (!health.ok) throw new Error(`Database health check failed: ${health.quickCheck.join(', ')}`);
  const backup = await createDatabaseBackup({ force: true });
  if (!fs.existsSync(backup.path)) throw new Error('Database backup was not created.');
  sqlite.close();
  console.log('Database initialization, health check, and backup passed.');
} finally {
  if (tempRoot.startsWith(os.tmpdir())) fs.rmSync(tempRoot, { recursive: true, force: true });
}
