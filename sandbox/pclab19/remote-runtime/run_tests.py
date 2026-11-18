"""One bounded offline mock suite. No server, credentials, Docker daemon or GPU access."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # Also supports flattened deployed ROOT/bridge.py.
for name in ('remote-runtime', 'adapter', 'bridge'):
    sys.path.insert(0, str(ROOT / name))

if __name__ == '__main__':
    suite = unittest.TestLoader().loadTestsFromNames(['test_target_config', 'test_dcu_adapter', 'test_bridge'])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
