#!/usr/bin/env node
/**
 * locale/{en,zh}.json are the source of truth. This script regenerates the
 * browser bundle's dictionary region from those files; it never writes JSON.
 * The drift test (locale-selftest) fails when the bundle and JSON differ, so a
 * mutated bundle cannot be laundered back into the source.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const START = '    // #region locale-generated — source of truth: locale/{en,zh}.json; run npm run locale:sync';
const END = '    // #endregion locale-generated';

const locales = {};
for (const language of ['zh', 'en']) {
  const file = JSON.parse(await readFile(path.join(root, 'locale', `${language}.json`), 'utf8'));
  if (!file.keys || typeof file.keys !== 'object') throw new Error(`locale/${language}.json has no keys object`);
  locales[language] = file.keys;
}
const zhKeys = Object.keys(locales.zh).sort();
const enKeys = Object.keys(locales.en).sort();
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error('locale/en.json and locale/zh.json key sets differ; fix the source files first');
}

function literal(dictionary) {
  const rows = Object.keys(dictionary).sort().map((key) => `      ${JSON.stringify(key)}: ${JSON.stringify(dictionary[key])},`);
  return `{\n${rows.join('\n')}\n    }`;
}

const generated = `${START}\n    const zh = ${literal(locales.zh)};\n\n    const en = ${literal(locales.en)};\n\n${END}\n`;
const clientPath = path.join(root, 'client.js');
const client = await readFile(clientPath, 'utf8');
const start = client.indexOf(START);
const end = client.indexOf(END);
if (start < 0 || end < 0 || end < start) throw new Error('client.js locale region markers not found');
const next = client.slice(0, start) + generated + client.slice(end + END.length + 1);
await writeFile(clientPath, next, 'utf8');
console.log(`client.js: ${Object.keys(locales.zh).length} zh keys / ${Object.keys(locales.en).length} en keys generated from locale/*.json`);
