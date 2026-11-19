import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('根目录版本必须为 x.y.z');
const check = process.argv.includes('--check');
const targets = [
  ...['sysagent-idc', 'sysagent-ide-extension'].flatMap(folder => ['package.json', 'package-lock.json'].map(file => `${folder}/${file}`)),
  'plugins/qoder/.qoder-plugin/plugin.json',
  'plugins/qoder-ide/.qoder-plugin/plugin.json',
];
for (const name of targets) {
  const target = resolve(root, name);
  const data = JSON.parse(await readFile(target, 'utf8'));
  if (check && (data.version !== version || (data.packages?.[''] && data.packages[''].version !== version))) {
    throw new Error(`${name} 与根目录版本 ${version} 不一致`);
  }
  if (!check) {
    data.version = version;
    if (data.packages?.['']) data.packages[''].version = version;
    await writeFile(target, JSON.stringify(data, null, 2) + '\n');
  }
}
console.log(`${check ? 'Checked' : 'Synchronized'} all release versions: ${version}`);
