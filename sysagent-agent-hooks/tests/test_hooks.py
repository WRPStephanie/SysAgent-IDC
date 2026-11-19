import http.server
import io
import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.dont_write_bytecode = True

from sysagent_hooks import context, event, history, local_api, runtime, spool  # noqa: E402
from sysagent_hooks.adapters import ADAPTERS  # noqa: E402
from sysagent_hooks.adapters.qoder import EVENTS, IDE_EVENTS  # noqa: E402

REPO = os.path.dirname(ROOT)


class Bytes(io.BytesIO):
    pass


def records(directory, name=spool.CURRENT):
    with open(os.path.join(directory, name), encoding='ascii') as file:
        return [json.loads(line) for line in file if line.strip()]


class Temp(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.chmod(self.temp.name, 0o700)
        self.env = {'XDG_STATE_HOME': os.path.join(self.temp.name, 'state'),
                    'XDG_CONFIG_HOME': os.path.join(self.temp.name, 'config')}
        self.spool = spool.spool_directory(self.env)
        self.host_name = runtime._agent_name('qoder-ide')
        # Unit fixtures use package labels; subprocesses still exercise real host detection.
        patch = mock.patch.object(runtime, '_agent_name', side_effect=lambda package: package)
        patch.start()
        self.addCleanup(patch.stop)

    def tearDown(self):
        self.temp.cleanup()

    def hook(self, native, payload, agent='qoder'):
        out = io.StringIO()
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode('utf-8')
        self.assertEqual(runtime.main([agent, native], Bytes(data), out, self.env), 0)
        return out.getvalue()


class EventTests(unittest.TestCase):
    def test_build_keeps_only_safe_metadata(self):
        record = event.build('qoder', 'tool_failure', session_id='s-1', tool='mcp__browser-use__click',
                             call_id='call 1', error_type='x' * 129, interrupt=1, subagent=' Explore ', model='Qwen 3 Max')
        self.assertEqual(set(record), set(event.FIELDS) | {'v'})
        self.assertRegex(record['event_id'], r'^[0-9a-f]{16}$')
        self.assertRegex(record['occurred_at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')
        self.assertEqual((record['tool'], record['call_id'], record['error_type'], record['interrupt']),
                         ('mcp__browser-use__click', None, None, None))
        self.assertEqual((record['subagent'], record['model']), ('Explore', 'Qwen 3 Max'))

    def test_identifier_drops_control_characters(self):
        self.assertIsNone(event.token('session\n'))
        self.assertIsNone(event.token('session\r'))
        self.assertIsNone(event.token('session\x00'))

    def test_rejects_unknown_agent_or_kind(self):
        for agent, kind in (('Qoder', 'tool_start'), ('qoder', 'config_change'), ('', 'turn_stop')):
            with self.assertRaises(ValueError):
                event.build(agent, kind)


class HostTests(unittest.TestCase):
    def host(self, package, executables, stat_data='42 (shell ) process) S 43 0'):
        with mock.patch.object(runtime.sys, 'platform', 'linux'), \
                mock.patch.object(runtime.os, 'getppid', return_value=42), \
                mock.patch.object(runtime.os, 'readlink', side_effect=executables), \
                mock.patch('builtins.open', mock.mock_open(read_data=stat_data)):
            return runtime._agent_name(package)

    def test_verified_ide_and_app_executable_chains_override_both_packages(self):
        for package in ('qoder', 'qoder-ide'):
            self.assertEqual(self.host(package, ['/usr/bin/bash', '/opt/qoder-ide/resources/bin/Qoder',
                                                 '/opt/qoder-ide/qoder-ide']), 'qoder-ide')
            self.assertEqual(self.host(package, ['/usr/bin/bash', '/opt/Qoder/qoder']), 'qoder')

    def test_unrecognized_and_unreadable_hosts_keep_package_label(self):
        self.assertEqual(self.host('qoder', ['/tmp/qoder-ide/python3'], 'malformed'), 'qoder')
        self.assertEqual(self.host('qoder-ide', [PermissionError()], ''), 'qoder-ide')
        with mock.patch.object(runtime.os, 'getppid', return_value=42), \
                mock.patch.object(runtime.os, 'readlink', return_value='/usr/bin/bash'), \
                mock.patch('builtins.open', side_effect=FileNotFoundError()):
            self.assertEqual(runtime._agent_name('qoder-ide'), 'qoder-ide')

    def test_unreadable_executable_does_not_hide_a_readable_host_ancestor(self):
        self.assertEqual(self.host('qoder', [PermissionError(), '/opt/qoder-ide/qoder-ide']), 'qoder-ide')

    def test_ancestry_walk_and_stat_reads_are_bounded(self):
        reader = mock.mock_open(read_data='42 (shell) S 42 0')
        with mock.patch.object(runtime.os, 'getppid', return_value=42), \
                mock.patch.object(runtime.os, 'readlink', return_value='/usr/bin/bash') as link, \
                mock.patch('builtins.open', reader):
            self.assertEqual(runtime._agent_name('qoder'), 'qoder')
        self.assertEqual(link.call_count, 8)
        self.assertEqual(reader.call_count, 8)
        reader().read.assert_called_with(4096)

    def test_other_agents_and_platforms_do_not_inspect_proc(self):
        with mock.patch.object(runtime.os, 'readlink') as link:
            self.assertEqual(runtime._agent_name('other-agent'), 'other-agent')
            with mock.patch.object(runtime.sys, 'platform', 'darwin'):
                self.assertEqual(runtime._agent_name('qoder-ide'), 'qoder-ide')
            link.assert_not_called()


class QoderAdapterTests(unittest.TestCase):
    def test_every_registered_event_maps_to_a_canonical_kind(self):
        adapter = ADAPTERS['qoder']
        for name in EVENTS:
            self.assertIn(adapter.normalize(name, {})['kind'], event.KINDS)
        self.assertIsNone(adapter.normalize('ConfigChange', {}))

    def test_extended_events_keep_only_shared_metadata(self):
        adapter = ADAPTERS['qoder']
        expected = {
            'Notification': 'notification', 'TaskCreated': 'task_created', 'TaskCompleted': 'task_completed',
            'PostCompact': 'compact_completed', 'TeammateIdle': 'teammate_idle', 'Elicitation': 'elicitation',
            'ElicitationResult': 'elicitation_result',
        }
        for native, kind in expected.items():
            self.assertEqual(adapter.normalize(native, {'session_id': 's', 'agent_type': 'Explore',
                                                        'message': 'secret', 'task_subject': 'secret'}),
                             {'kind': kind, 'session_id': 's', 'subagent': 'Explore'})

    def test_tool_failure_fields(self):
        fields = ADAPTERS['qoder'].normalize('PostToolUseFailure', {
            'session_id': 'abc', 'tool_name': 'Bash', 'tool_use_id': 'toolu_1', 'error_type': 'timeout',
            'is_interrupt': True, 'agent_type': 'Explore', 'error': 'secret-value', 'tool_input': {'command': 'x'}})
        self.assertEqual(fields, {'kind': 'tool_failure', 'session_id': 'abc', 'subagent': 'Explore', 'tool': 'Bash',
                                  'call_id': 'toolu_1', 'error_type': 'timeout', 'interrupt': True})

    def test_hooks_manifest_matches_adapter(self):
        with open(os.path.join(REPO, 'plugins', 'qoder', 'hooks', 'hooks.json'), encoding='utf-8') as file:
            hooks = json.load(file)['hooks']
        self.assertEqual(set(hooks), set(EVENTS))
        for name, groups in hooks.items():
            command = groups[0]['hooks'][0]
            self.assertEqual(groups[0]['async'], name != 'SessionStart')
            self.assertEqual(command['args'], ['${QODER_PLUGIN_ROOT}/bin/sysagent_hook.py', 'qoder', name])
            self.assertLessEqual(command['timeout'], 3)


class QoderIdeAdapterTests(Temp):
    def test_ide_adapter_reports_its_own_agent_for_ide_events_only(self):
        adapter = ADAPTERS['qoder-ide']
        self.assertEqual(set(IDE_EVENTS), {'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
                                           'PostToolUseFailure', 'PermissionRequest', 'Stop', 'SubagentStart', 'SubagentStop',
                                           'PreCompact', 'Notification'})
        for name in IDE_EVENTS:
            self.assertEqual(adapter.normalize(name, {}), ADAPTERS['qoder'].normalize(name, {}))
        for name in set(EVENTS) - set(IDE_EVENTS):
            self.assertIsNone(adapter.normalize(name, {}))
        self.hook('PreToolUse', {'session_id': 's', 'tool_name': 'Read'}, agent='qoder-ide')
        self.assertEqual(records(self.spool)[-1]['agent'], 'qoder-ide')

    def test_ide_hooks_manifest_follows_ide_rules(self):
        with open(os.path.join(REPO, 'plugins', 'qoder-ide', 'hooks', 'hooks.json'), encoding='utf-8') as file:
            hooks = json.load(file)['hooks']
        self.assertEqual(set(hooks), set(IDE_EVENTS))
        for name, [group] in hooks.items():
            self.assertEqual(list(group), ['hooks'])
            [command] = group['hooks']
            self.assertEqual(command['command'], 'python3 "${QODER_PLUGIN_ROOT}/bin/sysagent_hook.py" qoder-ide %s || true' % name)
            self.assertNotIn('args', command)
            self.assertEqual(command.get('async', False), name != 'SessionStart')
            self.assertLessEqual(command['timeout'], 3)

    def shell(self, command, plugin_root):
        env = dict(os.environ, **self.env)
        env.pop('QODER_PLUGIN_ROOT', None)
        if plugin_root:
            env['QODER_PLUGIN_ROOT'] = plugin_root
        return subprocess.run(['bash', '-c', command], input=b'{"session_id":"x","prompt":"secret-value"}',
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=20)

    def test_ide_shell_command_records_and_never_blocks(self):
        with open(os.path.join(REPO, 'plugins', 'qoder-ide', 'hooks', 'hooks.json'), encoding='utf-8') as file:
            command = json.load(file)['hooks']['UserPromptSubmit'][0]['hooks'][0]['command']
        result = self.shell(command, os.path.join(REPO, 'plugins', 'qoder-ide'))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'', b''))
        self.assertEqual((records(self.spool)[-1]['agent'], records(self.spool)[-1]['kind']), (self.host_name, 'prompt_submit'))
        # Missing plugin root (python3 exits 2 on a missing script) must still exit 0 instead of blocking.
        self.assertEqual(self.shell(command, None).returncode, 0)
        self.assertEqual(self.shell(command, os.path.join(self.temp.name, 'missing')).returncode, 0)
        self.assertEqual(len(records(self.spool)), 1)


