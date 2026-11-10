#!/usr/bin/env node
/**
 * Regenerates locale/{en,zh}.json from the client dictionaries. The JSON files
 * are the reviewable source of truth for translators; this script exists so the
 * generated copy cannot drift silently (locale-selftest asserts structural
 * equality of both key sets).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function extract(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`dictionary ${name} not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced dictionary ${name}`);
}

const client = await readFile(path.join(root, 'client.js'), 'utf8');
const zh = Function(`return (${extract(client, 'zh')})`)();
const en = Function(`return (${extract(client, 'en')})`)();
const meta = JSON.parse(await readFile(path.join(root, 'locale/en.json'), 'utf8')).meta ?? {
  title: 'MetaInfer Research Lab',
  description: 'Research-experiment DAG IDE for DeepSeek Harness.',
};
for (const [file, dictionary] of [['en.json', en], ['zh.json', zh]]) {
  const sorted = Object.fromEntries(Object.keys(dictionary).sort().map((key) => [key, dictionary[key]]));
  await writeFile(path.join(root, 'locale', file), `${JSON.stringify({ meta, keys: sorted }, null, 2)}\n`, 'utf8');
  console.log(`${file}: ${Object.keys(sorted).length} keys`);
}
