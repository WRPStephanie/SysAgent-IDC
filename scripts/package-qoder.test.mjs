import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageQoder } from './package-qoder.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8')).version;
const modules = ['__init__.py', '__main__.py', 'context.py', 'event.py', 'local_api.py', 'runtime.py', 'spool.py', 'history.py', 'adapters/__init__.py', 'adapters/base.py', 'adapters/qoder.py'];
const pluginFiles = ['.qoder-plugin/plugin.json', 'hooks/hooks.json', 'bin/sysagent_hook.py'];

function write(root, name, data) {
  const file = resolve(root, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'sysagent qoder ; fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['LICENSE', ...['qoder', 'qoder-ide'].flatMap(folder => pluginFiles.map(name => `plugins/${folder}/${name}`)),
    ...modules.map(name => `sysagent-agent-hooks/sysagent_hooks/${name}`)]) {
    mkdirSync(dirname(resolve(root, name)), { recursive: true });
    copyFileSync(resolve(project, name), resolve(root, name));
  }
  return { root, output: resolve(root, 'output'), version };
}

const inspectAndRun = String.raw`
import http.server, json, os, pathlib, stat, subprocess, sys, threading, zipfile
archive, root = sys.argv[1:]
root = pathlib.Path(root)
plugin = root / 'isolated' / 'plugin'
with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None, 'CRC and central directory must be valid'
    names = package.namelist()
    assert names == sorted(names) and len(names) == len(set(names))
    assert '.qoder-plugin/plugin.json' in names
    assert 'lib/sysagent_hooks/runtime.py' in names
    assert 'lib/sysagent_hooks/history.py' in names
    for name in names:
        assert not name.startswith('/') and '..' not in name.split('/') and '\\' not in name
        assert name == 'LICENSE' or name in ('.qoder-plugin/plugin.json', 'hooks/hooks.json', 'bin/sysagent_hook.py') or name.startswith('lib/sysagent_hooks/') and name.endswith('.py')
        assert not any(bad in name.lower() for bad in ('__pycache__', '.pyc', 'credential', 'secret', 'settings', 'local_config', '.ds_store', '__macosx'))
        info = package.getinfo(name)
        assert info.date_time == (1980, 1, 1, 0, 0, 0)
        assert stat.S_IMODE(info.external_attr >> 16) == (0o755 if name == 'bin/sysagent_hook.py' else 0o644)
        assert b'forbidden-local-fixture' not in package.read(name)
    manifest = json.loads(package.read('.qoder-plugin/plugin.json'))
    hooks = json.loads(package.read('hooks/hooks.json'))['hooks']
    assert manifest['name'] == 'sysagent-agent-hooks' and manifest['hooks'] == './hooks/hooks.json'
    assert len(hooks) == 20
    for native, groups in hooks.items():
        assert groups[0]['async'] == (native != 'SessionStart')
        assert groups[0]['hooks'][0]['command'] == 'python3'
        assert groups[0]['hooks'][0]['args'] == ['$' + '{QODER_PLUGIN_ROOT}/bin/sysagent_hook.py', 'qoder', native]
    package.extractall(plugin)
# Source checkout was removed by the caller: the packaged lib must be sufficient.
assert not (root / 'sysagent-agent-hooks').exists()
script = plugin / 'bin' / 'sysagent_hook.py'
sys.path.insert(0, str(plugin / 'lib'))
from sysagent_hooks.runtime import _agent_name
expected_agent = _agent_name('qoder')
spool = root / 'state' / 'sysagent' / 'agent-hooks' / 'events.jsonl'
payload = {'session_id': 'test-session', 'tool_name': 'Read', 'tool_use_id': 'call-1', 'error_type': 'timeout', 'model': 'Test',
           'prompt': 'forbidden-local-fixture', 'cwd': '/forbidden-local-fixture', 'tool_input': {'text': 'forbidden-local-fixture'},
           'tool_output': 'forbidden-local-fixture', 'error': 'forbidden-local-fixture', 'transcript_path': '/forbidden-local-fixture'}
def run(native, session='test-session'):
    result = subprocess.run([sys.executable, '-B', str(script), 'qoder', native], input=json.dumps(dict(payload, session_id=session)).encode(),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, cwd=root / 'home')
    assert result.returncode == 0 and result.stderr == b'', result.stderr
    return result.stdout
for native in hooks:
    assert run(native) == b'', 'Absent local API must not inject context; async hooks stay silent'
records = [json.loads(line) for line in spool.read_text().splitlines()]
assert len(records) == 20
assert all(row['agent'] == expected_agent and row['session_id'] == 'test-session' for row in records)
assert 'tool_failure' in [row['kind'] for row in records]
assert 'forbidden-local-fixture' not in spool.read_text()
for field in ('prompt', 'cwd', 'tool_input', 'tool_output', 'error', 'transcript_path'):
    assert all(field not in row for row in records)
assert stat.S_IMODE(spool.stat().st_mode) == 0o600
assert stat.S_IMODE(spool.parent.stat().st_mode) == 0o700
# The only endpoint is an isolated loopback fixture, not the user's discovery directory.
requests = []
instance = '11111111-1111-4111-8111-111111111111'
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append((self.command, self.path))
        assert self.headers.get('Authorization') == 'Bearer ' + 'x' * 32
        data = json.dumps({'schema_version': '1.0', 'data': {'score': 80, 'band': {'label': '测试'}, 'checked': 1, 'total': 2, 'unavailable': 1},
                           'meta': {'sampled_at': '2026-01-01T00:00:00Z', 'instance_id': instance}}).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
discovery = root / 'config' / 'sysagent-idc' / 'local-api'
discovery.parent.mkdir(parents=True, mode=0o700)
discovery.mkdir(mode=0o700)
endpoint = discovery / 'fixture.json'
endpoint.write_text(json.dumps({'base_url': 'http://127.0.0.1:%d' % server.server_port, 'token': 'x' * 32, 'pid': os.getpid(), 'instance_id': instance}))
endpoint.chmod(0o600)
try:
    injected = json.loads(run('SessionStart', 'second-session'))['hookSpecificOutput']
    assert injected['hookEventName'] == 'SessionStart'
    assert '只读缓存摘要' in injected['additionalContext']
    assert requests == [('GET', '/api/v1/summary')]
    # Another enabled copy of the plugin firing for the same SessionStart neither records nor injects again.
    assert run('SessionStart', 'second-session') == b''
    assert run('PreToolUse', 'second-session') == b''
    assert requests == [('GET', '/api/v1/summary')], 'Async and duplicate events must not query or collect'
finally:
    server.shutdown()
    server.server_close()
    thread.join()
# Reject unsafe spool permissions without repairing them or interrupting the agent.
before = spool.read_bytes()
spool.parent.chmod(0o755)
assert run('Stop', 'third-session') == b''
assert spool.read_bytes() == before and stat.S_IMODE(spool.parent.stat().st_mode) == 0o755
assert not list(plugin.rglob('__pycache__'))
recorded = [json.loads(line)['session_id'] for line in spool.read_text().splitlines()]
assert recorded.count('second-session') == 2, 'SessionStart and PreToolUse once each, duplicate SessionStart skipped'
from sysagent_hooks import history, spool as writer, event
spool.parent.chmod(0o700)
summary = history.read_summary(str(spool.parent))
assert summary['totals']['events'] == 22 and summary['totals']['sessions'] == 2
assert b'forbidden-local-fixture' not in (spool.parent / history.DATABASE).read_bytes()
for filename in (writer.CURRENT, writer.ROTATED):
    (spool.parent / filename).unlink(missing_ok=True)
assert history.read_summary(str(spool.parent)) == summary
writer.MAX_BYTES = 1
for index in range(6):
    writer.append(event.build('qoder', 'prompt_submit', session_id='second-session'), str(spool.parent))
assert history.read_summary(str(spool.parent))['totals']['events'] == 28
print(json.dumps({'entries': len(names), 'events': len(records), 'requests': requests}))
`;