class SpoolTests(Temp):
    def test_private_append_and_rotation(self):
        spool.append(event.build('qoder', 'turn_stop'), self.spool)
        self.assertEqual(stat.S_IMODE(os.stat(self.spool).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.spool, spool.CURRENT)).st_mode), 0o600)
        with open(os.path.join(self.spool, spool.CURRENT), 'ab') as file:
            file.write(b' ' * (spool.MAX_BYTES - 50) + b'\n')
        spool.append(event.build('qoder', 'turn_stop'), self.spool)
        self.assertEqual(len(records(self.spool)), 1)
        self.assertTrue(os.path.exists(os.path.join(self.spool, spool.ROTATED)))

    def test_existing_unsafe_permissions_are_rejected_not_repaired(self):
        spool.append(event.build('qoder', 'turn_stop'), self.spool)
        os.chmod(self.spool, 0o755)
        with self.assertRaises(PermissionError):
            spool.append(event.build('qoder', 'turn_stop'), self.spool)
        self.assertEqual(stat.S_IMODE(os.stat(self.spool).st_mode), 0o755)

    def test_rotation_does_not_replace_unsafe_existing_files(self):
        spool.append(event.build('qoder', 'turn_stop'), self.spool)
        current = os.path.join(self.spool, spool.CURRENT)
        with open(current, 'ab') as file:
            file.write(b' ' * spool.MAX_BYTES)
        os.chmod(current, 0o644)
        with self.assertRaises(PermissionError):
            spool.append(event.build('qoder', 'turn_stop'), self.spool)
        self.assertFalse(os.path.exists(os.path.join(self.spool, spool.ROTATED)))
        os.chmod(current, 0o600)
        os.link(current, os.path.join(self.temp.name, 'linked'))
        with self.assertRaises(PermissionError):
            spool.append(event.build('qoder', 'turn_stop'), self.spool)

    def test_concurrent_producers_write_complete_unique_records(self):
        script = os.path.join(REPO, 'plugins', 'qoder', 'bin', 'sysagent_hook.py')
        processes = [subprocess.Popen([sys.executable, '-B', script, 'qoder', 'Stop'], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ, **self.env)) for _ in range(8)]
        for index, process in enumerate(processes):
            stdout, stderr = process.communicate(b'{"session_id":"s%d"}' % index, timeout=20)
            self.assertEqual((process.returncode, stdout, stderr), (0, b'', b''))
        rows = records(self.spool)
        self.assertEqual(len(rows), 8)
        self.assertEqual(len(set(row['event_id'] for row in rows)), 8)

    def test_concurrent_copies_of_one_event_from_both_packages_record_once(self):
        processes = [subprocess.Popen([sys.executable, '-B', os.path.join(REPO, 'plugins', folder, 'bin', 'sysagent_hook.py'), folder, 'PreToolUse'],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ, **self.env))
                     for folder in ('qoder', 'qoder-ide') * 4]
        for process in processes:
            stdout, stderr = process.communicate(b'{"session_id":"s","tool_name":"Read","tool_use_id":"call-1"}', timeout=20)
            self.assertEqual((process.returncode, stdout, stderr), (0, b'', b''))
        [row] = records(self.spool)
        self.assertEqual((row['kind'], row['call_id']), ('tool_start', 'call-1'))
        self.assertIn(row['agent'], ('qoder', 'qoder-ide'))
        for name in (spool.DEDUP, spool.DEDUP_KEY):
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.spool, name)).st_mode), 0o600)
        with open(os.path.join(self.spool, spool.DEDUP), 'rb') as file:
            self.assertNotIn(b'call-1', file.read())

    def test_failed_append_does_not_suppress_a_later_successful_copy(self):
        original = spool._open
        def fail_current(path, flags):
            if os.path.basename(path) == spool.CURRENT:
                raise PermissionError('temporary append failure')
            return original(path, flags)
        record = event.build('qoder', 'turn_stop')
        with mock.patch.object(spool, '_open', side_effect=fail_current):
            with self.assertRaises(PermissionError):
                spool.append(record, self.spool, b'one-event')
        self.assertTrue(spool.append(record, self.spool, b'one-event'))
        self.assertFalse(spool.append(record, self.spool, b'one-event'))
        self.assertEqual(len(records(self.spool)), 1)

    def test_failed_ledger_commit_keeps_saved_record_and_allows_retry(self):
        record = event.build('qoder', 'turn_stop')
        with mock.patch.object(spool, '_first_seen', side_effect=[True, OSError('ledger write failed')]):
            self.assertTrue(spool.append(record, self.spool, b'one-event'))
        self.assertTrue(spool.append(record, self.spool, b'one-event'))
        self.assertEqual(len(records(self.spool)), 2)

    def test_partial_writes_produce_complete_records_key_and_ledger(self):
        original = spool.os.write
        with mock.patch.object(spool.os, 'write', side_effect=lambda descriptor, data: original(descriptor, data[:7])):
            self.assertTrue(spool.append(event.build('qoder', 'turn_stop'), self.spool, b'one-event'))
        self.assertFalse(spool.append(event.build('qoder', 'turn_stop'), self.spool, b'one-event'))
        self.assertEqual(len(records(self.spool)), 1)
        self.assertEqual(os.stat(os.path.join(self.spool, spool.DEDUP_KEY)).st_size, 32)

    def test_submillisecond_duplicate_uses_the_same_ledger_time_precision(self):
        record = event.build('qoder', 'turn_stop')
        with mock.patch.object(spool.time, 'time', return_value=1000.0006):
            self.assertTrue(spool.append(record, self.spool, b'one-event'))
        with mock.patch.object(spool.time, 'time', return_value=1000.0007):
            self.assertFalse(spool.append(record, self.spool, b'one-event'))
        self.assertEqual(len(records(self.spool)), 1)

    def test_ledger_is_bounded_and_drops_expired_or_future_entries(self):
        with mock.patch.object(spool.time, 'time', return_value=1000.0):
            for index in range(spool.DEDUP_ENTRIES + 1):
                self.assertTrue(spool.append(event.build('qoder', 'turn_stop'), self.spool, str(index).encode('ascii')))
        ledger = os.path.join(self.spool, spool.DEDUP)
        with open(ledger, encoding='ascii') as file:
            self.assertEqual(len(file.readlines()), spool.DEDUP_ENTRIES)
        for now in (999.0, 1006.0):
            with mock.patch.object(spool.time, 'time', return_value=now):
                self.assertTrue(spool.append(event.build('qoder', 'turn_stop'), self.spool, b'256'))
        with open(ledger, encoding='ascii') as file:
            self.assertEqual(len(file.readlines()), 1)

    def test_symlink_fifo_and_hardlinked_ledgers_fail_open(self):
        for kind in ('symlink', 'fifo', 'hardlink'):
            directory = self.spool + '-' + kind
            spool._prepare(directory)
            ledger = os.path.join(directory, spool.DEDUP)
            target = os.path.join(self.temp.name, kind)
            if kind == 'fifo':
                os.mkfifo(ledger, 0o600)
            else:
                with open(target, 'wb') as file:
                    file.write(b'unchanged')
                os.chmod(target, 0o600)
                (os.symlink if kind == 'symlink' else os.link)(target, ledger)
            self.assertTrue(spool.append(event.build('qoder', 'turn_stop'), directory, b'one-event'))
            self.assertEqual(len(records(directory)), 1)
            if kind != 'fifo':
                with open(target, 'rb') as file:
                    self.assertEqual(file.read(), b'unchanged')

    def test_symlinked_spool_file_is_refused(self):
        spool.append(event.build('qoder', 'turn_stop'), self.spool)
        current = os.path.join(self.spool, spool.CURRENT)
        target = os.path.join(self.temp.name, 'elsewhere')
        os.replace(current, target)
        os.symlink(target, current)
        with self.assertRaises(OSError):
            spool.append(event.build('qoder', 'turn_stop'), self.spool)


