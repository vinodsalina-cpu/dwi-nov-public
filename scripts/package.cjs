const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { createVSIX } = require('@vscode/vsce');
const { prepareBundle } = require('./bundle-onnx.cjs');

const root = path.join(__dirname, '..');
const options = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node22',
  minify: true,
  keepNames: true,
  legalComments: 'inline',
  metafile: true,
};

// The host imports Harper on first review. Keeping this module as ESM also
// preserves the slim WASM URL relative to import.meta.url on each platform.
const lazyHarper = {
  name: 'lazy-harper',
  setup(builder) {
    builder.onResolve({ filter: /^harper\.js(?:\/slimBinary)?$/ }, () => ({
      path: './harper.mjs', external: true,
    }));
  },
};

function writeNotices(results, output) {
  const packages = new Set();
  for (const { metafile } of results) {
    for (const input of Object.keys(metafile.inputs)) {
      const match = /^((?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
      if (match) packages.add(match[1]);
    }
  }
  const notices = [];
  for (const dir of [...packages].sort()) {
    const packageDir = path.resolve(root, dir);
    const { name, version } = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const files = fs.readdirSync(packageDir).filter(file => /^(?:licen[sc]e|notice|copying)(?:[.\-].*)?$/i.test(file));
    const documents = name === 'harper.js'
      ? ['vendor/harper-LICENSE', 'vendor/harper-ranker-NOTICE']
      : files.sort().map(file => path.join(packageDir, file));
    if (!documents.length) throw new Error(`Missing third-party license for ${name}@${version}`);
    const text = documents.map(file => fs.readFileSync(path.resolve(root, file), 'utf8').trim()).join('\n\n');
    notices.push(`${name}@${version}\n\n${text}`);
  }
  notices.push('gibb@1.0.3\n\n' + fs.readFileSync(path.join(root, 'vendor/gibb-LICENSE'), 'utf8').trim());
  const ortLicense = fs.readFileSync(path.join(root, 'vendor/onnxruntime-LICENSE'), 'utf8').trim();
  const ortNotices = fs.readFileSync(path.join(root, 'vendor/onnxruntime-NOTICES'), 'utf8').trim();
  const ortVersion = require('../package.json').devDependencies['onnxruntime-node'];
  notices.push(`ONNX Runtime ${ortVersion}\n\n${ortLicense}\n\n${ortNotices}`);
  fs.writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n--------------------\n\n') + '\n');
}

async function bundleExtension(output) {
  const extension = await build({
    ...options,
    entryPoints: ['src/extension.ts', 'src/core/modernbert/worker.ts'],
    outdir: output, outbase: 'src', format: 'cjs', external: ['vscode'], plugins: [lazyHarper],
  });
  const harper = await build({
    ...options,
    stdin: {
      contents: "export { LocalLinter, Dialect, SuggestionKind } from 'harper.js';\nexport { slimBinary } from 'harper.js/slimBinary';",
      resolveDir: root,
    },
    outfile: path.join(output, 'harper.mjs'), format: 'esm',
  });
  const wasm = 'harper_wasm_slim_bg.wasm';
  fs.copyFileSync(path.join(root, 'node_modules', 'harper.js', 'dist', wasm), path.join(output, wasm));
  writeNotices([extension, harper], output);
}

async function main() {
  const native = await prepareBundle();
  const stage = fs.mkdtempSync(path.join(root, 'out', '.vsix-'));
  const output = path.join(stage, 'out');
  const target = process.platform + '-' + process.arch;
  const artifact = 'dwi-nov-' + target + '.vsix';
  try {
    for (const name of ['package.json', 'README.md', 'LICENSE', '.vscodeignore', 'media']) {
      fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
    }
    await bundleExtension(output);
    const runtime = path.join(output, 'modernbert');
    try {
      // A directory junction on Windows allows VSCE to read the cache while another process holds its DLL open.
      fs.symlinkSync(native.directory, runtime, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (!['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
      fs.cpSync(native.directory, runtime, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    }
    const temporary = path.join(stage, artifact);
    await createVSIX({
      cwd: stage, target, dependencies: false, followSymlinks: true, packagePath: temporary,
      allowMissingRepository: true, rewriteRelativeLinks: false,
    });
    fs.renameSync(temporary, path.join(root, artifact));
    console.log('Wrote ' + path.join(root, artifact));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
