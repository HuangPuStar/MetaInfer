#!/usr/bin/env python3
"""Run the offline unit suites shipped with both deployment bundles.

Each site suite runs in its own interpreter so same-named modules
(dcu_adapter, target_config) cannot collide. No Docker, SSH, GPU or network
access is required.
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(label, argv, cwd):
    print('\n== %s ==' % label, flush=True)
    completed = subprocess.run([sys.executable, '-B'] + argv, cwd=str(cwd))
    if completed.returncode != 0:
        print('== %s: FAILED (exit %d) ==' % (label, completed.returncode), flush=True)
    return completed.returncode


def main():
    codes = [
        run('pclab19 (bridge + adapter + target_config)',
            ['remote-runtime/run_tests.py'], HERE / 'pclab19'),
        run('pclab27 (adapter)',
            ['-m', 'unittest', 'test_dcu_adapter'], HERE / 'pclab27' / 'adapter'),
    ]
    if any(codes):
        print('\nFAILED')
        return 1
    print('\nAll sandbox suites passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
