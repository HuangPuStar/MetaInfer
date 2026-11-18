"""New27 fail-closed identity guard; topology is derived ONLY from the Host catalog.

No environment bypass. parse_target()/validate_identity() are pure for offline tests;
load_target() performs real Linux, mount, hostname, sysfs and character-node checks.
These probes stat nodes/read sysfs only: they do not open any GPU device.
"""
from dataclasses import dataclass
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
from types import MappingProxyType

ROOT = Path('/data/opensandbox-cluster-metainfer-20261111')
PROFILE = 'pclab27'
MOUNT_TARGET = '/data'
MOUNT_UUID = '4768d52c-06ef-4f19-9286-c4e352502a52'
ALLOWED_RENDERS = (128, 129)  # Policy boundary, NOT a second topology mapping.


class TargetError(Exception):
    pass


def require(value, message):
    if not value:
        raise TargetError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate configuration key')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except (ValueError, TypeError, UnicodeError) as exc:
        raise TargetError('invalid target/catalog JSON') from exc


@dataclass(frozen=True)
class Target:
    profile: str
    catalog_sha256: str
    root: Path
    python: str
    ssh_alias: str
    bdfs: object
    pool_id: str
    server_id: str
    owner: str
    image: str
    mount_target: str
    mount_uuid: str
    identity: str

    @property
    def identity_label(self):
        """Lossless 256-bit identity encoding within Native's 63-character label limit."""
        return 't-' + base64.b32encode(bytes.fromhex(self.identity)).decode('ascii').rstrip('=').lower()

    @property
    def physical_ids(self):
        return tuple(minor - 128 for minor in self.bdfs)

    @property
    def path_ids(self):
        return MappingProxyType({f'/dev/dri/renderD{minor}': minor - 128 for minor in self.bdfs})


def parse_target(config, catalog_bytes):
    require(type(config) is dict and set(config) == {'schemaVersion', 'profile', 'catalogSha256',
            'poolId', 'serverId', 'owner', 'image', 'mount'}, 'unexpected/missing target fields')
    require(type(config['schemaVersion']) is int and config['schemaVersion'] == 1
            and config['profile'] == PROFILE, 'target profile/schema mismatch')
    require(type(catalog_bytes) is bytes and 0 < len(catalog_bytes) <= 64 * 1024, 'invalid catalog bytes')
    digest = hashlib.sha256(catalog_bytes).hexdigest()
    require(config['catalogSha256'] == digest, 'catalog SHA256 mismatch')
    require(config['poolId'] == 'pclab27-dcu-0-3' and config['serverId'] == 'pclab27-safe-dcu'
            and config['owner'] == 'metainfer-pclab27', 'target allocation identity mismatch')
    require(type(config['image']) is str and re.fullmatch(r'sha256:[0-9a-f]{64}', config['image']),
            'fixed compatible image digest is required')
    mount = config['mount']
    require(type(mount) is dict and set(mount) == {'target', 'uuid'}
            and mount['target'] == MOUNT_TARGET and mount['uuid'] == MOUNT_UUID, 'mount identity mismatch')
    catalog = strict_json(catalog_bytes)
    require(type(catalog) is dict and set(catalog) == {'schemaVersion', 'profiles'}
            and type(catalog['schemaVersion']) is int and catalog['schemaVersion'] == 1,
            'invalid topology catalog schema')
    profiles = catalog['profiles']
    require(type(profiles) is dict and set(profiles) == {PROFILE}, 'invalid catalog profiles')
    profile = profiles[PROFILE]
    require(type(profile) is dict and set(profile) == {'sshAlias', 'remoteRoot', 'python', 'devices'},
            'invalid selected profile schema')
    require(profile['sshAlias'] == 'pclab' and profile['remoteRoot'] == ROOT.as_posix()
            and profile['python'] == (ROOT / 'venv/bin/python').as_posix(), 'catalog transport identity mismatch')
    devices = profile['devices']
    require(type(devices) is list and len(devices) == len(ALLOWED_RENDERS), 'exact allowed GPU topology required')
    bdfs = {}
    for device in devices:
        require(type(device) is dict and set(device) == {'render', 'bdf'}, 'invalid catalog device')
        render, bdf = device['render'], device['bdf']
        require(type(render) is str and re.fullmatch(r'/dev/dri/renderD12[89]', render),
                'protected or non-render device forbidden')
        minor = int(render.rsplit('D', 1)[1])
        require(minor not in bdfs and type(bdf) is str and re.fullmatch(r'0000:[0-9a-f]{2}:00\.0', bdf)
                and bdf not in bdfs.values(), 'invalid/duplicate device identity')
        bdfs[minor] = bdf
    require(tuple(bdfs) == ALLOWED_RENDERS, 'canonical GPU4-7 order required')
    return Target(PROFILE, digest, Path(profile['remoteRoot']), profile['python'], profile['sshAlias'],
                  MappingProxyType(bdfs), config['poolId'], config['serverId'], config['owner'],
                  config['image'], mount['target'], mount['uuid'], hashlib.sha256(canonical(config)).hexdigest())


