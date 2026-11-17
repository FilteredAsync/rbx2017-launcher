// Stamps the stylesheet and script links in public/*.html with a hash of
// their contents (?v=...). Cloudflare lets browsers keep those files for
// 4 hours; a new address after each change makes them fetch the new one at
// once. The pages themselves are never kept, so they always name the
// current files.
//
//   node site/stamp.mjs        (before pushing to site-live)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ASSETS = ['css/site.css', 'js/site.js'];

const versions = Object.fromEntries(ASSETS.map((asset) => [
  asset, crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, asset))).digest('hex').slice(0, 10),
]));

let changed = 0;
for (const name of fs.readdirSync(PUBLIC).filter((file) => file.endsWith('.html'))) {
  const file = path.join(PUBLIC, name);
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const [asset, version] of Object.entries(versions)) {
    const escaped = asset.replace(/[.]/g, '\\.');
    after = after.replace(new RegExp(`"/${escaped}(?:\\?v=[0-9a-f]+)?"`, 'g'), `"/${asset}?v=${version}"`);
  }
  if (after !== before) {
    fs.writeFileSync(file, after);
    changed++;
  }
}
console.log(`${ASSETS.map((asset) => `${asset}?v=${versions[asset]}`).join(', ')}; ${changed} page(s) updated`);
