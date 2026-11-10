/**
 * Locale parity is structural: the two JSON dictionaries must have identical
 * key sets and identical placeholder sets per key. Text is never compared across
 * languages, so a legitimate translation cannot fail this test — only a missing
 * or mismatched structure can.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`ok   ${name}`);
  else { failed += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const en = JSON.parse(await readFile(path.join(root, 'locale/en.json'), 'utf8'));
const zh = JSON.parse(await readFile(path.join(root, 'locale/zh.json'), 'utf8'));
const enKeys = Object.keys(en.keys).sort();
const zhKeys = Object.keys(zh.keys).sort();
check('locale files declare a namespace title', typeof en.meta?.title === 'string' && typeof zh.meta?.title === 'string');
check('en and zh key sets are identical', JSON.stringify(enKeys) === JSON.stringify(zhKeys), `${enKeys.length} vs ${zhKeys.length}`);
check('every en value is a non-empty string', enKeys.every((key) => typeof en.keys[key] === 'string' && en.keys[key].trim().length > 0));
check('every zh value is a non-empty string', zhKeys.every((key) => typeof zh.keys[key] === 'string' && zh.keys[key].trim().length > 0));
const placeholders = (value) => [...String(value ?? '').matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();
const mismatched = enKeys.filter((key) => JSON.stringify(placeholders(en.keys[key])) !== JSON.stringify(placeholders(zh.keys[key])));
check('every locale keeps the same placeholders', mismatched.length === 0, JSON.stringify(mismatched.slice(0, 5)));
check('locale covers the core navigation keys', ['panel', 'title', 'subtitle', 'intl.locale', 'common.retry'].every((key) => key in en.keys && key in zh.keys));
const dynamicPrefixes = ['ws.', 'trajectory.', 'intake.', 'wizard.'];
check('locale covers workspace and wizard families', enKeys.some((key) => key.startsWith('ws.')) && enKeys.some((key) => key.startsWith('wizard.')));
check('no locale file is a stub', enKeys.length > 1000, String(enKeys.length));

// The client bundle is generated against these files; detect drift in the
// dictionaries the browser actually registers.
const client = await readFile(path.join(root, 'client.js'), 'utf8');
function extract(name) {
  const start = client.indexOf(`const ${name} = {`);
  const open = client.indexOf('{', start);
  let depth = 0; let quote = null;
  for (let index = open; index < client.length; index += 1) {
    const char = client[index];
    if (quote) { if (char === '\\') index += 1; else if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return client.slice(open, index + 1);
  }
  throw new Error(`${name} dictionary not found`);
}
const inlineZh = Function(`return (${extract('zh')})`)();
const inlineEn = Function(`return (${extract('en')})`)();
check('client zh dictionary matches locale/zh.json', JSON.stringify(Object.keys(inlineZh).sort()) === JSON.stringify(zhKeys) && zhKeys.every((key) => inlineZh[key] === zh.keys[key]));
check('client en dictionary matches locale/en.json', JSON.stringify(Object.keys(inlineEn).sort()) === JSON.stringify(enKeys) && enKeys.every((key) => inlineEn[key] === en.keys[key]));

// Every literal t('key') in the bundle must resolve; this is the failure users see
// as a raw key in the UI.
const used = [...client.matchAll(/\bt\('([a-zA-Z0-9_.-]+)'\)/g)].map((match) => match[1]);
const missing = [...new Set(used)].filter((key) => !(key in en.keys));
check('every literal t() key is in the dictionaries', missing.length === 0, JSON.stringify(missing.slice(0, 10)));

console.log(failed === 0 ? '\nlocale-selftest: all checks passed' : `\nlocale-selftest: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