class HistoryTests(Temp):
    def make(self, index, kind='prompt_submit', timestamp='2026-11-17T00:00:01.000Z', **metadata):
        row = event.build(metadata.pop('agent', 'qoder'), kind, occurred_at=timestamp, **metadata)
        row['event_id'] = '%016x' % index
        return row

    def seed(self, rows, name=spool.CURRENT, directory=None, padding=0):
        directory = directory or self.spool
        spool._prepare(directory)
        descriptor = spool._open(os.path.join(directory, name), os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
        with os.fdopen(descriptor, 'wb') as stream:
            for row in rows:
                stream.write((json.dumps(row, separators=(',', ':')) + '\n').encode('ascii'))
            # Write large blank padding in chunks rather than making one giant line in memory.
            while padding:
                size = min(padding, 8192)
                stream.write(b' ' * size)
                padding -= size
            stream.write(b'\n')

    def totals(self, directory=None):
        return history.read_summary(directory or self.spool)['totals']

    def test_more_than_5000_events_sessions_and_200_agents_are_not_capped(self):
        for index in range(5003):
            spool.append(self.make(index, session_id='s%d' % index, agent='agent-%d' % (index % 211)), self.spool)
        self.assertEqual(self.totals()['events'], 5003)
        self.assertEqual(self.totals()['prompts'], 5003)
        self.assertEqual(self.totals()['sessions'], 5003)
        self.assertTrue(os.path.exists(os.path.join(self.spool, spool.ROTATED)))

    def test_schema_counts_range_privacy_and_session_agent_identity(self):
        rows = [self.make(1, 'session_start', session_id='private-session'),
                self.make(2, session_id='private-session'),
                self.make(3, session_id='private-session', agent='qoder-ide'),
                self.make(4, 'tool_start', session_id='private-session', call_id='private-call'),
                self.make(5, 'tool_end', session_id='private-session', call_id='private-call'),
                self.make(6, 'tool_start', session_id='private-session', call_id='other-call'),
                self.make(7, 'tool_failure', session_id='private-session', call_id='other-call', interrupt=False),
                self.make(8, 'tool_failure', interrupt=True),
                self.make(9, 'permission_denied', timestamp='2026-11-17T00:00:00.000Z'),
                self.make(10, 'turn_failure', timestamp='2026-11-17T00:00:09.000Z'),
                self.make(11, 'tool_start', session_id='private-session', call_id='open-call'),
                self.make(12, 'tool_start', call_id='no-session'),
                self.make(13, 'tool_end', session_id='private-session')]
        for row in rows:
            spool.append(row, self.spool)
        summary = history.read_summary(self.spool)
        self.assertEqual(summary['totals'], dict(zip(history.TOTAL_KEYS, (2, 13, 2, 4, 2, 1, 1, 1, 1, 1))))
        self.assertEqual(summary['range'], {'start': rows[8]['occurred_at'], 'end': rows[9]['occurred_at']})
        self.assertEqual(summary['reason'], history.REASON)
        self.assertNotIn('scope', summary)
        connection = history.connect(self.spool, readonly=True)
        try:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone()[0], 'delete')
            columns = [(column[1], column[2]) for column in connection.execute('PRAGMA table_info(totals)')]
            self.assertEqual(columns, [('id', 'INTEGER')] + [(key, 'INTEGER') for key in history.TOTAL_KEYS] +
                             [('start', 'TEXT'), ('end', 'TEXT'), ('reason', 'TEXT'), ('status', 'TEXT')])
            for table, key in (('sessions', 'session_key'), ('calls', 'call_key'), ('events', 'fingerprint')):
                for value, in connection.execute('SELECT ' + key + ' FROM ' + table):
                    self.assertRegex(value, r'^[a-f0-9]{64}$')
        finally:
            connection.close()
        path = os.path.join(self.spool, history.DATABASE)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        with open(path, 'rb') as stream:
            data = stream.read()
        for secret in (b'private-session', b'private-call', b'open-call'):
            self.assertNotIn(secret, data)
        writer = history.connect(self.spool)
        try:
            self.assertEqual(writer.execute('PRAGMA synchronous').fetchone()[0], 2)
        finally:
            writer.close()

    def test_many_rotations_deleting_details_and_cross_rotation_pairs(self):
        with mock.patch.object(spool, 'MAX_BYTES', 550):
            spool.append(self.make(0, 'tool_start', session_id='s', call_id='c'), self.spool)
            for index in range(1, 31):
                spool.append(self.make(index, session_id='s'), self.spool)
            self.assertEqual(self.totals()['openTools'], 1)
            spool.append(self.make(31, 'tool_failure', session_id='s', call_id='c', interrupt=True), self.spool)
            before = self.totals()
            self.assertEqual((before['events'], before['sessions'], before['openTools'], before['interrupts']), (32, 1, 0, 1))
            for name in (spool.CURRENT, spool.ROTATED):
                os.unlink(os.path.join(self.spool, name))
            self.assertEqual(self.totals(), before)
            spool.append(self.make(32, session_id='s'), self.spool)
            self.assertEqual(self.totals()['events'], 33)
            self.assertEqual(self.totals()['sessions'], 1)
            spool.append(self.make(33, 'tool_start', timestamp='2026-11-17T00:00:00.000Z', session_id='s', call_id='c'), self.spool)
            self.assertEqual(self.totals()['openTools'], 0)

    def test_restart_late_events_tombstones_equal_time_and_permanent_event_dedup(self):
        end = self.make(1, 'tool_end', timestamp='2026-11-17T00:00:03.000Z', session_id='s', call_id='c')
        spool.append(end, self.spool)
        late = self.make(2, 'tool_start', timestamp='2026-11-17T00:00:01.000Z', session_id='s', call_id='c')
        script = ('import sys,json; sys.path.insert(0,sys.argv[1]); from sysagent_hooks import spool; '
                  'spool.append(json.loads(sys.argv[3]),sys.argv[2])')
        result = subprocess.run([sys.executable, '-B', '-c', script, ROOT, self.spool, json.dumps(late)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        self.assertEqual((result.returncode, result.stderr), (0, b''))
        self.assertEqual(self.totals()['openTools'], 0)
        with mock.patch.object(spool, 'MAX_BYTES', 1):
            spool.append(self.make(3, 'tool_start', timestamp=end['occurred_at'], session_id='s', call_id='c'), self.spool)
            self.assertEqual(self.totals()['openTools'], 1)
            spool.append(self.make(4, 'tool_failure', timestamp=end['occurred_at'], session_id='s', call_id='c'), self.spool)
            self.assertEqual(self.totals()['openTools'], 0)
            # Reimporting older duplicates must NOT change insertion order at equal timestamps.
            spool.append(dict(end, v=1.0), self.spool)
            self.assertEqual(self.totals()['events'], 4)
            self.assertEqual(self.totals()['openTools'], 0)
            spool.append(self.make(5, 'tool_start', timestamp='2026-11-17T00:00:04.000Z', session_id='s', call_id='c'), self.spool)
            self.assertEqual(self.totals()['openTools'], 1)
        self.assertEqual(self.totals()['sessions'], 1)
        before = self.totals()
        with self.assertRaisesRegex(ValueError, 'conflicting'):
            spool.append(dict(end, tool='different'), self.spool, b'one-event')
        self.assertEqual(self.totals(), before)
        connection = history.connect(self.spool, readonly=True)
        try:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM calls').fetchone()[0], 1)
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM events').fetchone()[0], 5)
        finally:
            connection.close()

    def test_initial_import_has_no_total_byte_or_event_cap_but_bounded_readline(self):
        rows = (self.make(index, session_id='s%d' % index) for index in range(6001))
        self.seed(rows, padding=3 * 1024 * 1024)
        original = os.fdopen

        class LimitedReader:
            def __init__(self, descriptor, mode):
                self.stream = original(descriptor, mode)
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def __getattr__(self, key):
                return getattr(self.stream, key)
            def readline(self, size):
                if size != spool.MAX_LINE + 1:
                    raise AssertionError('unbounded history readline')
                return self.stream.readline(size)

        with mock.patch.object(history.os, 'fdopen', side_effect=LimitedReader):
            spool.append(self.make(6001, session_id='new'), self.spool)
        self.assertEqual(self.totals()['events'], 6002)
        self.assertEqual(self.totals()['sessions'], 6002)
        self.assertEqual(len(records(self.spool)), 1)

    def test_oversized_nonblank_invalid_and_conflicting_legacy_lines_fail_explicitly(self):
        variants = ((b' ' * (spool.MAX_LINE + 20) + b'{}\n'), b'{not-json}\n',
                    (json.dumps(dict(self.make(1), prompt='must-not-persist')) + '\n').encode('ascii'),
                    (json.dumps(self.make(1)) + '\n' + json.dumps(dict(self.make(1), kind='turn_stop')) + '\n').encode('ascii'))
        for index, data in enumerate(variants):
            directory = self.spool + '-bad%d' % index
            self.seed([], directory=directory)
            path = os.path.join(directory, spool.CURRENT)
            with open(path, 'wb') as stream:
                stream.write(data)
            with self.assertRaises(ValueError):
                spool.append(self.make(2), directory)
            with self.assertRaises((ValueError, sqlite3.DatabaseError)):
                history.read_summary(directory)
            with open(path, 'rb') as stream:
                self.assertEqual(stream.read(), data)
            connection = history.connect(directory, readonly=True)
            try:
                self.assertEqual(connection.execute('SELECT events, status FROM totals').fetchone(), (0, 'invalid'))
            finally:
                connection.close()
            with open(path, 'wb') as stream:
                stream.write((json.dumps(self.make(1)) + '\n').encode('ascii'))
            spool.append(self.make(2), directory)
            with self.assertRaisesRegex(ValueError, 'unknown'):
                history.read_summary(directory)

    def test_invalid_delta_keeps_prior_totals_unknown_after_details_are_removed(self):
        spool.append(self.make(1), self.spool)
        path = os.path.join(self.spool, spool.CURRENT)
        size = os.stat(path).st_size
        with open(path, 'ab') as stream:
            stream.write(b'{}\n')
        with self.assertRaises(ValueError):
            spool.append(self.make(2), self.spool)
        with self.assertRaisesRegex(ValueError, 'unknown'):
            history.read_summary(self.spool)
        connection = history.connect(self.spool, readonly=True)
        try:
            self.assertEqual(connection.execute('SELECT events, status FROM totals').fetchone(), (1, 'invalid'))
        finally:
            connection.close()
        with open(path, 'r+b') as stream:
            stream.truncate(size)
        spool.append(self.make(2), self.spool)
        with self.assertRaisesRegex(ValueError, 'unknown'):
            history.read_summary(self.spool)
        os.unlink(path)
        spool.append(self.make(3), self.spool)
        with self.assertRaisesRegex(ValueError, 'unknown'):
            history.read_summary(self.spool)
        connection = history.connect(self.spool, readonly=True)
        try:
            self.assertEqual(connection.execute('SELECT events, status FROM totals').fetchone(), (3, 'invalid'))
        finally:
            connection.close()

    def test_incremental_cursor_inode_replacement_and_truncation(self):
        spool.append(self.make(1), self.spool)
        original = history._apply
        with mock.patch.object(history, '_apply', wraps=original) as apply:
            spool.append(self.make(2), self.spool)
            self.assertEqual(apply.call_count, 1)
        path = os.path.join(self.spool, spool.CURRENT)
        with open(path, 'ab') as stream:
            stream.write((json.dumps(self.make(3)) + '\n').encode('ascii'))
        with mock.patch.object(history, '_apply', wraps=original) as apply:
            spool.append(self.make(4), self.spool)
            self.assertEqual(apply.call_count, 2)
        # A shorter file with the same inode must be rescanned from zero.
        self.seed([self.make(5)])
        spool.append(self.make(6), self.spool)
        self.assertEqual(self.totals()['events'], 6)
        os.replace(path, os.path.join(self.spool, spool.ROTATED))
        self.seed([self.make(7), self.make(8)])
        spool.append(self.make(9), self.spool)
        self.assertEqual(self.totals()['events'], 9)

    def test_changed_content_at_same_inode_and_greater_size_rescans_before_old_cursor(self):
        spool.append(self.make(1), self.spool)
        path = os.path.join(self.spool, spool.CURRENT)
        before = os.stat(path)
        replacement = self.make(2, session_id='long-session-' + 'x' * 100)
        self.seed([replacement])
        after = os.stat(path)
        self.assertEqual((before.st_dev, before.st_ino), (after.st_dev, after.st_ino))
        self.assertGreater(after.st_size, before.st_size)
        spool.append(self.make(3), self.spool)
        self.assertEqual(self.totals()['events'], 3)
        self.assertEqual(self.totals()['sessions'], 1)
        connection = history.connect(self.spool, readonly=True)
        try:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM events').fetchone()[0], 3)
        finally:
            connection.close()

    def test_migration_commits_before_rotation_overwrite_and_failed_append(self):
        self.seed([self.make(1)], spool.ROTATED)
        self.seed([self.make(2)])
        with mock.patch.object(spool, 'MAX_BYTES', 1), \
                mock.patch.object(spool, '_write_all', side_effect=OSError('crashed after rotation')):
            with self.assertRaises(OSError):
                spool.append(self.make(3), self.spool)
        self.assertEqual(self.totals()['events'], 2)
        self.assertEqual([row['event_id'] for row in records(self.spool, spool.ROTATED)], [self.make(2)['event_id']])
        spool.append(self.make(3), self.spool)
        self.assertEqual(self.totals()['events'], 3)

    def test_append_fsynced_then_count_transaction_failure_retry_does_not_lose_or_double_count(self):
        row = self.make(1)
        original = history._apply
        def fail_after_count(connection, record):
            original(connection, record)
            raise OSError('crash before count commit')
        with mock.patch.object(history, '_apply', side_effect=fail_after_count):
            with self.assertRaises(OSError):
                spool.append(row, self.spool, b'one-event')
        self.assertEqual(records(self.spool), [row])
        self.assertEqual(self.totals()['events'], 0)
        self.assertEqual(os.stat(os.path.join(self.spool, spool.DEDUP)).st_size, 0)
        with mock.patch.object(spool, 'MAX_BYTES', 1):
            self.assertTrue(spool.append(row, self.spool, b'one-event'))
            self.assertEqual(self.totals()['events'], 1)
            self.assertFalse(spool.append(row, self.spool, b'one-event'))
            spool.append(self.make(2), self.spool)
        self.assertEqual(self.totals()['events'], 2)
        self.assertEqual(self.totals()['prompts'], 2)

    def test_database_and_every_sidecar_refuse_symlink_hardlink_mode_fifo_without_repair(self):
        for suffix in ('', '-journal', '-wal', '-shm'):
            for kind in ('symlink', 'hardlink', 'mode', 'fifo'):
                directory = self.spool + '-unsafe' + suffix + '-' + kind
                spool.append(self.make(1), directory)
                path = os.path.join(directory, history.DATABASE + suffix)
                target = os.path.join(self.temp.name, 'target' + suffix + '-' + kind)
                if suffix == '':
                    os.replace(path, target)
                else:
                    with open(target, 'wb') as stream:
                        stream.write(b'unchanged')
                    os.chmod(target, 0o600)
                if kind in ('symlink', 'hardlink'):
                    (os.symlink if kind == 'symlink' else os.link)(target, path)
                elif kind == 'fifo':
                    os.mkfifo(path, 0o600)
                else:
                    os.replace(target, path)
                    os.chmod(path, 0o644)
                before = os.lstat(path)
                start = time.monotonic()
                for action in (lambda: spool.append(self.make(2), directory), lambda: history.read_summary(directory)):
                    with self.assertRaises((OSError, PermissionError)):
                        action()
                self.assertLess(time.monotonic() - start, 2)
                after = os.lstat(path)
                self.assertEqual((before.st_ino, before.st_mode, before.st_nlink),
                                 (after.st_ino, after.st_mode, after.st_nlink))
                self.assertEqual(len(records(directory)), 1)
                if suffix and kind in ('symlink', 'hardlink'):
                    with open(target, 'rb') as stream:
                        self.assertEqual(stream.read(), b'unchanged')

    def test_unsafe_database_and_sidecar_uid_is_refused(self):
        spool.append(self.make(1), self.spool)
        original = os.fstat
        for suffix in ('', '-journal', '-wal', '-shm'):
            path = os.path.join(self.spool, history.DATABASE + suffix)
            if suffix:
                descriptor = spool._open(path, os.O_WRONLY | os.O_CREAT)
                os.close(descriptor)
            identity = os.stat(path).st_ino
            def wrong_owner(descriptor):
                info = original(descriptor)
                if info.st_ino == identity:
                    values = list(info)
                    values[4] = os.getuid() + 1
                    return os.stat_result(values)
                return info
            with mock.patch.object(spool.os, 'fstat', side_effect=wrong_owner):
                with self.assertRaises(PermissionError):
                    spool.append(self.make(2), self.spool)
                with self.assertRaises(PermissionError):
                    history.read_summary(self.spool)
            if suffix:
                os.unlink(path)
        self.assertEqual(self.totals()['events'], 1)

    def test_fifo_lock_and_detail_are_nonblocking_and_not_replaced(self):
        for name in (spool.LOCK, spool.CURRENT, spool.ROTATED):
            directory = self.spool + '-fifo-' + name
            spool._prepare(directory)
            path = os.path.join(directory, name)
            os.mkfifo(path, 0o600)
            start = time.monotonic()
            with self.assertRaises(PermissionError):
                spool.append(self.make(1), directory)
            self.assertLess(time.monotonic() - start, 2)
            self.assertTrue(stat.S_ISFIFO(os.lstat(path).st_mode))

    def test_legacy_identical_duplicates_and_unterminated_record_are_normalized(self):
        row = self.make(1)
        self.seed([row], spool.ROTATED)
        self.seed([dict(row, v=1.0)])
        path = os.path.join(self.spool, spool.CURRENT)
        with open(path, 'wb') as stream:
            stream.write(json.dumps(dict(row, v=1.0)).encode('ascii'))
        spool.append(self.make(2), self.spool)
        self.assertEqual(self.totals()['events'], 2)
        self.assertEqual(len(records(self.spool)), 2)
        self.assertEqual(self.totals()['sessions'], 0)

    def test_readonly_missing_database_does_not_create_zero_history(self):
        spool._prepare(self.spool)
        with self.assertRaises(FileNotFoundError):
            history.read_summary(self.spool)
        self.assertFalse(os.path.exists(os.path.join(self.spool, history.DATABASE)))

    def test_int64_overflow_is_explicit_not_saturated_or_float(self):
        spool.append(self.make(1), self.spool)
        connection = history.connect(self.spool)
        try:
            connection.execute('UPDATE totals SET events = ?', (history.MAX_INTEGER,))
        finally:
            connection.close()
        with self.assertRaisesRegex(OverflowError, 'int64'):
            spool.append(self.make(2), self.spool)
        with self.assertRaises(OverflowError):
            spool.append(self.make(2), self.spool)
        with self.assertRaises(ValueError):
            history.read_summary(self.spool)
        connection = history.connect(self.spool, readonly=True)
        try:
            self.assertEqual(connection.execute('SELECT events, typeof(events) FROM totals').fetchone(),
                             (history.MAX_INTEGER, 'integer'))
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM events').fetchone()[0], 1)
        finally:
            connection.close()

    def test_two_writers_with_out_of_order_tool_pairs_and_rotation(self):
        script = '''import sys
sys.path.insert(0, sys.argv[1])
from sysagent_hooks import spool, event
spool.MAX_BYTES = 700
end = int(sys.argv[3])
for index in range(80):
    row = event.build('qoder', 'tool_end' if end else 'tool_start', session_id='s%d' % (index % 3),
                      call_id='c%d' % index, occurred_at='2026-11-17T00:00:0%d.000Z' % (end + 1))
    row['event_id'] = '%016x' % (index + end * 80)
    spool.append(row, sys.argv[2])
'''
        processes = [subprocess.Popen([sys.executable, '-B', '-c', script, ROOT, self.spool, str(end)],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE) for end in (0, 1)]
        for process in processes:
            stdout, stderr = process.communicate(timeout=30)
            self.assertEqual((process.returncode, stdout, stderr), (0, b'', b''))
        totals = self.totals()
        self.assertEqual((totals['sessions'], totals['events'], totals['toolStarts'], totals['toolEnds'], totals['openTools']),
                         (3, 160, 80, 80, 0))

    def test_metadata_validator_exactly_rejects_noncanonical_fields(self):
        row = self.make(1)
        for valid in (dict(row, v=1.0), dict(row, occurred_at='0000-02-29T00:00:00.000Z'),
                      dict(row, model=' spaced label ', subagent='Agent Name')):
            event.validate(valid)
        variants = [dict(row, v=True), dict(row, v=2), dict(row, v='1'), dict(row, event_id='a' * 15),
                    dict(row, event_id='A' * 16), dict(row, agent='qoder\n'), dict(row, kind='unknown'),
                    dict(row, occurred_at='2026-02-29T00:00:00.000Z'), dict(row, occurred_at='2026-11-17T24:00:00.000Z'),
                    dict(row, occurred_at='2026-11-17T00:00:00Z'), dict(row, occurred_at='2026-11-17T00:00:00.000+00:00'),
                    dict(row, occurred_at='2026-11-17T00:00:00.000Z\n'), dict(row, interrupt=1),
                    dict(row, session_id='bad id'), dict(row, tool='Read\n'), dict(row, model='unsafe\tlabel'),
                    dict(row, prompt='secret'), {key: value for key, value in row.items() if key != 'model'}]
        for invalid in variants:
            with self.assertRaises(ValueError):
                event.validate(invalid)
            with self.assertRaises(ValueError):
                spool.append(invalid, self.spool)
        self.assertFalse(os.path.exists(self.spool))


class RuntimeTests(Temp):
    def test_records_metadata_only_and_prints_nothing_for_async_events(self):
        payload = {'session_id': 'sess-1', 'hook_event_name': 'PreToolUse', 'tool_name': 'Read', 'tool_use_id': 'toolu_9',
                   'tool_input': {'file_path': '/secret-value'}, 'cwd': '/home/x', 'transcript_path': '/t.jsonl'}
        self.assertEqual(self.hook('PreToolUse', payload), '')
        [record] = records(self.spool)
        self.assertEqual((record['agent'], record['kind'], record['tool'], record['call_id']), ('qoder', 'tool_start', 'Read', 'toolu_9'))
        with open(os.path.join(self.spool, spool.CURRENT), encoding='ascii') as file:
            text = file.read()
        for value in ('secret-value', '/home/x', '/t.jsonl', 'file_path', 'tool_input'):
            self.assertNotIn(value, text)

    def test_event_name_fallback_bad_input_and_unknown_agent_never_fail(self):
        out = io.StringIO()
        self.assertEqual(runtime.main(['qoder'], Bytes(b'{"hook_event_name":"Stop"}'), out, self.env), 0)
        self.assertEqual(records(self.spool)[-1]['kind'], 'turn_stop')
        self.assertEqual(self.hook('Stop', b'{not json'), '')
        self.assertEqual(self.hook('Stop', b'[1]'), '')
        self.assertEqual(self.hook('Stop', {}, agent='unknown'), '')
        self.assertEqual(self.hook('ConfigChange', {}), '')
        self.assertEqual(len(records(self.spool)), 3)

    def test_oversized_input_is_drained(self):
        stream = Bytes(b' ' * (runtime.MAX_INPUT + 10))
        self.assertEqual(runtime.main(['qoder', 'Stop'], stream, io.StringIO(), self.env), 0)
        self.assertEqual(stream.read(), b'')
        self.assertEqual(records(self.spool)[-1]['session_id'], None)

    def test_unwritable_spool_is_swallowed(self):
        os.makedirs(os.path.dirname(self.spool), mode=0o777)
        os.chmod(os.path.dirname(self.spool), 0o777)
        self.assertEqual(self.hook('Stop', {}), '')
        self.assertFalse(os.path.exists(self.spool))

    def test_session_start_without_local_api_prints_nothing(self):
        self.assertEqual(self.hook('SessionStart', {'session_id': 's', 'model': 'qwen'}), '')
        self.assertEqual(records(self.spool)[-1]['model'], 'qwen')

    def test_duplicates_are_scoped_to_event_payload_and_window(self):
        payload = {'session_id': 's', 'prompt': 'secret-value'}
        self.hook('UserPromptSubmit', payload)
        self.hook('UserPromptSubmit', dict(payload), agent='qoder-ide')
        self.hook('Stop', payload)
        self.hook('UserPromptSubmit', dict(payload, prompt='other'))
        self.hook('Stop', {})
        self.hook('Stop', {})
        self.assertEqual([row['kind'] for row in records(self.spool)], ['prompt_submit', 'turn_stop', 'prompt_submit', 'turn_stop', 'turn_stop'])
        with open(os.path.join(self.spool, spool.DEDUP), 'rb') as file:
            self.assertNotIn(b'secret-value', file.read())
        later = time.time() + spool.DEDUP_WINDOW + 1
        with mock.patch.object(spool.time, 'time', lambda: later):
            self.hook('UserPromptSubmit', payload)
        self.assertEqual(len(records(self.spool)), 6)

    def test_host_label_is_independent_of_which_package_records_first(self):
        with mock.patch.object(runtime, '_agent_name', return_value='qoder-ide'):
            self.hook('PreToolUse', {'session_id': 's', 'tool_use_id': 'one'}, agent='qoder')
            self.hook('PreToolUse', {'session_id': 's', 'tool_use_id': 'one'}, agent='qoder-ide')
        self.assertEqual([row['agent'] for row in records(self.spool)], ['qoder-ide'])

    def test_other_agent_family_does_not_collide_with_qoder(self):
        other = mock.Mock(name='other-agent')
        other.name = 'other-agent'
        other.normalize.return_value = {'kind': 'turn_stop', 'session_id': 's'}
        other.wants_context.return_value = False
        with mock.patch.dict(runtime.ADAPTERS, {'other-agent': other}):
            self.hook('Stop', {'session_id': 's'}, agent='qoder')
            self.hook('Stop', {'session_id': 's'}, agent='other-agent')
        self.assertEqual([row['agent'] for row in records(self.spool)], ['qoder', 'other-agent'])

    def test_unusable_dedup_ledger_records_rather_than_loses_events(self):
        self.hook('Stop', {'session_id': 's'})
        ledger = os.path.join(self.spool, spool.DEDUP)
        os.chmod(ledger, 0o644)
        self.hook('Stop', {'session_id': 's'})
        self.assertEqual(stat.S_IMODE(os.stat(ledger).st_mode), 0o644)
        os.chmod(ledger, 0o600)
        with open(os.path.join(self.spool, spool.DEDUP_KEY), 'wb') as file:
            file.write(b'short')
        self.hook('Stop', {'session_id': 's'})
        self.assertEqual(len(records(self.spool)), 3)

    def test_plugin_entry_runs_from_source_checkout(self):
        script = os.path.join(REPO, 'plugins', 'qoder', 'bin', 'sysagent_hook.py')
        env = dict(os.environ, **self.env)
        result = subprocess.run([sys.executable, script, 'qoder', 'UserPromptSubmit'], input=b'{"session_id":"x","prompt":"secret-value"}',
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=20)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'', b''))
        self.assertEqual(records(self.spool)[-1]['kind'], 'prompt_submit')


