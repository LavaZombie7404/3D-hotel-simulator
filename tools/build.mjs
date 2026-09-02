// Produces a per-portal build.
//
//   node tools/build.mjs poki
//   node tools/build.mjs crazygames
//   node tools/build.mjs plain          (no SDK; what GitHub Pages serves)
//
// The only difference between them is which SDK script tag index.html carries.
// Each portal must receive a build containing its own SDK and nobody else's,
// and both of them forbid unnecessary external requests.
import { cp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SDK = {
  poki: '<script src="https://game-cdn.poki.com/scripts/v2/poki-sdk.js"></script>',
  crazygames: '<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>',
  plain: '',
};

const target = process.argv[2] || 'plain';
if (!(target in SDK)) {
  console.error(`Unknown target "${target}". Use: ${Object.keys(SDK).join(', ')}`);
  process.exit(1);
}

const out = join(ROOT, 'dist', target);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Everything the game needs at runtime, and nothing else: no tests, no
// screenshots, no node_modules.
for (const entry of ['index.html', 'src', 'vendor']) {
  await cp(join(ROOT, entry), join(out, entry), { recursive: true });
}

// Swap in this portal's SDK tag. index.html ships without one so that local
// development and the tests never talk to a portal at all.
const marker = '<!--SDK-->';
let html = await readFile(join(ROOT, 'index.html'), 'utf8');
if (!html.includes(marker)) {
  console.error(`index.html is missing the ${marker} placeholder`);
  process.exit(1);
}
html = html.replace(marker, SDK[target]);
await writeFile(join(out, 'index.html'), html, 'utf8');

// Report the size, because both portals judge on initial download.
async function measure(dir) {
  let bytes = 0, files = 0;
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) {
      const sub = await measure(p);
      bytes += sub.bytes; files += sub.files;
    } else {
      bytes += s.size; files++;
    }
  }
  return { bytes, files };
}
const { bytes, files } = await measure(out);
console.log(`dist/${target}: ${(bytes / 1024 / 1024).toFixed(2)} MB across ${files} files`);
if (SDK[target]) console.log(`  SDK: ${SDK[target].match(/src="([^"]+)"/)[1]}`);
