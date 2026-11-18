"""Offline regressions FIRST: no network, Docker, SSH, hardware or credentials."""
from contextlib import ExitStack
from dataclasses import replace
import base64
import hashlib
import json
import re
import stat
from types import SimpleNamespace
from pathlib import Path
import unittest
from unittest.mock import patch

import target_config as t

HERE = Path(__file__).resolve().parent
CATALOG = (HERE / '../../../upstream/MetaInfer-3b7675d0e34ed97a11a8a81d838f0a16d6945141/dsh-metainfer-research-lab/host/opensandbox-targets.json').resolve()
BUNDLE_CATALOG = HERE.parent / 'config/targets-catalog.json'
FAKE_IMAGE = 'sha256:' + 'a' * 64


def catalog_bytes():
    # Deployment wins on the server; the packaged copy keeps this suite runnable
    # from a repo checkout without the external upstream tree.
    for candidate in (t.ROOT / 'config/targets-catalog.json', BUNDLE_CATALOG, CATALOG):
        if candidate.is_file():
            return candidate.read_bytes()
    raise FileNotFoundError(f'targets catalog not found near {HERE}')


def config(raw=None):
    raw = catalog_bytes() if raw is None else raw
    return {'schemaVersion': 1, 'profile': 'pclab19', 'catalogSha256': hashlib.sha256(raw).hexdigest(),
            'poolId': 'pclab2-node19-dcu-4-7', 'serverId': 'pclab19-safe-dcu',
            'owner': 'metainfer-pclab19', 'image': FAKE_IMAGE,
            'mount': {'target': '/mnt/newdata', 'uuid': '07f1fad3-38d7-49ae-8714-91a437b0d852'}}


def fixture():
    raw = catalog_bytes()
    return t.parse_target(config(raw), raw)


def native_label_values_contract(metadata):
    """Offline mirror of pinned Native validators.py:60,94-97; NOT a Native call."""
    pattern = re.compile(r"^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$")
    for key, value in metadata.items():
        if len(value) > 63 or not pattern.match(value):
            raise ValueError(f"Native metadata label value invalid for {key}: length={len(value)}")


