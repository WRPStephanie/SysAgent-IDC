"""Qoder hook adapters: Qoder Desktop / CLI and Qoder IDE share one hook protocol but report as separate agents."""

import json

from .base import AgentAdapter

_KINDS = {
    'SessionStart': 'session_start',
    'SessionEnd': 'session_end',
    'UserPromptSubmit': 'prompt_submit',
    'PreToolUse': 'tool_start',
    'PostToolUse': 'tool_end',
    'PostToolUseFailure': 'tool_failure',
    'PermissionRequest': 'permission_request',
    'PermissionDenied': 'permission_denied',
    'Stop': 'turn_stop',
    'StopFailure': 'turn_failure',
    'Notification': 'notification',
    'SubagentStart': 'subagent_start',
    'SubagentStop': 'subagent_stop',
    'TaskCreated': 'task_created',
    'TaskCompleted': 'task_completed',
    'TeammateIdle': 'teammate_idle',
    'Elicitation': 'elicitation',
    'ElicitationResult': 'elicitation_result',
    'PreCompact': 'compact',
    'PostCompact': 'compact_completed',
}
_TOOL_EVENTS = ('PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied')
EVENTS = tuple(_KINDS)
# Qoder IDE / JetBrains currently document only this subset of the shared protocol.
IDE_EVENTS = ('SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
              'PermissionRequest', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'Notification')


class QoderAdapter(AgentAdapter):
    name = 'qoder'

    def normalize(self, native_event, payload):
        kind = _KINDS.get(native_event)
        if kind is None:
            return None
        fields = {'kind': kind, 'session_id': payload.get('session_id'), 'subagent': payload.get('agent_type')}
        if native_event in _TOOL_EVENTS:
            fields['tool'] = payload.get('tool_name')
            if native_event in ('PreToolUse', 'PostToolUse', 'PostToolUseFailure'):
                fields['call_id'] = payload.get('tool_use_id')
        if native_event == 'PostToolUseFailure':
            fields['error_type'] = payload.get('error_type')
            fields['interrupt'] = payload.get('is_interrupt')
        elif native_event == 'StopFailure':
            fields['error_type'] = payload.get('error_type')
        elif native_event == 'SessionStart':
            fields['model'] = payload.get('model')
        return fields

    def wants_context(self, native_event):
        return native_event == 'SessionStart'

    def render_context(self, native_event, text):
        return json.dumps({'hookSpecificOutput': {'hookEventName': native_event, 'additionalContext': text}},
                          ensure_ascii=False)


class QoderIdeAdapter(QoderAdapter):
    name = 'qoder-ide'

    def normalize(self, native_event, payload):
        if native_event not in IDE_EVENTS:
            return None
        return super(QoderIdeAdapter, self).normalize(native_event, payload)
