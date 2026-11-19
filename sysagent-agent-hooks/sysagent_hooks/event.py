"""Canonical metadata-only hook events, without prompts, tool I/O or transcript access."""

import binascii
import datetime
import os
import re

from . import SCHEMA_VERSION

KINDS = (
    'session_start', 'session_end', 'prompt_submit',
    'tool_start', 'tool_end', 'tool_failure',
    'permission_request', 'permission_denied',
    'turn_stop', 'turn_failure', 'notification',
    'subagent_start', 'subagent_stop', 'task_created', 'task_completed', 'teammate_idle',
    'elicitation', 'elicitation_result', 'compact', 'compact_completed',
)
AGENT_NAME = re.compile(r'^[a-z][a-z0-9-]{0,31}$')
_TOKEN = re.compile(r'^[A-Za-z0-9._:@/+-]{1,128}$')
_LABEL = re.compile(r'^[A-Za-z0-9._:@/+ -]{1,128}$')
FIELDS = ('event_id', 'agent', 'kind', 'occurred_at', 'session_id', 'tool', 'call_id',
          'error_type', 'interrupt', 'subagent', 'model')


def token(value):
    """Identifier-like value (session/tool/call/error type), otherwise None."""
    return value if isinstance(value, str) and _TOKEN.fullmatch(value) else None


def label(value):
    """Display label that may contain spaces (model/subagent names), otherwise None."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if _LABEL.fullmatch(value) else None


def flag(value):
    return value if isinstance(value, bool) else None


def now_iso():
    moment = datetime.datetime.now(datetime.timezone.utc)
    return moment.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (moment.microsecond // 1000)


_EVENT_ID = re.compile(r'^[a-f0-9]{16}$')
_TIMESTAMP = re.compile(r'^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z$')


def valid_timestamp(value):
    """Match JS Date's exact, four-digit-year canonical UTC milliseconds (including year 0000)."""
    match = _TIMESTAMP.fullmatch(value) if isinstance(value, str) else None
    if not match:
        return False
    year, month, day, hour, minute, second, _ = map(int, match.groups())
    if not 1 <= month <= 12 or hour > 23 or minute > 59 or second > 59:
        return False
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    return 1 <= day <= days[month - 1]


def validate(record):
    """Reject non-canonical metadata; return a normalized copy for permanent ID comparison."""
    if not isinstance(record, dict) or set(record) != set(FIELDS) | {'v'}:
        raise ValueError('invalid event fields')
    if type(record['v']) not in (int, float) or record['v'] != SCHEMA_VERSION:
        raise ValueError('invalid event version')
    for name, pattern in (('event_id', _EVENT_ID), ('agent', AGENT_NAME)):
        if not isinstance(record[name], str) or not pattern.fullmatch(record[name]):
            raise ValueError('invalid event identity')
    if record['kind'] not in KINDS or not valid_timestamp(record['occurred_at']):
        raise ValueError('invalid event kind or timestamp')
    for name in ('session_id', 'tool', 'call_id', 'error_type', 'subagent', 'model'):
        value = record[name]
        pattern = _LABEL if name in ('subagent', 'model') else _TOKEN
        if value is not None and (not isinstance(value, str) or not pattern.fullmatch(value)):
            raise ValueError('invalid event metadata')
    if record['interrupt'] is not None and type(record['interrupt']) is not bool:
        raise ValueError('invalid event interrupt')
    normalized = dict(record)
    normalized['v'] = SCHEMA_VERSION
    return normalized


def build(agent, kind, session_id=None, tool=None, call_id=None, error_type=None,
          interrupt=None, subagent=None, model=None, occurred_at=None):
    if not AGENT_NAME.match(agent) or kind not in KINDS:
        raise ValueError('unsupported agent or event kind')
    return {
        'v': SCHEMA_VERSION,
        'event_id': binascii.hexlify(os.urandom(8)).decode('ascii'),
        'agent': agent,
        'kind': kind,
        'occurred_at': occurred_at or now_iso(),
        'session_id': token(session_id),
        'tool': token(tool),
        'call_id': token(call_id),
        'error_type': token(error_type),
        'interrupt': flag(interrupt),
        'subagent': label(subagent),
        'model': label(model),
    }
