#!/usr/bin/env python3
"""Qoder IDE hook entry: python3 sysagent_hook.py qoder-ide <native-event> < payload.json"""

import os
import sys

sys.dont_write_bytecode = True
_HERE = os.path.dirname(os.path.realpath(__file__))
# Packaged plugin ships the runtime in lib/; a source checkout falls back to sysagent-agent-hooks/.
for _path in (os.path.join(_HERE, '..', '..', '..', 'sysagent-agent-hooks'), os.path.join(_HERE, '..', 'lib')):
    sys.path.insert(0, os.path.normpath(_path))

try:
    from sysagent_hooks.runtime import main
except Exception:
    sys.exit(0)

sys.exit(main())
