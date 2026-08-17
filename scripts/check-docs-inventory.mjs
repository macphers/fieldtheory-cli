import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const inventoryPath = 'docs/inventory.md';
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules', 'playwright-report', 'test-results']);

async function markdownFiles(directory = '.') {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory === '.' ? '' : directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...await markdownFiles(relative));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(relative);
    }
  }
  return files.sort();
}

function inventoryEntries(markdown) {
  return markdown.split('\n').flatMap((line) => {
    if (!line.startsWith('| `')) return [];
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 4) return [];
    return [{ path: cells[0].replace(/^`|`$/g, ''), purpose: cells[1], status: cells[2], freshness: cells[3] }];
  });
}

const discovered = await markdownFiles();
const entries = inventoryEntries(await readFile(path.join(root, inventoryPath), 'utf8'));
const paths = entries.map((entry) => entry.path);
const duplicates = paths.filter((value, index) => paths.indexOf(value) !== index);
const missing = discovered.filter((file) => !paths.includes(file));
const stale = paths.filter((file) => !discovered.includes(file));
const incomplete = entries.filter((entry) => !entry.purpose || !entry.status || !entry.freshness).map((entry) => entry.path);

if (duplicates.length || missing.length || stale.length || incomplete.length) {
  const sections = [
    duplicates.length ? `Duplicate inventory paths:\n- ${[...new Set(duplicates)].join('\n- ')}` : '',
    missing.length ? `Markdown files missing from ${inventoryPath}:\n- ${missing.join('\n- ')}` : '',
    stale.length ? `Inventory paths that do not exist:\n- ${stale.join('\n- ')}` : '',
    incomplete.length ? `Inventory rows missing metadata:\n- ${incomplete.join('\n- ')}` : '',
  ].filter(Boolean);
  console.error(sections.join('\n\n'));
  process.exit(1);
}

console.log(`Documentation inventory is complete (${discovered.length} Markdown files).`);
