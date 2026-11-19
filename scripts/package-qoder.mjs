import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// Small, deterministic ZIP32 writer (stored entries). No npm dependencies or host commands.
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  if (entries.length >= 65535) throw new Error('Qoder ZIP 超出 ZIP32 文件数限制');
  const files = [];
  const central = [];
  let offset = 0;
  for (const { name, data, mode } of entries) {
    const filename = Buffer.from(name, 'utf8');
    if (filename.length > 65535 || data.length >= 0xffffffff) throw new Error('Qoder ZIP 超出 ZIP32 大小限制');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); // UTF-8 names; no data descriptor or compression.
    header.writeUInt16LE(33, 12); // 1980-01-01, independent of local time and source mtimes.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    files.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x314, 4); // Unix creator.
    header.copy(directory, 6, 4, 28);
    directory.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
    if (offset >= 0xffffffff) throw new Error('Qoder ZIP 超出 ZIP32 大小限制');
  }
  const directory = Buffer.concat(central);
  if (offset + directory.length >= 0xffffffff) throw new Error('Qoder ZIP 超出 ZIP32 大小限制');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}

// Qoder Desktop / CLI and Qoder IDE share one runtime but ship separate manifests and hook registrations.
export const QODER_VARIANTS = {
  qoder: { label: 'Qoder', folder: 'plugins/qoder', name: 'sysagent-agent-hooks', archive: 'sysagent-qoder-plugin' },
  'qoder-ide': { label: 'Qoder IDE', folder: 'plugins/qoder-ide', name: 'sysagent-agent-hooks-ide', archive: 'sysagent-qoder-ide-plugin', ide: true },
};
// Events and handler types documented for Qoder IDE / JetBrains (docs.qoder.com/extensions/hooks).
const IDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
  'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd', 'PreCompact', 'Notification'];
const IDE_FIELDS = ['type', 'command', 'timeout', 'if', 'async', 'asyncRewake', 'statusMessage'];

function checkIdeHooks(hooks) {
  for (const [event, groups] of Object.entries(hooks)) {
    const fail = reason => { throw new Error(`Qoder IDE hooks 违反 IDE 规则（${event}）：${reason}`); };
    if (!IDE_EVENTS.includes(event)) fail('IDE 不支持该事件');
    if (!Array.isArray(groups)) fail('事件值必须为数组');
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks) || Object.keys(group).some(key => key !== 'matcher' && key !== 'hooks')) fail('分组只允许 matcher 与 hooks');
      for (const hook of group.hooks) {
        if (!hook || hook.type !== 'command') fail('仅使用 command 类型');
        const extra = Object.keys(hook).filter(key => !IDE_FIELDS.includes(key));
        if (extra.length) fail(`IDE 未文档化的字段：${extra.join(', ')}`);
        if (typeof hook.command !== 'string' || !hook.command.trim()) fail('command 必须为非空 shell 命令');
        // A command that fails to start must never surface exit 2 (block) to the agent.
        if (!/\|\|\s*true\s*$/.test(hook.command)) fail('command 必须以 || true 结尾');
        if (!Number.isInteger(hook.timeout) || hook.timeout < 1 || hook.timeout > 30) fail('timeout 必须为显式 1-30 秒整数');
      }
    }
  }
}

// Validates inputs and returns the archive in memory, so callers can check every variant before writing any.
export function buildQoder({ root, version, variant = 'qoder' }) {
  const target = QODER_VARIANTS[variant];
  if (!target) throw new Error(`未知 Qoder 插件变体：${variant}`);
  root = resolve(root);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${target.label} 插件版本必须为 x.y.z`);
  function source(name, directory = false) {
    const file = resolve(root, name);
    const within = relative(root, file);
    if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new Error('Qoder 打包路径越界');
    // Check every component without following a symlink into local configuration or credentials.
    let current = root;
    for (const component of within.split(sep)) {
      current = resolve(current, component);
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Qoder 打包拒绝符号链接：${name}`);
    }
    const info = lstatSync(file);
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error(`Qoder 打包输入类型错误：${name}`);
    return file;
  }
  const entries = [];
  function add(name, input, mode = 0o644) {
    entries.push({ name, data: readFileSync(source(input)), mode });
  }
  // Positive allowlist: never copy a checkout, configuration directory, cache or test fixture.
  add('.qoder-plugin/plugin.json', `${target.folder}/.qoder-plugin/plugin.json`);
  add('hooks/hooks.json', `${target.folder}/hooks/hooks.json`);
  add('bin/sysagent_hook.py', `${target.folder}/bin/sysagent_hook.py`, 0o755);
  add('LICENSE', 'LICENSE');
  const manifest = JSON.parse(entries[0].data.toString('utf8'));
  if (manifest.name !== target.name || manifest.version !== version) throw new Error(`${target.label} 插件 manifest name/version 不一致`);
  if (manifest.hooks !== './hooks/hooks.json') throw new Error(`${target.label} 插件 hooks 路径必须为 ./hooks/hooks.json`);
  const hooks = JSON.parse(entries[1].data.toString('utf8'));
  if (!hooks.hooks || typeof hooks.hooks !== 'object' || Array.isArray(hooks.hooks) || !hooks.hooks.SessionStart) throw new Error(`${target.label} hooks 配置无效`);
  if (target.ide) checkIdeHooks(hooks.hooks);
  function runtime(folder, nested = false) {
    for (const entry of readdirSync(source(folder, true), { withFileTypes: true })) {
      // Runtime modules and adapters only; omit dotfiles, __pycache__, local state and secrets.
      if (!/^[a-z_][a-z0-9_]*\.py$/.test(entry.name) && !(entry.name === 'adapters' && !nested)) continue;
      if (/^(?:credentials?|secrets?|settings|local_config)(?:_|\.)/.test(entry.name)) continue;
      const input = `${folder}/${entry.name}`;
      if (entry.name === 'adapters' && !nested) runtime(input, true);
      else add(`lib/${input.slice('sysagent-agent-hooks/'.length)}`, input);
    }
  }
  runtime('sysagent-agent-hooks/sysagent_hooks');
  for (const name of ['__init__.py', 'runtime.py', 'event.py', 'spool.py', 'history.py', 'adapters/__init__.py', 'adapters/qoder.py']) {
    if (!entries.some(entry => entry.name === `lib/sysagent_hooks/${name}`)) throw new Error(`${target.label} 缺少 Python 运行时：${name}`);
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { filename: `${target.archive}-${version}.zip`, data: zip(entries) };
}

export function writeQoder(output, { filename, data }) {
  output = resolve(output);
  mkdirSync(output, { recursive: true });
  const destination = resolve(output, filename);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, data, { flag: 'wx', mode: 0o644 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return filename;
}

export function packageQoder({ output, ...options }) {
  return writeQoder(output, buildQoder(options));
}
