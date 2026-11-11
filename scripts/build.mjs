// Builds one package per browser, with zero dependencies:
//   dist/chrome/   + dist/Level67-chrome.zip    (Chrome, Edge, Brave, ...)
//   dist/firefox/  + dist/Level67-firefox.zip   (Firefox 140+)
// The code is identical; only the manifest differs.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

const TARGETS = {
  chrome: (m) => ({
    ...m,
    minimum_chrome_version: '111',
    background: { service_worker: 'background.js' },
  }),
  firefox: (m) => ({
    ...m,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'level67@purgator.github.io',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
    },
  }),
};

async function walk(dir, base = dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full, base));
    else files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files.sort();
}

// Minimal ZIP writer (deflate). Fixed timestamps keep builds reproducible.
export function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const head = Buffer.alloc(26);
    head.writeUInt16LE(20, 0); // version needed
    head.writeUInt16LE(0x0800, 2); // UTF-8 names
    head.writeUInt16LE(8, 4); // deflate
    head.writeUInt16LE(DOS_TIME, 6);
    head.writeUInt16LE(DOS_DATE, 8);
    head.writeUInt32LE(zlib.crc32(data), 10);
    head.writeUInt32LE(packed.length, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt16LE(nameBuf.length, 22);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), head, nameBuf, packed]);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    head.copy(dir, 6); // same fields as the local header
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBuf]));
    chunks.push(local);
    offset += local.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dirBuf, end]);
}

export async function build() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const base = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));
  if (base.version !== pkg.version) throw new Error(`Version mismatch: manifest ${base.version}, package.json ${pkg.version}`);
  for (const file of ['page/engine.js', 'page/ui.js']) {
    if (!(await readFile(path.join(src, file), 'utf8')).includes(`const VERSION = '${pkg.version}';`)) {
      throw new Error(`${file} does not carry version ${pkg.version}`);
    }
  }

  await rm(dist, { recursive: true, force: true });
  const out = [];
  for (const [target, manifestFor] of Object.entries(TARGETS)) {
    const dir = path.join(dist, target);
    await mkdir(dir, { recursive: true });
    await cp(src, dir, { recursive: true, filter: (f) => !/[\\/](manifest\.json|icon\.svg)$/.test(f) });
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifestFor(base), null, 2) + '\n');
    const entries = await Promise.all((await walk(dir)).map(async (name) => ({ name, data: await readFile(path.join(dir, name)) })));
    const file = path.join(dist, `Level67-${target}.zip`);
    await writeFile(file, zip(entries));
    out.push({ target, dir, file, files: entries.length });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { target, file, files } of await build()) {
    console.log(`${target.padEnd(8)} ${files} files -> ${path.relative(root, file)}`);
  }
}