class TargetTests(unittest.TestCase):
    def test_native_value_contract_reproduces_old_sha64_rejection(self):
        target = fixture()
        self.assertEqual(len(target.identity), 64)
        for value in (target.identity, 'a' * 64, '-bad', 'bad-', 'bad/value'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                native_label_values_contract({'metainfer.target_id': value})
        for value in ('', 'a' * 63, 'valid_label-19.0'):
            native_label_values_contract({'metainfer.target_id': value})

    def test_identity_label_preserves_all_256_bits_and_native_value_contract(self):
        target = fixture()
        self.assertEqual(target.identity, hashlib.sha256(t.canonical(config())).hexdigest())
        labels = set()
        for identity in ('0' * 64, 'f' * 64, target.identity):
            derived = replace(target, identity=identity)
            label = derived.identity_label
            self.assertEqual(len(label), 54)
            self.assertRegex(label, r'^t-[a-z2-7]{52}$')
            self.assertEqual(base64.b32decode(label[2:].upper() + '====').hex(), identity)
            self.assertEqual(derived.identity, identity)
            native_label_values_contract({'metainfer.target_id': label})
            labels.add(label)
        self.assertEqual(len(labels), 3)
        labels = {target.identity_label}
        for bit in range(256):
            altered = bytearray.fromhex(target.identity)
            altered[bit // 8] ^= 1 << (bit % 8)
            label = replace(target, identity=altered.hex()).identity_label
            self.assertEqual(base64.b32decode(label[2:].upper() + '===='), bytes(altered))
            labels.add(label)
        self.assertEqual(len(labels), 257)
        with self.assertRaises(AttributeError):
            target.identity_label = 'mutable'

    def test_catalog_is_one_way_authority_and_default_is_only_gpu4_to7(self):
        target = fixture()
        self.assertEqual(target.profile, 'pclab19')
        self.assertEqual(target.root, Path('/mnt/newdata/metainfer-opensandbox-19-20261113'))
        self.assertEqual(dict(target.bdfs), {132: '0000:85:00.0', 133: '0000:b5:00.0',
                                             134: '0000:d5:00.0', 135: '0000:f5:00.0'})
        self.assertEqual(target.physical_ids, (4, 5, 6, 7))
        with self.assertRaises(TypeError):
            target.bdfs[132] = '0000:09:00.0'

    def test_missing_digest_wrong_profile_and_mutable_mapping_fail_closed(self):
        original = config()
        for field, value in [('profile', 'pclab27'), ('image', 'mutable:tag'), ('image', None),
                             ('catalogSha256', '0' * 64), ('owner', 'opensandbox-pclab-20261111'),
                             ('poolId', 'pclab27-dcu-0-3'), ('serverId', 'pclab27-safe-dcu'),
                             ('devices', []), ('remoteRoot', '/data/old')]:
            with self.subTest(field=field, value=value), self.assertRaises(t.TargetError):
                t.parse_target(dict(original, **{field: value}), catalog_bytes())
        for key, value in [('target', '/'), ('uuid', 'other')]:
            altered = dict(original, mount=dict(original['mount'], **{key: value}))
            with self.subTest(key=key), self.assertRaises(t.TargetError):
                t.parse_target(altered, catalog_bytes())

    def test_catalog_protected_duplicate_and_alias_fields_rejected(self):
        for change in (lambda p: p['devices'][0].update(render='/dev/dri/renderD128'),
                       lambda p: p['devices'][0].update(render='/dev/dri/card5'),
                       lambda p: p['devices'][0].update(bdf='0000:85:00.0;touch x'),
                       lambda p: p['devices'][1].update(bdf=p['devices'][0]['bdf']),
                       lambda p: p.update(sshAlias='pclab'),
                       lambda p: p.update(remoteRoot='/data/metainfer-opensandbox-20261111'),
                       lambda p: p.update(extra='mutable')):
            catalog = json.loads(catalog_bytes());change(catalog['profiles']['pclab19'])
            raw = json.dumps(catalog).encode()
            with self.subTest(change=change), self.assertRaises(t.TargetError):
                t.parse_target(config(raw), raw)

    def test_mount_host_and_sysfs_guards_fail_before_side_effects(self):
        target = fixture()
        mount = {'filesystems': [{'target': '/mnt/newdata', 'source': '/dev/nvme0n1',
                 'fstype': 'ext4', 'uuid': target.mount_uuid, 'options': 'rw,nosuid,nodev,relatime'}]}
        observed = dict(hostname='m12r1n19', mount=mount, root_device=42, mount_device=42,
                        render_bdfs=dict(target.bdfs), render_devices={i: (226, i) for i in target.bdfs},
                        kfd_is_char=True, root_is_symlink=False)
        t.validate_identity(target, **observed)
        changes = [dict(hostname='m12r1n27'), dict(root_device=43), dict(root_is_symlink=True),
                   dict(mount_device=0), dict(kfd_is_char=False), dict(render_bdfs={}),
                   dict(render_devices={132: (226, 128), 133: (226, 133), 134: (226, 134), 135: (226, 135)})]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(t.TargetError):
                t.validate_identity(target, **dict(observed, **change))
        for key, value in [('target', '/'), ('uuid', 'wrong'), ('fstype', 'overlay'),
                           ('options', 'rw,relatime')]:
            wrong = {'filesystems': [dict(mount['filesystems'][0], **{key: value})]}
            with self.subTest(mount=wrong), self.assertRaises(t.TargetError):
                t.validate_identity(target, **dict(observed, mount=wrong))
        wrong_bdfs = dict(target.bdfs);wrong_bdfs[132] = '0000:09:00.0'
        with self.assertRaises(t.TargetError):
            t.validate_identity(target, **dict(observed, render_bdfs=wrong_bdfs))

    def strict_namespace_observation(self):
        target = fixture()
        parent = {'filesystems': [{'target': target.mount_target, 'uuid': target.mount_uuid,
                                  'fstype': 'ext4', 'options': 'ro,nosuid,nodev,relatime'}]}
        root = {'filesystems': [{'target': target.root.as_posix(), 'uuid': target.mount_uuid,
                                'fstype': 'ext4', 'options': 'rw,nosuid,nodev,relatime'}]}
        observed = dict(hostname='m12r1n19', mount=parent, root_mount=root,
                        root_device=42, mount_device=42, render_bdfs=dict(target.bdfs),
                        render_devices={i: (226, i) for i in target.bdfs},
                        kfd_is_char=True, root_is_symlink=False)
        return target, observed

    def test_systemd_ro_parent_accepts_only_exact_writable_root_bind(self):
        target, observed = self.strict_namespace_observation()
        t.validate_identity(target, **observed)
        # Normal direct-SSH parent remains accepted without a separate root mount.
        observed['mount']['filesystems'][0]['options'] = 'rw,nosuid,nodev,relatime'
        observed.pop('root_mount')
        t.validate_identity(target, **observed)

    def test_ro_parent_missing_ambiguous_or_rootless_proof_rejected(self):
        target, observed = self.strict_namespace_observation()
        for proof in (None, {}, {'filesystems': []}, {'filesystems': [{}]},
                      {'filesystems': [observed['root_mount']['filesystems'][0]] * 2}):
            with self.subTest(proof=proof), self.assertRaises(t.TargetError):
                t.validate_identity(target, **dict(observed, root_mount=proof))

    def test_ro_parent_wrong_effective_root_mount_or_mode_rejected(self):
        target, observed = self.strict_namespace_observation()
        original = observed['root_mount']['filesystems'][0]
        for key, value in [('target', '/'), ('target', target.mount_target),
                           ('target', target.root.as_posix() + '/child'), ('uuid', 'wrong'),
                           ('fstype', 'overlay'), ('options', 'ro,nosuid,nodev'),
                           ('options', 'rw,ro,nosuid,nodev'), ('options', 'rw,nosuid'),
                           ('options', 'rw,nodev'), ('options', 'nosuid,nodev')]:
            wrong = {'filesystems': [dict(original, **{key: value})]}
            with self.subTest(key=key, value=value), self.assertRaises(t.TargetError):
                t.validate_identity(target, **dict(observed, root_mount=wrong))
        # A contradictory explicit proof must not be ignored even if parent is rw.
        observed['mount']['filesystems'][0]['options'] = 'rw,nosuid,nodev'
        with self.assertRaises(t.TargetError):
            t.validate_identity(target, **dict(observed, root_mount={'filesystems': []}))

    def test_root_bind_never_overrides_parent_uuid_filesystem_or_options(self):
        target, observed = self.strict_namespace_observation()
        parent = observed['mount']['filesystems'][0]
        for key, value in [('target', '/'), ('uuid', 'wrong'), ('fstype', 'overlay'),
                           ('options', 'ro,nosuid'), ('options', 'ro,nodev'),
                           ('options', 'rw,ro,nosuid,nodev'), ('options', 'nosuid,nodev')]:
            wrong = {'filesystems': [dict(parent, **{key: value})]}
            with self.subTest(key=key, value=value), self.assertRaises(t.TargetError):
                t.validate_identity(target, **dict(observed, mount=wrong))

    def test_root_bind_preserves_all_physical_identity_guards(self):
        target, observed = self.strict_namespace_observation()
        for change in (dict(hostname='other'), dict(root_device=43), dict(mount_device=0),
                       dict(root_is_symlink=True), dict(render_bdfs={}), dict(render_devices={}),
                       dict(kfd_is_char=False)):
            with self.subTest(change=change), self.assertRaises(t.TargetError):
                t.validate_identity(target, **dict(observed, **change))

    def test_json_duplicate_unknown_and_missing_fields_are_rejected(self):
        with self.assertRaises(t.TargetError):
            t.strict_json(b'{"schemaVersion":1,"schemaVersion":2}')
        for key in config():
            value = config();del value[key]
            with self.subTest(key=key), self.assertRaises(t.TargetError):
                t.parse_target(value, catalog_bytes())
        for key in ('devices', 'bdfs', 'renders', 'sshAlias', 'root', 'python'):
            with self.subTest(key=key), self.assertRaises(t.TargetError):
                t.parse_target(dict(config(), **{key: {}}), catalog_bytes())
        for field in ('render', 'bdf'):
            catalog = json.loads(catalog_bytes());del catalog['profiles']['pclab19']['devices'][0][field]
            raw = json.dumps(catalog).encode()
            with self.subTest(field=field), self.assertRaises(t.TargetError):
                t.parse_target(config(raw), raw)

    def test_actual_probe_is_linux_only_no_windows_bypass(self):
        with patch.object(t.sys, 'platform', 'win32'), self.assertRaises(t.TargetError):
            t.verify_identity(fixture())

    def test_linux_probe_uses_only_metadata_and_dynamic_kfd_identity(self):
        target = fixture()
        mount = {'filesystems': [{'target': target.mount_target, 'uuid': target.mount_uuid,
                                 'fstype': 'ext4', 'options': 'rw,nosuid,nodev'}]}
        reads = {f'/sys/class/drm/renderD{i}/dev': f'226:{i}' for i in target.bdfs}
        reads['/sys/dev/char/501:0/dev'] = '501:0'

        def resolve(path, strict=False):
            key = path.as_posix()
            if key.endswith('/device'):
                minor = int(key.split('renderD')[1].split('/')[0])
                return Path('/sys/devices/' + target.bdfs[minor])
            return path

        def lstat(path):
            key = path.as_posix()
            number = 501000 if key == '/dev/kfd' else 226000 + int(key.rsplit('D', 1)[1])
            return SimpleNamespace(st_mode=stat.S_IFCHR | 0o660, st_rdev=number)

        with ExitStack() as stack:
            for obj, name, value in [(t.sys, 'platform', 'linux'), (t.Path, 'resolve', resolve),
                                    (t.Path, 'is_dir', lambda _: True), (t.Path, 'lstat', lstat),
                                    (t.Path, 'stat', lambda _: SimpleNamespace(st_dev=42)),
                                    (t.Path, 'is_symlink', lambda _: False),
                                    (t.Path, 'read_text', lambda path, **_: reads[path.as_posix()])]:
                stack.enter_context(patch.object(obj, name, value))
            stack.enter_context(patch.object(t.socket, 'gethostname', return_value='m12r1n19'))
            stack.enter_context(patch.object(t.os, 'major', lambda number: number // 1000, create=True))
            stack.enter_context(patch.object(t.os, 'minor', lambda number: number % 1000, create=True))
            opened = stack.enter_context(patch.object(t.os, 'open', side_effect=AssertionError('device open forbidden')))
            probe = stack.enter_context(patch.object(t.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout=json.dumps(mount).encode())))
            t.verify_identity(target)
            opened.assert_not_called()
            self.assertEqual(probe.call_args.args[0], ['findmnt', '--json', '--mountpoint', '/mnt/newdata',
                                                       '--output', 'TARGET,SOURCE,FSTYPE,UUID,OPTIONS'])
            reads['/sys/dev/char/501:0/dev'] = '236:0'
            with self.assertRaisesRegex(t.TargetError, 'kfd sysfs identity mismatch'):
                t.verify_identity(target)
            reads['/sys/dev/char/501:0/dev'] = '501:0'
            reads['/sys/class/drm/renderD132/dev'] = '226:128'
            with self.assertRaisesRegex(t.TargetError, 'sysfs character-device mismatch'):
                t.verify_identity(target)
            reads['/sys/class/drm/renderD132/dev'] = '226:132'
            mount['filesystems'][0]['options'] = 'ro,nosuid,nodev'
            root_mount = {'filesystems': [dict(mount['filesystems'][0], target=target.root.as_posix(),
                                               options='rw,nosuid,nodev')]}
            def findmnt(argv, **kwargs):
                proof = root_mount if argv[3] == target.root.as_posix() else mount
                return SimpleNamespace(returncode=0, stdout=json.dumps(proof).encode())
            probe.side_effect = findmnt
            probe.reset_mock()
            t.verify_identity(target)
            self.assertEqual([call.args[0][3] for call in probe.call_args_list],
                             [target.mount_target, target.root.as_posix()])
            # Missing/failed exact-root query must never fall back to trusting the parent.
            probe.side_effect = [SimpleNamespace(returncode=0, stdout=json.dumps(mount).encode()),
                                 SimpleNamespace(returncode=1, stdout=b'')]
            with self.assertRaises(t.TargetError):
                t.verify_identity(target)
            root_mount['filesystems'][0]['target'] = target.mount_target
            probe.side_effect = findmnt
            with self.assertRaises(t.TargetError):
                t.verify_identity(target)
            opened.assert_not_called()

    def test_fingerprint_binds_deployment_image_and_catalog(self):
        raw = catalog_bytes();first = fixture()
        second = t.parse_target(dict(config(raw), image='sha256:' + 'b' * 64), raw)
        self.assertNotEqual(first.identity, second.identity)
        formatted = json.dumps(json.loads(raw), separators=(',', ':')).encode()
        self.assertNotEqual(first.identity, t.parse_target(config(formatted), formatted).identity)


if __name__ == '__main__':
    unittest.main(verbosity=2)
