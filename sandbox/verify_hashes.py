#!/usr/bin/env python3
"""Verify the packaged sandbox bytes against sandbox/pins.json.

The eight pinned code files are the same bytes the Host verifies at preflight
(host/sandbox-targets.js -> codeSha256). Each site's config/target.json must
also agree with the packaged catalog byte-copy it was built against.
"""
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    pins = json.loads((HERE / 'pins.json').read_text(encoding='utf-8'))
    failures = 0
    for site, spec in sorted(pins['sites'].items()):
        print('[%s]' % site)
        for relative, expected in sorted(spec['files'].items()):
            path = HERE / site / relative
            if not path.is_file():
                print('  MISSING  %s' % relative)
                failures += 1
                continue
            actual = sha256(path)
            if actual != expected:
                print('  MISMATCH %s' % relative)
                print('           expected %s' % expected)
                print('           actual   %s' % actual)
                failures += 1
            else:
                print('  ok       %s' % relative)

        target_path = HERE / site / 'config/target.json'
        catalog_path = HERE / site / 'config/targets-catalog.json'
        try:
            target = json.loads(target_path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as error:
            print('  MISSING  config/target.json (%s)' % error)
            failures += 1
            continue
        try:
            actual_catalog = sha256(catalog_path)
        except OSError as error:
            print('  MISSING  config/targets-catalog.json (%s)' % error)
            failures += 1
            continue
        if actual_catalog != spec['configCatalogSha256']:
            print('  MISMATCH config/targets-catalog.json')
            print('           expected %s' % spec['configCatalogSha256'])
            print('           actual   %s' % actual_catalog)
            failures += 1
        elif target.get('catalogSha256') != actual_catalog:
            print('  MISMATCH config/target.json catalogSha256')
            print('           target   %s' % target.get('catalogSha256'))
            print('           catalog  %s' % actual_catalog)
            failures += 1
        elif target.get('profile') != site:
            print('  MISMATCH config/target.json profile %r != %r' % (target.get('profile'), site))
            failures += 1
        else:
            print('  ok       config/target.json -> targets-catalog.json (%s...)' % actual_catalog[:16])

    if failures:
        print('\n%d check(s) failed.' % failures)
        return 1
    print('\nAll bundled bytes match the pins.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
