from .qoder import QoderAdapter, QoderIdeAdapter

ADAPTERS = {adapter.name: adapter for adapter in (QoderAdapter(), QoderIdeAdapter())}
