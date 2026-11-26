// Stage only the v13 graphs and CPU packages required by this VSIX target.
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out');
const cache = path.join(output, '.modernbert-cache');
const graphs = path.join(root, 'model');
const assets = {
  'encoder.onnx': 'c2e60f521139b83b330ce8a909c9a75f5b44b3031cf9ae2f5418fd332b006f95',
  'encoder-weights-00.bin': 'c5c5b3a18727c4f0e06b985d2d5d29a81f1b05a4a1f850e6c5ed9544890b963e',
  'encoder-weights-01.bin': '5e458523ad323c76a329982a85b2e5bc8e0319aa68d458bc88b014d5ce96cb40',
  'encoder-weights-02.bin': 'd8e43af9e8df79d60c144d83a4f9270e27b3d4d44b8a133518800b2a139d95c3',
  'encoder-weights-03.bin': 'd07dd329a73e14882e046931b91b288c41842f82577f94ca0a5f9ae407d764e8',
  'encoder-weights-04.bin': '164c59cf89402c697ac62ec03eaf07b40ba069c8039fafccd6feac1c3b3ea401',
  'encoder-weights-05.bin': '2c33d82e216d52114aafbe8a26959a13edbcf364d996fb4d946759de9a746db1',
  'encoder-weights-06.bin': '9ab48e2b0c29445e1dd9c9ebe1c531818d245ccc19148b3bba820cac342fa844',
  'encoder-weights-07.bin': 'a2389f8d7a3513fee53deaa4214e9cc8d6b768d53d8da93700b2af11dfb48ba9',
  'encoder-weights-08.bin': '5acf2f17500fa7f554032ab1465fc1553eb386b77f1abf8dd69dba9bb23ca0f3',
  'plan.onnx': '0ed1ea8e1277470ffbfc3f6d653291039dd8e1df17a5fe76da5ff44605f6f839',
  'spans.onnx': '33700ad9092a3921ed44e211ef7acdb60f7f82d6e4e9865c636b19a4cfe3cd6c',
  'decoder.json': 'ddb525eaf58072462399946270204af85f4b9ee2e6e85d4acb689ee895236bb7',
  'tokenizer.json': '6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30',
};

async function* content(file) {
  if (file.bytes) {
    yield file.bytes;
  } else {
    for (const source of file.sources) yield* fs.createReadStream(source);
  }
}

async function checksum(chunks) {
  const hash = createHash('sha256');
  for await (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

async function bundleFiles() {
  const { platform, arch } = process;
  const osTag = { darwin: `darwin-${arch}`, linux: `linux-${arch}-gnu`, win32: `win32-${arch}-msvc` }[platform];
  const library = { darwin: 'libonnxruntime.1.24.3.dylib', linux: 'libonnxruntime.so.1', win32: 'onnxruntime.dll' }[platform];
  if (!osTag || !library || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported ONNX build target.');

  const files = Object.entries(assets).map(([name, pin]) => {
    const source = path.join(graphs, name);
    if (name === 'encoder-weights-00.bin') return { name, pin, sources: [source + '.0', source + '.1'] };
    if (name.endsWith('.json')) {
      // Latin-1 maps bytes one-to-one, so only CRLF pairs can change.
      return { name, pin, bytes: Buffer.from(fs.readFileSync(source, 'latin1').replace(/\r\n/g, '\n'), 'latin1') };
    }
    return { name, pin, sources: [source] };
  });
  const binding = `bin/napi-v6/${platform}/${arch}`;
  const packages = {
    'onnxruntime-node': ['dist/index.js', 'dist/backend.js', 'dist/binding.js', 'dist/version.js',
      binding + '/onnxruntime_binding.node', binding + '/' + library],
    'onnxruntime-common': ['dist/cjs/package.json'],
    tokenizers: ['index.js', 'LICENSE', `tokenizers.${osTag}.node`],
  };
  for (const [pkg, paths] of Object.entries(packages)) {
    for (const relative of ['package.json', ...paths]) {
      const name = `node_modules/${pkg}/${relative}`;
      const source = path.join(root, name);
      if (!fs.statSync(source).size) throw new Error('Empty dependency file: ' + name);
      files.push({ name, sources: [source] });
    }
  }
  const common = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [require.resolve('onnxruntime-common')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false,
    banner: { js: '/*! ONNX Runtime. Copyright (c) Microsoft Corporation. Licensed under the MIT License. */' },
  });
  files.push({ name: 'node_modules/onnxruntime-common/dist/cjs/index.js', bytes: common.outputFiles[0].contents });
  for (const file of files) {
    file.digest = await checksum(content(file));
    if (file.pin && file.pin !== file.digest) throw new Error('Unexpected artifact digest for ' + file.name);
  }
  return files;
}

async function verify(directory, files) {
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Invalid ModernBERT cache directory: ' + directory);
  const expected = new Map(files.map(file => [file.name, file.digest]));
  async function visit(relative) {
    for (const entry of await fs.promises.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(name);
      } else {
        if (!entry.isFile() || !expected.has(name) ||
            await checksum(fs.createReadStream(path.join(directory, name))) !== expected.get(name)) {
          throw new Error('Unexpected file or digest in ModernBERT cache: ' + name);
        }
        expected.delete(name);
      }
    }
  }
  await visit('');
  if (expected.size) throw new Error('Missing file in ModernBERT cache: ' + expected.keys().next().value);
}

async function prepareBundle() {
  const files = await bundleFiles();
  const key = createHash('sha256').update(JSON.stringify([process.platform, process.arch,
    files.map(({ name, digest }) => [name, digest])])).digest('hex');
  const directory = path.join(cache, key);
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(directory)) {
    const temporary = fs.mkdtempSync(path.join(cache, '.building-'));
    try {
      for (const file of files) {
        const target = path.join(temporary, file.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await pipeline(content(file), fs.createWriteStream(target, { flags: 'wx' }));
      }
      await verify(temporary, files);
      try { fs.renameSync(temporary, directory); }
      catch (error) {
        // Another build can finish first. Its published directory must validate independently.
        if (!fs.existsSync(directory)) throw error;
        await verify(directory, files);
      }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  } else {
    await verify(directory, files);
  }

  const pointer = path.join(output, 'modernbert-cache-key');
  const current = fs.existsSync(pointer) ? fs.readFileSync(pointer, 'utf8').trim() : undefined;
  if (current !== key) {
    const next = pointer + '-' + randomUUID();
    try {
      fs.writeFileSync(next, key + '\n', { flag: 'wx' });
      fs.renameSync(next, pointer);
    } finally { fs.rmSync(next, { force: true }); }
  }
  console.log(`Verified ModernBERT v13 ONNX for ${process.platform}/${process.arch} (${key})`);
  return { directory };
}

module.exports = { prepareBundle };
if (require.main === module) prepareBundle().catch(error => { console.error(error.message); process.exitCode = 1; });