class SummaryHandler(http.server.BaseHTTPRequestHandler):
    token = 'x' * 32
    body = {}

    def do_GET(self):
        ok = self.path == '/api/v1/summary' and self.headers.get('Authorization') == 'Bearer ' + self.token
        data = json.dumps(self.body if ok else {'error': {}}).encode('utf-8')
        self.send_response(200 if ok else 401)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class ContextTests(Temp):
    def serve(self, body):
        SummaryHandler.body = body
        server = http.server.HTTPServer(('127.0.0.1', 0), SummaryHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        directory = local_api.discovery_directories(self.env)[0]
        os.makedirs(os.path.dirname(directory), mode=0o700)
        os.mkdir(directory, 0o700)
        path = os.path.join(directory, 'instance.json')
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(descriptor, 'w') as file:
            json.dump({'base_url': 'http://127.0.0.1:%d' % server.server_port, 'token': SummaryHandler.token,
                       'pid': os.getpid(), 'instance_id': '00000000-0000-4000-8000-000000000001', 'started_at': '2026-11-17T00:00:00.000Z'}, file)
        return path

    summary = {'schema_version': '1.0', 'meta': {'instance_id': '00000000-0000-4000-8000-000000000001', 'sampled_at': '2026-11-17T01:02:03.000Z'}, 'data': {
        'score': 71.6, 'band': {'label': '需要关注'}, 'checked': 9, 'total': 12, 'unavailable': 1,
        'open': [{'label': '内存\n压力'}, {'label': '磁盘'}]}}

    def test_session_start_injects_cached_summary(self):
        self.serve(self.summary)
        output = json.loads(self.hook('SessionStart', {'session_id': 's'}))
        text = output['hookSpecificOutput']['additionalContext']
        self.assertEqual(output['hookSpecificOutput']['hookEventName'], 'SessionStart')
        for part in ('2026-11-17T01:02:03.000Z', '需要关注', '评分 72', '9/12', '不可用 1', '内存 压力、磁盘', '未知项不代表正常'):
            self.assertIn(part, text)
        self.assertNotIn(SummaryHandler.token, text)

    def test_duplicate_session_start_from_another_package_injects_once(self):
        self.serve(self.summary)
        self.assertIn('additionalContext', self.hook('SessionStart', {'session_id': 's', 'source': 'startup'}, agent='qoder-ide'))
        self.assertEqual(self.hook('SessionStart', {'source': 'startup', 'session_id': 's'}), '')
        self.assertEqual([row['agent'] for row in records(self.spool)], ['qoder-ide'])

    def test_wrong_instance_response_does_not_inject(self):
        response = dict(self.summary, meta=dict(self.summary['meta'], instance_id='00000000-0000-4000-8000-000000000002'))
        self.serve(response)
        self.assertEqual(self.hook('SessionStart', {}), '')

    def test_other_events_never_query(self):
        self.serve(self.summary)
        self.assertEqual(self.hook('Stop', {}), '')

    def test_unsafe_stale_or_non_loopback_discovery_is_ignored(self):
        path = self.serve(self.summary)
        os.chmod(path, 0o644)
        self.assertEqual(local_api.endpoints(self.env), [])
        os.chmod(path, 0o600)
        with open(path, encoding='utf-8') as file:
            info = json.load(file)
        for change in ({'base_url': 'http://localhost:1'}, {'base_url': 'http://127.0.0.1:70000'}, {'token': 'short'},
                       {'base_url': info['base_url'] + '\n'}, {'token': info['token'] + '\n'},
                       {'instance_id': info['instance_id'] + '\n'}, {'pid': True}, {'pid': 2 ** 22 + 12345}):
            with open(path, 'w', encoding='utf-8') as file:
                json.dump(dict(info, **change), file)
            self.assertEqual(local_api.endpoints(self.env), [], change)

    def test_discovery_rejects_hardlinks_symlinks_and_fifos(self):
        path = self.serve(self.summary)
        linked = os.path.join(self.temp.name, 'linked')
        os.link(path, linked)
        self.assertEqual(local_api.endpoints(self.env), [])
        os.unlink(path)
        os.symlink(linked, path)
        self.assertEqual(local_api.endpoints(self.env), [])
        os.unlink(path)
        os.mkfifo(path, 0o600)
        self.assertEqual(local_api.endpoints(self.env), [])

    def test_proxy_environment_is_not_used(self):
        self.serve(self.summary)
        os.environ['http_proxy'] = 'http://127.0.0.1:9'
        try:
            self.assertIsNotNone(context.local_health_context(self.env))
        finally:
            del os.environ['http_proxy']

    def test_render_rejects_missing_data_and_bounds_length(self):
        self.assertIsNone(context.render_summary({'data': None}))
        long = dict(self.summary, data=dict(self.summary['data'], open=[{'label': 'x' * 100}] * 50))
        text = context.render_summary(long)
        self.assertLessEqual(len(text), context.MAX_CHARS)
        self.assertIn('等 50 项', text)


if __name__ == '__main__':
    unittest.main()