def mount_options(target, mount, mountpoint):
    require(type(mount) is dict and type(mount.get('filesystems')) is list
            and len(mount['filesystems']) == 1, 'exact mountpoint not confirmed')
    fs = mount['filesystems'][0]
    require(type(fs) is dict and fs.get('target') == mountpoint
            and fs.get('uuid') == target.mount_uuid and fs.get('fstype') == 'ext4'
            and isinstance(fs.get('options'), str), 'wrong target mount')
    # /data on 27 is a shared business mount that cannot be remounted nosuid,nodev.
    # Identity still pins ext4/UUID/read-write and exact render character nodes.
    options = set(fs['options'].split(','))
    require((('rw' in options) != ('ro' in options)),
            'unsafe/unmounted target volume')
    return options


def validate_identity(target, *, hostname, mount, root_device, mount_device, render_bdfs,
                      render_devices, kfd_is_char, root_is_symlink, root_mount=None):
    require(hostname == 'm01r2n07', 'wrong physical host')
    options = mount_options(target, mount, target.mount_target)
    if 'ro' in options or root_mount is not None:
        # ProtectSystem=strict may make the parent ro but bind exactly ROOT back rw.
        root_options = mount_options(target, root_mount, target.root.as_posix())
        require('rw' in root_options, 'exact root bind is not writable')
    require(not root_is_symlink and type(root_device) is int and type(mount_device) is int
            and root_device == mount_device and mount_device > 0, 'root not on expected physical mount')
    require(render_bdfs == dict(target.bdfs), 'render/BDF sysfs identity mismatch')
    require(render_devices == {minor: (226, minor) for minor in target.bdfs},
            'render character-node/sysfs dev identity mismatch')
    require(kfd_is_char is True, 'kfd character node not confirmed')


def verify_identity(target):
    require(sys.platform.startswith('linux'), 'Linux identity checks required; Windows has NO runtime bypass')
    try:
        result = subprocess.run(['findmnt', '--json', '--mountpoint', target.mount_target,
                                 '--output', 'TARGET,SOURCE,FSTYPE,UUID,OPTIONS'],
                                check=False, capture_output=True, timeout=5)
        require(result.returncode == 0 and len(result.stdout) <= 64 * 1024, 'findmnt failed')
        mount = strict_json(result.stdout)
        root_mount = None
        if 'ro' in mount_options(target, mount, target.mount_target):
            result = subprocess.run(['findmnt', '--json', '--mountpoint', target.root.as_posix(),
                                     '--output', 'TARGET,SOURCE,FSTYPE,UUID,OPTIONS'],
                                    check=False, capture_output=True, timeout=5)
            require(result.returncode == 0 and len(result.stdout) <= 64 * 1024, 'effective-root findmnt failed')
            root_mount = strict_json(result.stdout)
        root, mount_path = target.root, Path(target.mount_target)
        require(root.resolve(strict=True) == root and mount_path.resolve(strict=True) == mount_path,
                'symlinked target root/mount forbidden')
        require(root.is_dir() and mount_path.is_dir(), 'target directories missing')
        bdfs, devices = {}, {}
        for minor in target.bdfs:
            render = Path(f'/dev/dri/renderD{minor}')
            info = render.lstat()
            require(stat.S_ISCHR(info.st_mode), 'render must be a character node, not a symlink')
            numbers = (os.major(info.st_rdev), os.minor(info.st_rdev))
            sysfs = Path(f'/sys/class/drm/renderD{minor}')
            require((sysfs / 'dev').read_text(encoding='ascii').strip() == f'{numbers[0]}:{numbers[1]}',
                    'sysfs character-device mismatch')
            bdfs[minor] = (sysfs / 'device').resolve(strict=True).name
            devices[minor] = numbers
        kfd = Path('/dev/kfd').lstat()
        require(stat.S_ISCHR(kfd.st_mode), 'kfd character node missing')
        kfd_numbers = (os.major(kfd.st_rdev), os.minor(kfd.st_rdev))
        require(Path(f'/sys/dev/char/{kfd_numbers[0]}:{kfd_numbers[1]}/dev').read_text(encoding='ascii').strip()
                == f'{kfd_numbers[0]}:{kfd_numbers[1]}', 'kfd sysfs identity mismatch')
        validate_identity(target, hostname=socket.gethostname(), mount=mount, root_mount=root_mount,
                          root_device=root.stat().st_dev, mount_device=mount_path.stat().st_dev,
                          render_bdfs=bdfs, render_devices=devices,
                          kfd_is_char=stat.S_ISCHR(kfd.st_mode), root_is_symlink=root.is_symlink())
    except TargetError:
        raise
    except Exception as exc:
        raise TargetError('target mount/hardware identity unavailable') from exc


def read_config(path):
    require(not path.is_symlink() and not path.parent.is_symlink(), 'symlinked config forbidden')
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 64 * 1024,
                'configuration must be a bounded regular file')
        require(not info.st_mode & 0o022, 'configuration must not be group/world writable')
        raw = file.read(64 * 1024 + 1)
        require(len(raw) <= 64 * 1024, 'configuration too large')
        return raw


def load_target():
    """Fixed config location; fail before credentials, journal mutations or Docker calls."""
    try:
        config = strict_json(read_config(ROOT / 'config/target.json'))
        target = parse_target(config, read_config(ROOT / 'config/targets-catalog.json'))
        verify_identity(target)
        return target
    except TargetError:
        raise
    except Exception as exc:
        raise TargetError('target configuration unavailable') from exc
