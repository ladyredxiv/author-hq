import { initializeDatabase, sqlite } from '../db/index.js';
import { writePublicBookExport } from '../services/publicBookExportService.js';

initializeDatabase();

const args = parseArgs(process.argv.slice(2));
if (!args.penName) {
  console.error('Usage: npm run export:books -- --pen-name=example-author [--website-dir=C:\\path\\site] [--out=C:\\path\\books.json]');
  process.exit(1);
}

try {
  const result = writePublicBookExport({
    sqlite,
    penNameKeyOrId: args.penName,
    websiteDir: args.websiteDir || '',
    outFile: args.out || ''
  });
  console.log(`Exported ${result.payload.books.length} books for ${result.payload.pen_name}`);
  console.log(`Wrote ${result.destination}`);
  if (result.warnings.length) {
    console.warn('Warnings:');
    result.warnings.forEach((warning) => console.warn(`- ${warning}`));
  }
} finally {
  sqlite.close();
}

function parseArgs(argv) {
  const out = {};
  argv.forEach((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    const value = rest.join('=');
    if (key === 'pen-name') out.penName = value;
    if (key === 'website-dir') out.websiteDir = value;
    if (key === 'out') out.out = value;
  });
  return out;
}
