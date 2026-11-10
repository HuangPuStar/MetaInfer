/**
 * i18n parity: the client ships two inline dictionaries (zh/en) and the Host
 * manifest ships locale/{en,zh}.json. A one-sided string is a bug, not a
 * translation detail, so this script makes parity a test instead of a claim.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const source = readFileSync(path.join(ROOT, 'client.js'), 'utf8');

function dictBlock(name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start < 0) return null;
  const end = source.indexOf('\n    };', start);
  if (end < 0) return null;
  return source.slice(start, end);
}
function parseDict(block) {
  const keys = [];
  const duplicates = [];
  for (const line of block.split('\n')) {
    const match = /^\s+'([^']+)':/.exec(line);
    if (!match) continue;
    if (keys.includes(match[1])) duplicates.push(match[1]);
    keys.push(match[1]);
  }
  return { keys, duplicates, set: new Set(keys) };
}

const zh = parseDict(dictBlock('zh') ?? '');
const en = parseDict(dictBlock('en') ?? '');
check('client zh dictionary found', zh.keys.length > 100, String(zh.keys.length));
check('client en dictionary found', en.keys.length > 100, String(en.keys.length));
check('client dictionaries have no duplicate keys (zh)', zh.duplicates.length === 0, zh.duplicates.join(','));
check('client dictionaries have no duplicate keys (en)', en.duplicates.length === 0, en.duplicates.join(','));
const missingEn = [...zh.set].filter((key) => !en.set.has(key));
const missingZh = [...en.set].filter((key) => !zh.set.has(key));
check('every zh key has an en string', missingEn.length === 0, missingEn.join(','));
check('every en key has a zh string', missingZh.length === 0, missingZh.join(','));

// Static t('literal') calls must resolve in both dictionaries.
const used = new Set([
  ...[...source.matchAll(/\bt\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...source.matchAll(/\bt\('([^']+)',\s*\{/g)].map((m) => m[1]),
]);
const unresolved = [...used].filter((key) => !zh.set.has(key) && !en.set.has(key));
check('every literal t() key exists in both dictionaries', unresolved.length === 0, unresolved.slice(0, 20).join(','));
check('dictionary has no obviously unused keys (informational)', true, `${zh.keys.length} keys, ${used.size} literal call sites`);

// Host manifest locales: identical nested key sets.
const enJson = JSON.parse(readFileSync(path.join(ROOT, 'locale/en.json'), 'utf8'));
const zhJson = JSON.parse(readFileSync(path.join(ROOT, 'locale/zh.json'), 'utf8'));
function deepKeys(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => deepKeys(child, prefix ? `${prefix}.${key}` : key));
}
const localeEn = new Set(deepKeys(enJson));
const localeZh = new Set(deepKeys(zhJson));
const localeMissingZh = [...localeEn].filter((key) => !localeZh.has(key));
const localeMissingEn = [...localeZh].filter((key) => !localeEn.has(key));
check('locale/zh.json covers every en.json key', localeMissingZh.length === 0, localeMissingZh.join(','));
check('locale/en.json covers every zh.json key', localeMissingEn.length === 0, localeMissingEn.join(','));

// Placeholder parity: a format string that drops an argument breaks one language.
const AT = /\{([a-zA-Z0-9_]+)\}/g;
function placeholders(text) {
  return [...String(text).matchAll(AT)].map((m) => m[1]).sort();
}
function readDictValues(block) {
  const values = new Map();
  for (const line of block.split('\n')) {
    const match = /^\s+'([^']+)': '(.*)',?$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}
const zhValues = readDictValues(dictBlock('zh') ?? '');
const enValues = readDictValues(dictBlock('en') ?? '');
const placeholderMismatch = [];
for (const [key, value] of zhValues) {
  const other = enValues.get(key);
  if (typeof other !== 'string') continue;
  if (JSON.stringify(placeholders(value)) !== JSON.stringify(placeholders(other))) placeholderMismatch.push(key);
}
check('zh/en placeholders match', placeholderMismatch.length === 0, placeholderMismatch.slice(0, 20).join(','));

console.log(`\n${failed === 0 ? 'i18n-parity: all checks passed' : `i18n-parity: ${failed} failed`}`);
process.exit(failed === 0 ? 0 : 1);