// Qoder IDE runs the documented shell-form command; execute it exactly as written, through a shell.
const inspectAndRunIde = String.raw`
import json, os, pathlib, stat, subprocess, sys, zipfile
archive, root = sys.argv[1:]
root = pathlib.Path(root)
plugin = root / 'isolated' / 'ide plugin ; $(touch pwned)'
ide_events = {'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
              'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd', 'PreCompact', 'Notification'}
with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None
    names = package.namelist()
    for name in names:
        assert name == 'LICENSE' or name in ('.qoder-plugin/plugin.json', 'hooks/hooks.json', 'bin/sysagent_hook.py') or name.startswith('lib/sysagent_hooks/') and name.endswith('.py')
        assert stat.S_IMODE(package.getinfo(name).external_attr >> 16) == (0o755 if name == 'bin/sysagent_hook.py' else 0o644)
    manifest = json.loads(package.read('.qoder-plugin/plugin.json'))
    hooks = json.loads(package.read('hooks/hooks.json'))['hooks']
    assert manifest['name'] == 'sysagent-agent-hooks-ide' and manifest['hooks'] == './hooks/hooks.json'
    assert set(hooks) == ide_events
    for native, [group] in hooks.items():
        [hook] = group['hooks']
        assert list(group) == ['hooks'] and 'args' not in hook and hook['type'] == 'command'
        assert hook['command'] == 'python3 "$' + '{QODER_PLUGIN_ROOT}/bin/sysagent_hook.py" qoder-ide %s || true' % native
        assert hook.get('async', False) == (native != 'SessionStart') and 1 <= hook['timeout'] <= 3
    package.extractall(plugin)
assert not (root / 'sysagent-agent-hooks').exists()
sys.path.insert(0, str(plugin / 'lib'))
from sysagent_hooks.runtime import _agent_name
expected_agent = _agent_name('qoder-ide')
spool = root / 'state' / 'sysagent' / 'agent-hooks' / 'events.jsonl'
payload = json.dumps({'session_id': 'ide-session', 'tool_name': 'Read', 'prompt': 'forbidden-local-fixture'}).encode()
def run(native, plugin_root):
    env = dict(os.environ)
    if plugin_root:
        env['QODER_PLUGIN_ROOT'] = str(plugin_root)
    result = subprocess.run(['/bin/sh', '-c', hooks[native][0]['hooks'][0]['command']], input=payload, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, cwd=root / 'home')
    assert result.returncode == 0, result.stderr
    return result
for native in hooks:
    result = run(native, plugin)
    assert result.stdout == b'' and result.stderr == b'', result.stderr
records = [json.loads(line) for line in spool.read_text().splitlines()]
assert all(row['agent'] == expected_agent and row['session_id'] == 'ide-session' for row in records)
assert 'forbidden-local-fixture' not in spool.read_text()
# An unset or wrong plugin root makes python3 exit 2 (block); the command must still exit 0 and record nothing.
run('PreToolUse', None)
run('PreToolUse', root / 'missing')
assert len(spool.read_text().splitlines()) == len(records)
assert not (root / 'home' / 'pwned').exists() and not list(plugin.rglob('__pycache__'))
from sysagent_hooks import history
summary = history.read_summary(str(spool.parent))
assert summary['totals']['events'] == 12 and summary['totals']['sessions'] == 1
spool.unlink()
assert history.read_summary(str(spool.parent)) == summary
print(json.dumps({'entries': len(names), 'events': len(records)}))
`;

