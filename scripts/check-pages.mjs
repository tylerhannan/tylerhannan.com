// Checks that the browser (site.js) and scripts/ch build the same pages table. Run: node scripts/check-pages.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const pub = (f) => JSON.parse(readFileSync(root + 'public/' + f, 'utf8'));

// just enough of a browser for site.js to load
globalThis.window = globalThis;
globalThis.document = { documentElement: { dataset: {} }, addEventListener() {}, querySelector() {}, querySelectorAll: () => [] };
globalThis.localStorage = { getItem() {} };
new Function(readFileSync(root + 'public/site.js', 'utf8'))();

const emb = pub('embeddings.json');
const zero = Buffer.alloc(emb.dims || 0).toString('base64');
const browser = sitePageRows(pub('archive/posts.json'), pub('talks.json'), pub('demos.json'), pub('photos.json'), pub('writing.json'))
  .map((p) => ({ path: p.path, title: p.title, event: p.event, e: emb.vectors[p.k] || zero }));

const ch = JSON.parse(execFileSync('python3', ['-c',
  'import json, runpy, sys; print(json.dumps(runpy.run_path(sys.argv[1])["pages"]()))', root + 'scripts/ch'], { encoding: 'utf8', maxBuffer: 64e6 }));

const key = (r) => JSON.stringify([r.path, r.title, r.event ?? null, r.e]);
const bad = browser.map((r, i) => (key(r) === key(ch[i] || {}) ? null : i)).filter((i) => i !== null);
if (browser.length !== ch.length || bad.length) {
  console.error(`pages differ: site.js ${browser.length} rows, scripts/ch ${ch.length}; first mismatch at row ${bad[0]}`);
  if (bad.length) console.error(' site.js:', key(browser[bad[0]]).slice(0, 200), '\n scripts/ch:', key(ch[bad[0]] || {}).slice(0, 200));
  process.exit(1);
}
console.log(`pages: ${browser.length} rows, ${browser.filter((r) => r.e !== zero).length} with vectors, same in site.js and scripts/ch`);
