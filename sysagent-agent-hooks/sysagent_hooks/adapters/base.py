"""Native hook normalization and context protocol, independent of shared storage and diagnosis."""


class AgentAdapter(object):
    name = ''

    def normalize(self, native_event, payload):
        """Return event.build() keyword arguments (without agent), or None to ignore the event."""
        raise NotImplementedError

    def wants_context(self, native_event):
        return False

    def render_context(self, native_event, text):
        """Encode context text into the agent's stdout protocol; None writes nothing."""
        return None