test('portable ZIP has only allowlisted content and runs all hooks without source checkout or installation', t => {
  const f = fixture(t);
  for (const name of ['plugins/qoder/.env', 'plugins/qoder/settings.json', 'plugins/qoder/bin/credentials.json', 'plugins/qoder/hooks/local.json',
    'plugins/qoder/.DS_Store', 'plugins/qoder/__MACOSX/x', 'sysagent-agent-hooks/tests/test_private.py',
    'sysagent-agent-hooks/sysagent_hooks/__pycache__/runtime.pyc', 'sysagent-agent-hooks/sysagent_hooks/.env',
    'sysagent-agent-hooks/sysagent_hooks/credentials.py', 'sysagent-agent-hooks/sysagent_hooks/local_config.py',
    'sysagent-agent-hooks/sysagent_hooks/adapters/secrets.py']) write(f.root, name, 'forbidden-local-fixture');
  const name = packageQoder(f);
  const archive = resolve(f.output, name);
  const bytes = readFileSync(archive);
  assert.equal(packageQoder(f), name);
  assert.deepEqual(readFileSync(archive), bytes, 'ZIP is deterministic and never appends stale files');
  assert.deepEqual(readdirSync(f.output), [name]);
  rmSync(resolve(f.root, 'plugins'), { recursive: true });
  rmSync(resolve(f.root, 'sysagent-agent-hooks'), { recursive: true });
  mkdirSync(resolve(f.root, 'home'));
  const result = spawnSync('python3', ['-B', '-c', inspectAndRun, archive, f.root], {
    cwd: f.root, encoding: 'utf8', timeout: 30_000,
    env: { PATH: '/usr/bin:/bin', HOME: resolve(f.root, 'home'), XDG_STATE_HOME: resolve(f.root, 'state'),
      XDG_CONFIG_HOME: resolve(f.root, 'config'), PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { entries: modules.length + pluginFiles.length + 1, events: 20, requests: [['GET', '/api/v1/summary']] });
});

test('Qoder IDE ZIP follows IDE hook rules and its shell commands record qoder-ide without ever blocking', t => {
  const f = { ...fixture(t), variant: 'qoder-ide' };
  const name = packageQoder(f);
  assert.equal(name, `sysagent-qoder-ide-plugin-${version}.zip`);
  const archive = resolve(f.output, name);
  const bytes = readFileSync(archive);
  assert.equal(packageQoder(f), name);
  assert.deepEqual(readFileSync(archive), bytes);
  rmSync(resolve(f.root, 'plugins'), { recursive: true });
  rmSync(resolve(f.root, 'sysagent-agent-hooks'), { recursive: true });
  mkdirSync(resolve(f.root, 'home'));
  const result = spawnSync('python3', ['-B', '-c', inspectAndRunIde, archive, f.root], {
    cwd: f.root, encoding: 'utf8', timeout: 30_000,
    env: { PATH: '/usr/bin:/bin', HOME: resolve(f.root, 'home'), XDG_STATE_HOME: resolve(f.root, 'state'),
      XDG_CONFIG_HOME: resolve(f.root, 'config'), PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { entries: modules.length + pluginFiles.length + 1, events: 12 });
});

test('independently bundled Qoder and IDE runtimes suppress concurrent duplicate events', t => {
  const f = fixture(t);
  const archives = ['qoder', 'qoder-ide'].map(variant => resolve(f.output, packageQoder({ ...f, variant })));
  rmSync(resolve(f.root, 'plugins'), { recursive: true });
  rmSync(resolve(f.root, 'sysagent-agent-hooks'), { recursive: true });
  const result = spawnSync('python3', ['-B', '-c', String.raw`
import json, os, pathlib, stat, subprocess, sys, zipfile
root = pathlib.Path(sys.argv[1])
plugins = []
for variant, archive in zip(('qoder', 'qoder-ide'), sys.argv[2:]):
    plugin = root / variant
    with zipfile.ZipFile(archive) as package:
        assert package.testzip() is None
        package.extractall(plugin)
    plugins.append((variant, plugin / 'bin' / 'sysagent_hook.py'))
payload = b'{"session_id":"shared-session","tool_use_id":"shared-call","prompt":"private-probe-marker"}'
processes = [subprocess.Popen([sys.executable, '-B', str(script), variant, 'PreToolUse'], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE) for variant, script in plugins * 4]
for process in processes:
    stdout, stderr = process.communicate(payload, timeout=10)
    assert (process.returncode, stdout, stderr) == (0, b'', b'')
directory = root / 'state' / 'sysagent' / 'agent-hooks'
rows = [json.loads(line) for line in (directory / 'events.jsonl').read_text().splitlines()]
assert len(rows) == 1 and rows[0]['call_id'] == 'shared-call'
assert rows[0]['agent'] in ('qoder', 'qoder-ide')
for name in ('.dedup', '.dedup-key'):
    assert stat.S_IMODE((directory / name).stat().st_mode) == 0o600
assert b'private-probe-marker' not in (directory / '.dedup').read_bytes()
assert not list(root.rglob('__pycache__'))
print('ok')
`, f.root, ...archives], {
    cwd: f.root, encoding: 'utf8', timeout: 30_000,
    env: { PATH: '/usr/bin:/bin', HOME: f.root, XDG_STATE_HOME: resolve(f.root, 'state'),
      XDG_CONFIG_HOME: resolve(f.root, 'config'), PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), 'ok');
});

test('Qoder IDE packager rejects hooks that break IDE rules', t => {
  const damages = {
    'unsupported event': hooks => { hooks.StopFailure = hooks.Stop; },
    'exec form args': hooks => { hooks.Stop[0].hooks[0].args = ['x']; },
    'group async': hooks => { hooks.Stop[0].async = true; },
    'prompt handler': hooks => { hooks.Stop[0].hooks[0].type = 'prompt'; },
    'may block': hooks => { hooks.Stop[0].hooks[0].command = hooks.Stop[0].hooks[0].command.replace(/ \|\| true$/, ''); },
    'default timeout': hooks => { delete hooks.Stop[0].hooks[0].timeout; },
  };
  for (const [damage, change] of Object.entries(damages)) {
    const f = { ...fixture(t), variant: 'qoder-ide' };
    const hooksPath = resolve(f.root, 'plugins/qoder-ide/hooks/hooks.json');
    const config = JSON.parse(readFileSync(hooksPath, 'utf8'));
    change(config.hooks);
    writeFileSync(hooksPath, JSON.stringify(config));
    assert.throws(() => packageQoder(f), /Qoder IDE hooks 违反 IDE 规则/, damage);
    assert.throws(() => readdirSync(f.output), /ENOENT/, damage);
  }
  const f = { ...fixture(t), variant: 'qoder-ide' };
  assert.throws(() => packageQoder({ ...f, variant: 'qoder-jetbrains' }), /未知 Qoder 插件变体/);
  const manifestPath = resolve(f.root, 'plugins/qoder-ide/.qoder-plugin/plugin.json');
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), name: 'sysagent-agent-hooks' }));
  assert.throws(() => packageQoder(f), /Qoder IDE 插件 manifest name\/version 不一致/);
});

test('packager rejects manifest drift, missing input, malformed hooks and symlinks without an output', t => {
  for (const damage of ['version', 'name', 'hooks path', 'bad hooks', 'missing runtime', 'missing history', 'symlink entry', 'symlink runtime directory']) {
    const f = fixture(t);
    const manifestPath = resolve(f.root, 'plugins/qoder/.qoder-plugin/plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (damage === 'version') manifest.version = '0.0.1';
    if (damage === 'name') manifest.name = 'qoder';
    if (damage === 'hooks path') manifest.hooks = './missing.json';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    if (damage === 'bad hooks') write(f.root, 'plugins/qoder/hooks/hooks.json', '{}');
    if (damage === 'missing runtime') rmSync(resolve(f.root, 'sysagent-agent-hooks/sysagent_hooks/runtime.py'));
    if (damage === 'missing history') rmSync(resolve(f.root, 'sysagent-agent-hooks/sysagent_hooks/history.py'));
    if (damage === 'symlink entry') {
      rmSync(resolve(f.root, 'plugins/qoder/bin/sysagent_hook.py'));
      symlinkSync(resolve(f.root, 'LICENSE'), resolve(f.root, 'plugins/qoder/bin/sysagent_hook.py'));
    }
    if (damage === 'symlink runtime directory') {
      rmSync(resolve(f.root, 'sysagent-agent-hooks/sysagent_hooks/adapters'), { recursive: true });
      symlinkSync(resolve(f.root, 'plugins'), resolve(f.root, 'sysagent-agent-hooks/sysagent_hooks/adapters'));
    }
    assert.throws(() => packageQoder(f), undefined, damage);
    assert.throws(() => readdirSync(f.output), /ENOENT/, 'Invalid inputs must not create outputs');
  }
});
