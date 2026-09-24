import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'realaddr-package-'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run with npm run verify:package');
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', timeout: 120000 });

try {
  const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', directory], root));
  const paths = pack.files.map(file => file.path);
  for (const required of ['src/index.js', 'src/cli.js', 'src/firstname.txt', 'src/lastname.txt', 'src/countries.json', 'src/us-area-codes.json', 'licenses/i18n-iso-countries.txt']) {
    assert.ok(paths.includes(required), `Package missing ${required}`);
  }
  for (const path of paths) {
    assert.ok(path === 'package.json' || path === 'README.md' || path.startsWith('licenses/') || /^src\/[^/]+\.(js|json|txt)$/.test(path), `Unexpected package file: ${path}`);
    assert.ok(!/AIza[0-9A-Za-z_-]{35}/.test(readFileSync(join(root, path), 'utf8')), `API key in package file: ${path}`);
  }
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, pack.filename)], directory);
  const source = `
    import assert from 'node:assert/strict';
    import { createCountryProfileGenerator, generateProfileByCountry, generateProfileByProxy, InputError } from 'realaddr';
    import { createCountryProfileServer } from 'realaddr/server';
    const c = (type, text, shortText = text) => ({ types: [type], longText: text, shortText });
    const generateProfile = createCountryProfileGenerator({ apiKey: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ places: [{ addressComponents: [c('country', 'United States', 'US'), c('administrative_area_level_1', 'California', 'CA'), c('locality', 'Sample City'), c('route', 'Main Street'), c('street_number', '123'), c('postal_code', '90210')] }] }) }) });
    const fields = (await generateProfile('US')).split('|');
    assert.equal(fields.length, 10);
    assert.ok(fields.every(Boolean));
    assert.equal(fields[5], 'California');
    assert.match(fields[7], /^\\d{10}$/);
    await assert.rejects(generateProfileByCountry('XX'), InputError);
    await assert.rejects(generateProfileByCountry('8.8.8.8'), InputError);
    assert.equal(await generateProfileByProxy('http://127.0.0.1:8080', {
      apiKey: 'test-key',
      proxyFetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      fetchImpl: async () => { throw new Error('Google should not be called'); }
    }), null);
    assert.equal(createCountryProfileServer().listening, false);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: directory, timeout: 15000 });
  const cli = join(directory, 'node_modules/realaddr/src/cli.js');
  const help = execFileSync(process.execPath, [cli, '--help'], { cwd: directory, encoding: 'utf8', timeout: 15000 });
  assert.match(help, /Usage: realaddr/);
  console.log(`Package verified: ${paths.length} files, ${pack.size} bytes compressed. Installed import, generation and CLI passed offline.`);
} finally {
  // Only remove the unique temporary directory created by this script.
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
  rmSync(directory, { recursive: true, force: true });
}
