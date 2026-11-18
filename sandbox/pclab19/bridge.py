#!/usr/bin/env python3
"""Trusted, one-request Host CLI. No worker code is executed on the Host.

Production ROOT and loopback endpoints are deliberately fixed. Only CLI main imports
Docker; unit tests inject transports/SDK adapters. See README for failure recovery.
"""
import argparse
import base64
import binascii
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

# Source layout: bridge/bridge.py; deployment layout: ROOT/bridge.py.
_MODULE_ROOT = Path(__file__).resolve().parent
_RUNTIME = _MODULE_ROOT / 'remote-runtime'
if not _RUNTIME.is_dir():
    _RUNTIME = _MODULE_ROOT.parent / 'remote-runtime'
sys.path.insert(0, str(_RUNTIME))
from target_config import ROOT, Target, TargetError, load_target

TARGET = None
IMAGE = POOL = SERVER = OWNER = None
OWNER_KEY = 'pclab.opensandbox/owner'
BDF = None


def configure(target):
    # Explicit dependency injection is for offline tests; CLI always calls load_target().
    global TARGET, IMAGE, POOL, SERVER, OWNER, BDF
    if not isinstance(target, Target):
        raise TargetError('validated target required')
    TARGET = target
    IMAGE, POOL, SERVER, OWNER, BDF = target.image, target.pool_id, target.server_id, target.owner, target.bdfs
WORKSPACE = '/workspace/project'
MAX_REQUEST, MAX_FILE, MAX_OUTPUT = 24 * 1024**2, 16 * 1024**2, 2 * 1024**2
PUBLIC_FIELDS = ('profile', 'bindingId', 'managedId', 'providerId', 'containerId', 'projectId', 'nodeId',
                 'attempt', 'state', 'expiresAt', 'gpuCount', 'renders', 'bdfs', 'verifiedClean')
ACTIONS = {'acquire', 'status', 'exec', 'write', 'read', 'collect', 'release'}


class BridgeError(Exception):
    def __init__(self, code, message, unknown=False):
        self.code, self.message, self.unknown = code, message, unknown
        super().__init__(message)


def require(value, code='INVALID_REQUEST', message='Request violates the bridge contract'):
    if not value:
        raise BridgeError(code, message)


def uid(value):
    require(isinstance(value, str) and len(value) == 36)
    try:
        require(str(uuid.UUID(value)) == value)
    except (ValueError, AttributeError):
        raise BridgeError('INVALID_REQUEST', 'Expected a canonical UUID') from None
    return value


def command_identity(value):
    # execd v1.0.18 emits compact UUID hex; keep its wire identity unchanged.
    if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{32}', value):
        return value
    return uid(value)


def integer(value, low, high):
    require(type(value) is int and low <= value <= high)
    return value


def relative_path(value):
    require(isinstance(value, str) and 0 < len(value.encode('utf-8')) <= 2048,
            'INVALID_PATH', 'Invalid workspace-relative path')
    parts = value.split('/')
    require(not any(ord(c) < 32 for c in value) and not any(c in value for c in ('\\', ':', '\x7f'))
            and all(p not in ('', '.', '..') and p.lower() != '.git' and len(p.encode('utf-8')) <= 255
                    for p in parts), 'INVALID_PATH', 'Invalid workspace-relative path')
    require(not any(re.search(r'^(\.git|node_modules|\.ssh|\.aws|\.azure|\.gnupg|secrets?|keys?|credentials?)(?:$|\.)|^\.env(?:$|\.)|^id_(rsa|dsa|ecdsa|ed25519)(?:$|\.)|\.(pem|key|p12|pfx)$', p, re.I)
                    for p in parts), 'INVALID_PATH', 'Private workspace paths are excluded')
    return value


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def public(binding):
    require(TARGET is not None and binding.get('profile') == TARGET.profile
            and binding.get('targetIdentity') == TARGET.identity,
            'TARGET_IDENTITY_ERROR', 'Binding belongs to a different target')
    result = {key: binding.get(key) for key in PUBLIC_FIELDS}
    if result['renders'] is not None:
        require(all(type(minor) is int and minor in BDF for minor in result['renders']),
                'SECURITY_MISMATCH', 'Invalid private device mapping')
        result['renders'] = [f'/dev/dri/renderD{minor}' for minor in result['renders']]
    return result


def private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not path.is_symlink() and path.is_dir(), 'STATE_ERROR', 'Unsafe state directory')
    os.chmod(path, 0o700)


def read_bytes(path, limit):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit,
                'STATE_ERROR', 'State/request file is not a bounded regular file')
        result = file.read(limit + 1)
        require(len(result) <= limit, 'REQUEST_TOO_LARGE', 'Bounded file limit exceeded')
        return result


def load_json(path, limit=MAX_REQUEST + 1024**2):
    return json.loads(read_bytes(path, limit))


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(canonical(value))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        if os.name == 'posix':
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


@contextmanager
def file_lock(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'r+b') as file:
        require(stat.S_ISREG(os.fstat(file.fileno()).st_mode), 'STATE_ERROR', 'Unsafe lock')
        if os.name == 'posix':
            import fcntl
            fcntl.flock(file.fileno(), fcntl.LOCK_EX)
        else:  # Windows local unit tests only; deployed CLI is Linux.
            import msvcrt
            if os.fstat(file.fileno()).st_size == 0:
                file.write(b'\0')
                file.flush()
            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_LOCK, 1)
        try:
            yield
        finally:
            if os.name == 'posix':
                fcntl.flock(file.fileno(), fcntl.LOCK_UN)
            else:
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)


class Reply:
    def __init__(self, status, body=b'', headers=None):
        self.status, self.body = status, body
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}

    def json(self):
        try:
            return json.loads(self.body) if self.body else None
        except (ValueError, UnicodeError):
            raise BridgeError('PROTOCOL_ERROR', 'Invalid JSON response') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class HTTP:
    def __init__(self, cluster_key, node_key):
        self.secrets = (cluster_key, node_key)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, method='GET', body=None, node=False, limit=1024**2,
                timeout=30, content_type=None, event_callback=None):
        require(path.startswith('/') and not path.startswith('//') and '\r' not in path and '\n' not in path)
        headers = {'OPEN-SANDBOX-API-KEY': self.secrets[1]} if node else {'Authorization': 'Bearer ' + self.secrets[0]}
        if isinstance(body, (dict, list)):
            body, content_type = canonical(body), 'application/json'
        if content_type:
            headers['Content-Type'] = content_type
        request = urllib.request.Request('http://127.0.0.1:' + ('18090' if node else '18080') + path,
                                         data=body, method=method, headers=headers)
        try:
            try:
                response = self.opener.open(request, timeout=timeout)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                if event_callback and response.code == 200:
                    data, count = bytearray(), 0
                    while True:
                        line = response.readline(128 * 1024 + 1)
                        if not line:
                            break
                        count += len(line)
                        require(len(line) <= 128 * 1024 and count <= limit, 'OUTPUT_LIMIT', 'Command stream exceeds its bound')
                        data.extend(line)
                        event = decode_event(line)
                        if event is not None:
                            event_callback(event)
                    raw = bytes(data)
                else:
                    raw = response.read(limit + 1)
                    require(len(raw) <= limit, 'OUTPUT_LIMIT', 'HTTP response exceeds its bound')
                return Reply(response.code, raw, dict(response.headers))
        except BridgeError:
            raise
        except Exception:
            raise BridgeError('API_UNAVAILABLE', 'Loopback service request failed') from None


def decode_event(line):
    line = line.strip()
    if line.startswith(b'data:'):
        line = line[5:].strip()
    if not line or line.startswith((b':', b'event:', b'id:', b'retry:')):
        return None
    try:
        event = json.loads(line)
    except ValueError:
        raise BridgeError('PROTOCOL_ERROR', 'Malformed command stream event') from None
    require(isinstance(event, dict), 'PROTOCOL_ERROR', 'Invalid command stream event')
    return event


def parse_events(raw):
    return [event for line in raw.splitlines() if (event := decode_event(line)) is not None]


def safe_container(item, binding):
    """Validate Docker inspect data, never a CLI return code or a mutable image tag."""
    try:
        labels, host, state = item['Config']['Labels'], item['HostConfig'], item['State']
        require(TARGET is not None and labels.get(OWNER_KEY) == OWNER
                and labels.get('metainfer.profile') == TARGET.profile
                and labels.get('metainfer.target_id') == TARGET.identity_label
                and labels.get('opensandbox.io/id') == binding['providerId']
                and labels.get('metainfer.binding_id') == binding['bindingId']
                and labels.get('metainfer.project_id') == binding['projectId']
                and labels.get('metainfer.node_id') == binding['nodeId']
                and labels.get('metainfer.attempt') == str(binding['attempt']),
                'UNSAFE_CONTAINER', 'Container ownership labels do not match the binding')
        require(re.fullmatch(r'[0-9a-f]{64}', item['Id']) and item['Image'] == IMAGE,
                'UNSAFE_CONTAINER', 'Container/image identity is not fixed')
        if binding.get('containerId'):
            require(item['Id'] == binding['containerId'], 'UNSAFE_CONTAINER', 'Container identity changed')
        require(not host.get('Privileged') and not host.get('DeviceRequests') and not host.get('DeviceCgroupRules')
                and host.get('Runtime') == 'runc' and host.get('NetworkMode') == 'bridge'
                and host.get('CapDrop') == ['ALL'] and not host.get('CapAdd')
                and not host.get('PidMode') and host.get('IpcMode') in (None, '', 'private', 'none') and not host.get('UTSMode')
                and host.get('CgroupnsMode') != 'host' and not host.get('VolumesFrom')
                and not host.get('Binds') and not host.get('Mounts') and not item.get('Mounts')
                and host.get('Memory') == 16384 * 1024**2 and host.get('MemorySwap') == 16384 * 1024**2
                and host.get('NanoCpus') == 1000000000 and type(host.get('PidsLimit')) is int
                and 0 < host['PidsLimit'] <= 256, 'UNSAFE_CONTAINER', 'Unsafe container resource/security configuration')
        options = host.get('SecurityOpt') or []
        require(any(x in ('no-new-privileges', 'no-new-privileges:true') for x in options)
                and not any('unconfined' in x for x in options), 'UNSAFE_CONTAINER', 'Unsafe container security options')
        devices = host.get('Devices') or []
        paths = [device['PathOnHost'] for device in devices]
        renders = sorted(int(path.rsplit('renderD', 1)[1]) for path in paths if path.startswith('/dev/dri/renderD'))
        expected = ({'/dev/kfd'} | {f'/dev/dri/renderD{i}' for i in renders}) if binding['gpuCount'] else set()
        require(len(paths) == len(set(paths)) and set(paths) == expected
                and len(renders) == binding['gpuCount'] and set(renders) <= set(BDF)
                and all(d['PathOnHost'] == d['PathInContainer'] and d['CgroupPermissions'] == 'rw' for d in devices),
                'UNSAFE_CONTAINER', 'Unexpected physical device access')
        if binding.get('containerId'):
            require(renders == binding['renders'] and [BDF[i] for i in renders] == binding['bdfs'],
                    'UNSAFE_CONTAINER', 'Bound physical devices changed')
        ports = host.get('PortBindings') or {}
        require(set(ports) == {'44772/tcp', '8080/tcp'} and all(entries and all(e.get('HostIp') == '127.0.0.1'
                for e in entries) for entries in ports.values()), 'UNSAFE_CONTAINER', 'Ports are not loopback-only')
        return {'containerId': item['Id'], 'renders': renders, 'bdfs': [BDF[i] for i in renders],
                'running': state.get('Running') is True}
    except BridgeError:
        raise
    except (KeyError, TypeError, ValueError, AttributeError):
        raise BridgeError('UNSAFE_CONTAINER', 'Malformed Docker inspect data') from None


class Docker:
    def __init__(self, client=None, not_found=None):
        if client is None:
            import docker
            client, not_found = docker.from_env(), docker.errors.NotFound
        self.client, self.not_found = client, not_found

    def inspect(self, name):
        try:
            return self.client.api.inspect_container(name)
        except self.not_found:
            return None
        except Exception:
            raise BridgeError('DOCKER_UNAVAILABLE', 'Docker inspect failed; absence is not confirmed') from None

    def inventory(self, binding_id):
        try:
            rows = self.client.api.containers(all=True, trunc=False,
                    filters={'label': 'metainfer.binding_id=' + uid(binding_id)})
            require(isinstance(rows, list), 'DOCKER_UNAVAILABLE', 'Malformed Docker inventory')
            result = []
            for row in rows:
                item = self.inspect(row['Id'])
                require(item is not None, 'DOCKER_UNAVAILABLE', 'Inventory changed during inspection')
                require(item['Config']['Labels'].get('metainfer.binding_id') == binding_id,
                        'UNSAFE_CONTAINER', 'Unexpected same-binding inventory')
                result.append(item)
            return result
        except BridgeError:
            raise
        except Exception:
            raise BridgeError('DOCKER_UNAVAILABLE', 'Docker inventory failed; cleanup is not confirmed') from None


# Runs ONLY via execd inside the validated container. Descriptor-relative O_NOFOLLOW
# protects every workspace component, even if a worker has created a symlink/device.
FILE_HELPER = r'''
import os, stat, json, hashlib, sys
P = json.loads(sys.argv[1]); ROOT='/workspace/project'
def pathparts(p):
    v=p.split('/')
    if not p or any(ord(c)<32 for c in p) or any(c in p for c in ('\\',':','\x7f')) or any(x in ('','.','..') or x.lower()=='.git' or len(x.encode())>255 for x in v): raise ValueError('unsafe path')
    return v
def rootfd(create=False):
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    for name in ('workspace','project'):
        if create:
            try: os.mkdir(name,0o700,dir_fd=fd)
            except FileExistsError: pass
        nxt=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
    return fd
def parent(fd,parts,create=False):
    fd=os.dup(fd)
    for name in parts[:-1]:
        if create:
            try: os.mkdir(name,0o700,dir_fd=fd)
            except FileExistsError: pass
        nxt=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
    return fd
def regular(fd):
    s=os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1: raise ValueError('not a single-link regular file')
    return s
stage='/tmp/metainfer-files-'+P['op']
if P['action']=='init':
    os.close(rootfd(True)); result={'ready':True}
elif P['action']=='prepare':
    os.mkdir(stage,0o700); result={'stage':stage}
elif P['action']=='cleanup':
    d=os.open(stage,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    for name in os.listdir(d):
        s=os.stat(name,dir_fd=d,follow_symlinks=False)
        if not stat.S_ISREG(s.st_mode): raise ValueError('unsafe staging entry')
        os.unlink(name,dir_fd=d)
    os.close(d);os.rmdir(stage);result={'removed':True}
else:
    root=rootfd(); d=os.open(stage,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); files=[]; total=0
    def stage_file(path,fd):
        global total
        before=regular(fd)
        if before.st_size>P['maxBytes'] or total+before.st_size>P['maxBytes'] or len(files)>=128: raise ValueError('file limit')
        name=str(len(files))+'.bin'; out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d)
        h=hashlib.sha256();size=0
        with os.fdopen(out,'wb') as f:
            while True:
                chunk=os.read(fd,65536)
                if not chunk: break
                size+=len(chunk)
                if total+size>P['maxBytes']: raise ValueError('file limit')
                f.write(chunk);h.update(chunk)
        after=regular(fd)
        if (before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns) or size!=before.st_size: raise ValueError('file changed')
        files.append({'path':path,'size':size,'sha256':h.hexdigest(),'stage':stage+'/'+name});total+=size
    if P['action']=='write':
        src=os.open('upload.bin',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d);s=regular(src)
        if s.st_size>P['maxBytes']: raise ValueError('file limit')
        parts=pathparts(P['path']);par=parent(root,parts,True)
        target=os.open(parts[-1],os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=par);regular(target)
        h=hashlib.sha256();size=0;os.ftruncate(target,0)
        while True:
            chunk=os.read(src,65536)
            if not chunk: break
            size+=len(chunk)
            if size>P['maxBytes']: raise ValueError('file limit')
            h.update(chunk)
            view=memoryview(chunk)
            while view:
                n=os.write(target,view);view=view[n:]
        if h.hexdigest()!=P['sha256'] or size!=P['size']: raise ValueError('upload hash mismatch')
        os.fchmod(target,int(str(P['mode']),8));os.fsync(target);os.close(src);os.close(target)
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=par);stage_file(P['path'],fd);os.close(fd);os.close(par)
    elif P['action']=='read':
        parts=pathparts(P['path']);par=parent(root,parts)
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=par);stage_file(P['path'],fd);os.close(fd);os.close(par)
    elif P['action']=='collect':
        def walk(fd,prefix=''):
            for name in sorted(os.listdir(fd)):
                path=prefix+name;pathparts(path);s=os.stat(name,dir_fd=fd,follow_symlinks=False)
                if stat.S_ISDIR(s.st_mode):
                    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);walk(child,path+'/');os.close(child)
                elif stat.S_ISREG(s.st_mode):
                    child=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd);stage_file(path,child);os.close(child)
                else: raise ValueError('symlink or special file')
        walk(root)
    else: raise ValueError('bad action')
    os.close(root);os.close(d);result={'files':files,'totalBytes':total}
print(json.dumps(result,separators=(',',':')))
'''


# JSON lines in execd's combined log retain separate streams without relying on
# character offsets. Child output is drained after the 2MiB cap to prevent deadlock.
EXEC_WRAPPER = r'''
import base64,hashlib,json,os,selectors,signal,stat,subprocess,sys,tempfile,time
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
info=os.fstat(fd)
if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>1048576: raise ValueError('unsafe command payload')
with os.fdopen(fd,'rb') as f: raw=f.read(1048577)
if len(raw)>1048576 or hashlib.sha256(raw).hexdigest()!=sys.argv[2]: raise ValueError('command payload changed')
p=json.loads(raw); start=time.monotonic(); limit=2097152; count=0; truncated=False
script=tempfile.TemporaryFile();script.write(p['command'].encode());script.flush();script.seek(0)
child=subprocess.Popen(['/bin/bash','-l','/proc/self/fd/'+str(script.fileno())],pass_fds=(script.fileno(),),cwd='/workspace/project',stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
script.close()
s=selectors.DefaultSelector();s.register(child.stdout,selectors.EVENT_READ,'stdout');s.register(child.stderr,selectors.EVENT_READ,'stderr')
def emit(value):
    print(json.dumps(value,separators=(',',':')),flush=True)
deadline=start+max(0.2,p['timeoutMs']/1000-0.3); timed=False
while s.get_map():
    if time.monotonic()>deadline and not timed:
        try: os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        timed=True
    for key,_ in s.select(0.1):
        data=os.read(key.fileobj.fileno(),8192)
        if not data: s.unregister(key.fileobj);key.fileobj.close();continue
        kept=data[:max(0,limit-count)];count+=len(kept);truncated=truncated or len(kept)<len(data)
        if kept: emit({'stream':key.data,'dataBase64':base64.b64encode(kept).decode()})
rc=child.wait();rc=124 if timed else (128-rc if rc<0 else rc)
emit({'stream':'complete','exitCode':rc,'durationMs':int((time.monotonic()-start)*1000),'truncated':truncated})
sys.exit(rc)
'''


class Bridge:
    def __init__(self, root, http, docker, clock=time.time, sleep=time.sleep, target=None):
        self.target = target if target is not None else load_target()
        configure(self.target)  # BEFORE creating state directories or using transports.
        if target is None and Path(root) != self.target.root:
            raise TargetError('bridge state root differs from target')
        self.root, self.http, self.docker, self.clock, self.sleep = Path(root), http, docker, clock, sleep
        for name in ('', 'requests', 'operations', 'bindings', 'locks'):
            private_dir(self.root / name)
        self.secrets = tuple(getattr(http, 'secrets', ()))

    def clean(self, value):
        if isinstance(value, str):
            for secret in self.secrets:
                if secret:
                    value = value.replace(secret, '[REDACTED]')
            return value
        if isinstance(value, list):
            return [self.clean(v) for v in value]
        if isinstance(value, dict):
            return {k: self.clean(v) for k, v in value.items() if k.lower() not in ('headers', 'authorization', 'api_key', 'apiKey'.lower())}
        return value

    def bounded(self, response, limit=1900 * 1024):
        # The transport (dsh-ssh) hard-caps one command's stdout at 2MiB; a truncated JSON envelope
        # would surface as an unknown operation. Bound the durable response below that cap and mark
        # oversized command output as truncated (never replay, never silently claim success).
        encoded = canonical(response)
        data = response.get('data') if isinstance(response, dict) else None
        if len(encoded) <= limit or not isinstance(data, dict):
            return response
        for key in ('stdout', 'stderr'):
            text = data.get(key)
            while isinstance(text, str) and text and len(encoded) > limit:
                text = text[:len(text) * 4 // 5]
                data[key] = text
                data['truncated'] = True
                encoded = canonical(response)
        if len(encoded) > limit:
            return {'ok': False, 'error': {'code': 'RESPONSE_TOO_LARGE',
                    'message': 'Bridge response exceeds the transport bound; result not deliverable'}}
        return response

    def lock(self, kind, identity):
        return file_lock(self.root / 'locks' / (kind + '-' + identity + '.lock'))

    def check_identity(self, value):
        require(type(value) is dict and value.get('profile') == self.target.profile
                and value.get('targetIdentity') == self.target.identity,
                'TARGET_IDENTITY_ERROR', 'Persisted state belongs to a different target')

    def binding(self, identity):
        path = self.root / 'bindings' / (uid(identity) + '.json')
        require(path.exists(), 'BINDING_NOT_FOUND', 'No persisted binding')
        value = load_json(path)
        self.check_identity(value)
        require(value.get('bindingId') == identity, 'STATE_ERROR', 'Invalid persisted binding')
        return value

    def store(self, binding):
        self.check_identity(binding)
        atomic_json(self.root / 'bindings' / (uid(binding['bindingId']) + '.json'), binding)

    def journal(self, operation):
        self.check_identity(operation)
        atomic_json(self.root / 'operations' / (uid(operation['operationId']) + '.json'), operation)

    def validate(self, request):
        require(type(request) is dict)
        require(request.get('profile') == self.target.profile, 'TARGET_IDENTITY_ERROR', 'Request must select pclab19')
        uid(request.get('operationId'));uid(request.get('bindingId'))
        action = request.get('action');require(action in ACTIONS)
        allowed = {'profile', 'operationId', 'bindingId', 'action'} | {
            'acquire': {'projectId', 'nodeId', 'attempt', 'gpuCount', 'leaseSeconds'},
            'exec': {'command', 'timeoutMs', 'cwd'}, 'write': {'path', 'contentBase64', 'mode'},
            'read': {'path', 'maxBytes'}, 'collect': {'maxBytes'}, 'status': set(), 'release': set()}[action]
        require(set(request) <= allowed, 'INVALID_REQUEST', 'Unexpected request field')
        if action == 'acquire':
            for field in ('projectId', 'nodeId'):
                require(isinstance(request.get(field), str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', request[field]))
            integer(request.get('attempt'), 1, 1000000);integer(request.get('gpuCount'), 0, 4)
            integer(request.get('leaseSeconds'), 60, 7200)
        elif action == 'exec':
            command = request.get('command')
            require(isinstance(command, str) and 0 < len(command.encode()) <= 128 * 1024 and '\x00' not in command)
            integer(request.get('timeoutMs'), 1000, 600000)
            require(request.get('cwd', WORKSPACE) == WORKSPACE)
        elif action in ('write', 'read'):
            relative_path(request.get('path'))
            if action == 'write':
                require(isinstance(request.get('contentBase64'), str) and len(request['contentBase64']) <= (MAX_FILE + 2) // 3 * 4)
                try:
                    content = base64.b64decode(request['contentBase64'], validate=True)
                except (binascii.Error, ValueError):
                    raise BridgeError('INVALID_REQUEST', 'Invalid base64 content') from None
                require(len(content) <= MAX_FILE, 'FILE_LIMIT', 'File exceeds 16MiB')
                require(type(request.get('mode', 644)) is int and request.get('mode', 644) in (600, 644))
            else:
                integer(request.get('maxBytes', MAX_FILE), 1, MAX_FILE)
        elif action == 'collect':
            integer(request.get('maxBytes', MAX_FILE), 1, MAX_FILE)

    def run(self, request):
        operation = None
        try:
            self.validate(request)
            identity, bid = request['operationId'], request['bindingId']
            fingerprint = hashlib.sha256(canonical(request)).hexdigest()
            with self.lock('operation', identity):
                path = self.root / 'operations' / (identity + '.json')
                if path.exists():
                    previous = load_json(path)
                    self.check_identity(previous)
                    require(previous.get('operationId') == identity and previous.get('bindingId') == bid
                            and previous.get('action') == request['action'], 'STATE_ERROR', 'Invalid persisted operation')
                    require(previous.get('requestHash') == fingerprint, 'OPERATION_CONFLICT', 'Operation UUID was reused with different arguments')
                    if previous.get('state') == 'completed':
                        return previous['response']
                    raise BridgeError('OPERATION_UNKNOWN', 'Operation already started; never replay its side effects', True)
                operation = {'operationId': identity, 'bindingId': bid, 'action': request['action'],
                             'requestHash': fingerprint, 'state': 'inProgress', 'startedAt': self.clock(),
                             'profile': self.target.profile, 'targetIdentity': self.target.identity}
                self.journal(operation)  # Durable before ANY create/command/upload/delete.
            data = getattr(self, 'action_' + request['action'])(request, operation)
            response = self.bounded(self.clean({'ok': True, 'data': data}))
            operation.update(state='completed', response=response, finishedAt=self.clock());self.journal(operation)
            return response
        except Exception as error:
            if not isinstance(error, BridgeError):
                error = BridgeError('BRIDGE_FAILED', 'Bridge failed without confirming the operation', True)
            response = {'ok': False, 'error': {'code': error.code, 'message': error.message}}
            try:
                response['data'] = public(self.binding(request['bindingId']))
            except Exception:
                pass
            response = self.clean(response)
            if operation is not None:
                operation.update(state='unknown' if error.unknown else 'completed', response=response, finishedAt=self.clock())
                try:
                    self.journal(operation)
                except Exception:
                    response = {'ok': False, 'error': {'code': 'STATE_ERROR', 'message': 'Operation result could not be persisted; do not replay'}}
            return response

    @staticmethod
    def managed_path(binding):
        return '/api/v2/sandboxes/' + binding['managedId']

    @staticmethod
    def proxy(binding):
        return '/api/v1/sandboxes/' + binding['managedId'] + '/proxy/v1/sandboxes/' + uid(binding['providerId']) + '/proxy/44772'

    def api_json(self, path, method='GET', body=None, node=False):
        reply = self.http.request(path, method, body, node=node)
        return reply.status, reply.json()

    def row_matches(self, row, binding):
        require(isinstance(row, dict) and row.get('sandbox_id') == binding['managedId']
                and row.get('server_id') == SERVER and row.get('pool_id') == POOL,
                'PROTOCOL_ERROR', 'Managed sandbox belongs to a different allocation')
        if binding.get('providerId'):
            require(row.get('provider_sandbox_id') == binding['providerId'], 'PROTOCOL_ERROR', 'Provider binding changed')

    def drain(self, binding):
        # Local admission is latched before best-effort draining the exact known node.
        atomic_json(self.root / 'admission-blocked.json', {'bindingId': binding['bindingId'], 'reason': 'createUnknown'})
        try:
            code, server = self.api_json('/api/v1/servers/' + SERVER)
            if code == 200 and server.get('id') == SERVER and server.get('poolId') == POOL and server.get('baseUrl') == 'http://127.0.0.1:18090':
                self.api_json('/api/v1/servers/' + SERVER, 'PUT', {'status': 'draining'})
        except Exception:
            pass  # Local admission remains blocked; NEVER clear the native allocator latch.

    def action_acquire(self, request, operation):
        bid = request['bindingId']
        with self.lock('admission', 'node'), self.lock('binding', bid):
            path = self.root / 'bindings' / (bid + '.json')
            if path.exists():
                binding = self.binding(bid)
                require(all(binding.get(k) == request[k] for k in ('projectId', 'nodeId', 'attempt', 'gpuCount', 'leaseSeconds')),
                        'BINDING_CONFLICT', 'Binding cannot be reused for another request')
                if binding['state'] == 'ready':
                    self.ensure_live(binding)
                    return public(binding)
                if binding.get('createUncertain') and not binding.get('verifiedClean'):
                    self.drain(binding)
                require(binding['state'] == 'waiting', 'OPERATION_UNKNOWN', 'Prior creation is not safely retryable')
            require(not (self.root / 'admission-blocked.json').exists(), 'ADMISSION_BLOCKED', 'Unknown create requires operator reconciliation')
            for saved in (self.root / 'bindings').glob('*.json'):
                candidate = load_json(saved, 64 * 1024)
                self.check_identity(candidate)
                if candidate.get('createUncertain') and not candidate.get('verifiedClean'):
                    self.drain(candidate)
                    raise BridgeError('ADMISSION_BLOCKED', 'An interrupted create requires operator reconciliation')
            binding = {k: request[k] for k in ('bindingId', 'projectId', 'nodeId', 'attempt', 'gpuCount', 'leaseSeconds')}
            binding.update(profile=self.target.profile, targetIdentity=self.target.identity, managedId='mi-' + bid, providerId=None, containerId=None, state='creating',
                           expiresAt=None, renders=[], bdfs=[], verifiedClean=False, createUncertain=True)
            self.store(binding)
            labels = {'metainfer.binding_id': bid, 'metainfer.project_id': request['projectId'],
                      'metainfer.node_id': request['nodeId'], 'metainfer.attempt': str(request['attempt']),
                      'metainfer.profile': self.target.profile, 'metainfer.target_id': self.target.identity_label}
            body = {'sandbox_id': binding['managedId'], 'lease_seconds': request['leaseSeconds'],
                    'resources': {'cpu': 1, 'memoryMb': 16384, 'diskGb': 1, 'gpuCount': request['gpuCount'], 'environment': {}},
                    'sandbox': {'image': {'uri': IMAGE}, 'entrypoint': ['sleep', 'infinity'], 'metadata': labels}}
            try:
                code, row = self.api_json('/api/v2/pools/' + POOL + '/sandboxes', 'POST', body)
                if code == 409 and isinstance(row, dict) and (row.get('error') or {}).get('code') == 'NO_CAPACITY':
                    binding.update(state='waiting', createUncertain=False);self.store(binding)
                    raise BridgeError('NO_CAPACITY', 'No sandbox resource capacity is currently available')
                require(code in (201, 202), 'CREATE_UNKNOWN', 'Creation was not confirmed')
                self.row_matches(row, binding)
                if row.get('provider_sandbox_id') is not None:
                    uid(row['provider_sandbox_id'])
                    require(type(row.get('expires_at')) in (int, float) and row['expires_at'] > self.clock() * 1000,
                            'CREATE_UNKNOWN', 'Lease deadline was not confirmed')
                    binding.update(providerId=row['provider_sandbox_id'], expiresAt=row['expires_at']);self.store(binding)
                else:
                    require(code == 202, 'CREATE_UNKNOWN', 'Created allocation omitted its provider identity')
                deadline = self.clock() + 100
                while self.clock() < deadline:
                    code, managed = self.api_json(self.managed_path(binding))
                    require(code == 200, 'CREATE_UNKNOWN', 'Managed creation disappeared')
                    self.row_matches(managed, binding)
                    if not binding.get('providerId'):
                        if managed.get('provider_sandbox_id') is None:
                            self.sleep(1)
                            continue
                        uid(managed['provider_sandbox_id'])
                        require(type(managed.get('expires_at')) in (int, float) and managed['expires_at'] > self.clock() * 1000,
                                'CREATE_UNKNOWN', 'Lease deadline was not confirmed')
                        binding.update(providerId=managed['provider_sandbox_id'], expiresAt=managed['expires_at']);self.store(binding)
                    deadline = min(deadline, binding['expiresAt'] / 1000 - 1)
                    code, native = self.api_json('/v1/sandboxes/' + binding['providerId'], node=True)
                    if code == 200 and native.get('status', {}).get('state') == 'Running' and managed.get('state') == 'active':
                        ping = self.http.request(self.proxy(binding) + '/ping')
                        if ping.status == 200:
                            item = self.docker.inspect('sandbox-' + binding['providerId'])
                            require(item is not None, 'CREATE_UNKNOWN', 'Ready container is missing')
                            facts = safe_container(item, binding);require(facts.pop('running'), 'CREATE_UNKNOWN', 'Container is not running')
                            inventory = self.docker.inventory(bid)
                            require(len(inventory) == 1 and inventory[0]['Id'] == facts['containerId'], 'UNSAFE_CONTAINER', 'Same binding has residual containers')
                            binding.update(facts);self.store(binding)
                            self.helper(binding, request['operationId'], 'init')
                            binding.update(state='ready', createUncertain=False);self.store(binding)
                            return public(binding)
                    if code == 200 and native.get('status', {}).get('state') in ('Failed', 'Terminated'):
                        raise BridgeError('CREATE_UNKNOWN', 'Native sandbox failed readiness')
                    self.sleep(1)
                raise BridgeError('CREATE_UNKNOWN', 'Sandbox readiness deadline elapsed')
            except Exception as error:
                if isinstance(error, BridgeError) and error.code == 'NO_CAPACITY':
                    raise
                binding['state'] = 'createUnknown';binding['createUncertain'] = True;self.store(binding);self.drain(binding)
                raise BridgeError('OPERATION_UNKNOWN', 'Create/readiness is uncertain; admission stopped and binding retained', True) from None

    def ensure_live(self, binding):
        require(binding['state'] == 'ready', 'BINDING_NOT_READY', 'Binding is not ready')
        require(type(binding.get('expiresAt')) in (float, int) and binding['expiresAt'] > self.clock() * 1000,
                'LEASE_EXPIRED', 'Sandbox lease has expired')
        code, managed = self.api_json(self.managed_path(binding));require(code == 200, 'NOT_LIVE', 'Managed sandbox is missing')
        self.row_matches(managed, binding);require(managed.get('state') == 'active', 'NOT_LIVE', 'Managed sandbox is not active')
        code, native = self.api_json('/v1/sandboxes/' + uid(binding['providerId']), node=True)
        require(code == 200 and native.get('status', {}).get('state') == 'Running', 'NOT_LIVE', 'Native sandbox is not running')
        item = self.docker.inspect(binding['containerId']);require(item is not None, 'NOT_LIVE', 'Exact container is absent')
        require(safe_container(item, binding)['running'], 'NOT_LIVE', 'Exact container is stopped')
        inventory = self.docker.inventory(binding['bindingId'])
        require(len(inventory) == 1 and inventory[0]['Id'] == binding['containerId'],
                'UNSAFE_CONTAINER', 'Same binding contains an unexpected residual container')
        require(self.http.request(self.proxy(binding) + '/ping').status == 200, 'NOT_LIVE', 'Execd is unavailable')

    def action_status(self, request, operation):
        with self.lock('binding', request['bindingId']):
            binding = self.binding(request['bindingId'])
        code, managed = self.api_json(self.managed_path(binding))
        require(code in (200, 404), 'API_UNAVAILABLE', 'Managed status is not confirmed')
        if code == 200:
            self.row_matches(managed, binding)
        item = self.docker.inspect(binding['containerId']) if binding.get('containerId') else None
        residual = self.docker.inventory(binding['bindingId'])
        if item is not None:
            facts = safe_container(item, binding)
        else:
            facts = {'running': False}
        native_running = False
        if binding.get('providerId'):
            ncode, native = self.api_json('/v1/sandboxes/' + binding['providerId'], node=True)
            require(ncode in (200, 404), 'API_UNAVAILABLE', 'Native status is not confirmed')
            native_running = ncode == 200 and native.get('status', {}).get('state') == 'Running'
        live = (binding['state'] == 'ready' and code == 200 and managed.get('state') == 'active'
                and native_running and facts['running'] and len(residual) == 1
                and residual[0]['Id'] == binding.get('containerId')
                and (binding.get('expiresAt') or 0) > self.clock() * 1000)
        if live:
            live = self.http.request(self.proxy(binding) + '/ping').status == 200
        if code == 200 and managed.get('state') == 'expired' and item is None and not residual:
            with self.lock('binding', request['bindingId']):
                binding = self.binding(request['bindingId'])
                if binding['state'] not in ('released', 'cleanupPending'):
                    binding['state'] = 'expired';self.store(binding)
        return {'binding': public(binding), 'live': bool(live)}

    def foreground(self, binding, code, operation_id):
        marker = 'MI_RESULT_' + operation_id + '='
        wrapped = ('import json,sys\n' + code + '\n')
        # Helpers print one JSON value. A fixed wrapper adds an independent exit marker.
        command = 'python3 -c ' + shlex.quote(wrapped) + '; rc=$?; printf "\\n' + marker + '%s\\n" "$rc"; exit "$rc"'
        reply = self.http.request(self.proxy(binding) + '/command', 'POST',
                                  {'command': command, 'cwd': '/', 'background': False, 'timeout': 30000},
                                  timeout=40, limit=512 * 1024)
        require(reply.status == 200, 'FILE_PROTOCOL_ERROR', 'Internal sandbox helper failed')
        events = parse_events(reply.body)
        stdout = ''.join(e.get('text', '') for e in events if e.get('type') == 'stdout')
        require(any(e.get('type') == 'execution_complete' for e in events)
                and not any(e.get('type') == 'error' for e in events)
                and stdout.rstrip().endswith(marker + '0'), 'FILE_PROTOCOL_ERROR', 'Internal helper did not confirm exit 0')
        raw = stdout[:stdout.rfind(marker)].strip()
        try:
            return json.loads(raw)
        except ValueError:
            raise BridgeError('FILE_PROTOCOL_ERROR', 'Internal helper returned malformed JSON') from None

    def helper(self, binding, operation_id, action, **args):
        params = dict(op=uid(operation_id), action=action, **args)
        code = 'import sys\nsys.argv=["helper",' + repr(canonical(params).decode()) + ']\n' + FILE_HELPER
        return self.foreground(binding, code, operation_id)

    @contextmanager
    def busy(self, request):
        bid = request['bindingId']
        with self.lock('binding', bid):
            binding = self.binding(bid);self.ensure_live(binding)
            require(not binding.get('activeOperation'), 'BINDING_BUSY', 'Another sandbox operation is in progress')
            binding['activeOperation'] = request['operationId'];self.store(binding)
        keep_busy = False
        try:
            yield binding  # No binding lock held here: release can kill a long command.
        except BridgeError as error:
            keep_busy = error.unknown
            raise
        finally:
            with self.lock('binding', bid):
                current = self.binding(bid)
                if current.get('activeOperation') == request['operationId'] and not keep_busy:
                    current.pop('activeOperation');self.store(current)

    def action_exec(self, request, operation):
        with self.busy(request) as binding:
            timeout = request['timeoutMs']
            require(timeout <= binding['expiresAt'] - self.clock() * 1000 - 1000,
                    'LEASE_LIMIT', 'Command timeout extends beyond the sandbox lease')
            payload = canonical({'command': request['command'], 'timeoutMs': timeout})
            payload_path = '/tmp/metainfer-files-' + request['operationId'] + '/upload.bin'
            command = ('python3 -c ' + shlex.quote(EXEC_WRAPPER) + ' ' + shlex.quote(payload_path)
                       + ' ' + hashlib.sha256(payload).hexdigest())
            def event(event):
                if event.get('type') == 'init':
                    command_id = command_identity(event.get('text'))
                    require(not operation.get('commandId') or operation['commandId'] == command_id,
                            'PROTOCOL_ERROR', 'Command identity changed')
                    operation['commandId'] = command_id;operation['cursor'] = 0;self.journal(operation)
            try:
                self.helper(binding, request['operationId'], 'prepare')
                body, content_type = multipart(payload_path, payload)
                uploaded = self.http.request(self.proxy(binding) + '/files/upload', 'POST', body,
                                             content_type=content_type, limit=64 * 1024)
                require(uploaded.status == 200, 'COMMAND_UNKNOWN', 'Command payload upload was not confirmed')
                require(timeout <= binding['expiresAt'] - self.clock() * 1000 - 1000,
                        'LEASE_LIMIT', 'Command timeout extends beyond the sandbox lease')
                reply = self.http.request(self.proxy(binding) + '/command', 'POST',
                        {'command': command, 'cwd': WORKSPACE, 'background': True, 'timeout': timeout},
                        timeout=30, limit=512 * 1024, event_callback=event)
                require(reply.status == 200, 'COMMAND_UNKNOWN', 'Background command start is not confirmed')
                events = parse_events(reply.body)
                require(operation.get('commandId') and not any(e.get('type') == 'error' for e in events),
                        'COMMAND_UNKNOWN', 'Background command identity is not confirmed')
                command_id = operation['commandId'];cursor = 0;raw_pending = b'';out = bytearray();err = bytearray();terminal = None
                deadline = self.clock() + timeout / 1000 + 15
                while self.clock() < deadline:
                    code, status = self.api_json(self.proxy(binding) + '/command/status/' + command_id)
                    require(code == 200 and isinstance(status, dict) and status.get('id') == command_id
                            and type(status.get('running')) is bool, 'COMMAND_UNKNOWN', 'Background command status is not confirmed')
                    logs = self.http.request(self.proxy(binding) + '/command/' + command_id + '/logs?cursor=' + str(cursor), limit=4 * 1024**2)
                    require(logs.status == 200, 'COMMAND_UNKNOWN', 'Background log retrieval failed')
                    try:
                        next_cursor = int(logs.headers['execd-commands-tail-cursor'])
                    except (KeyError, ValueError):
                        raise BridgeError('COMMAND_UNKNOWN', 'Background byte cursor is missing') from None
                    require(next_cursor >= cursor and next_cursor - cursor == len(logs.body),
                            'COMMAND_UNKNOWN', 'Background log byte cursor is inconsistent')
                    cursor = next_cursor;raw_pending += logs.body
                    while b'\n' in raw_pending:
                        line, raw_pending = raw_pending.split(b'\n', 1)
                        if not line:
                            continue
                        frame = json.loads(line)
                        if frame.get('stream') == 'complete':
                            require(terminal is None, 'COMMAND_UNKNOWN', 'Repeated command terminal frame');terminal = frame
                        else:
                            require(frame.get('stream') in ('stdout', 'stderr') and terminal is None,
                                    'COMMAND_UNKNOWN', 'Malformed combined command log')
                            chunk = base64.b64decode(frame['dataBase64'], validate=True)
                            require(len(out) + len(err) + len(chunk) <= MAX_OUTPUT, 'OUTPUT_LIMIT', 'Command output exceeds 2MiB')
                            (out if frame['stream'] == 'stdout' else err).extend(chunk)
                    operation['cursor'] = cursor;self.journal(operation)  # Cursor is raw bytes, never decoded character length.
                    if status['running'] is False:
                        exit_code = status.get('exit_code')
                        require(type(exit_code) is int and 0 <= exit_code <= 255 and terminal is not None and not raw_pending
                                and type(terminal.get('exitCode')) is int and terminal['exitCode'] == exit_code
                                and type(terminal.get('durationMs')) is int and terminal['durationMs'] >= 0
                                and type(terminal.get('truncated')) is bool,
                                'COMMAND_UNKNOWN', 'Explicit command exit status is missing')
                        self.helper(binding, request['operationId'], 'cleanup')
                        return {'commandId': command_id, 'exitCode': exit_code, 'success': exit_code == 0,
                                'stdout': out.decode('utf-8', 'replace'), 'stderr': err.decode('utf-8', 'replace'),
                                'durationMs': terminal['durationMs'], 'truncated': terminal.get('truncated') is True}
                    self.sleep(0.25)
                raise BridgeError('COMMAND_UNKNOWN', 'Background command polling deadline elapsed')
            except Exception:
                raise BridgeError('OPERATION_UNKNOWN', 'Command may have run; never replay it. Release or inspect this binding.', True) from None

    def file_action(self, request, action):
        with self.busy(request) as binding:
            op = request['operationId'];self.helper(binding, op, 'prepare')
            try:
                maximum = request.get('maxBytes', MAX_FILE)
                args = {'maxBytes': maximum}
                if action in ('read', 'write'):
                    args['path'] = request['path']
                if action == 'write':
                    content = base64.b64decode(request['contentBase64'], validate=True)
                    digest = hashlib.sha256(content).hexdigest()
                    args.update(size=len(content), sha256=digest, mode=request.get('mode', 644))
                    body, kind = multipart('/tmp/metainfer-files-' + op + '/upload.bin', content)
                    reply = self.http.request(self.proxy(binding) + '/files/upload', 'POST', body,
                                              content_type=kind, limit=64 * 1024)
                    require(reply.status == 200, 'FILE_PROTOCOL_ERROR', 'Binary upload was not confirmed')
                    # Empty HTTP 200 body is the documented success, not a JSON parse failure.
                manifest = self.helper(binding, op, action, **args)
                files = manifest.get('files')
                require(isinstance(files, list) and len(files) <= 128, 'FILE_LIMIT', 'Invalid bounded file manifest')
                result, total = [], 0
                for index, item in enumerate(files):
                    relative_path(item['path']);integer(item['size'], 0, maximum)
                    require(re.fullmatch(r'[0-9a-f]{64}', item['sha256'])
                            and item['stage'] == '/tmp/metainfer-files-' + op + '/' + str(index) + '.bin',
                            'FILE_PROTOCOL_ERROR', 'Invalid staged file manifest')
                    require(item['path'] not in {entry['path'] for entry in result},
                            'FILE_PROTOCOL_ERROR', 'Duplicate workspace path in file manifest')
                    if action in ('write', 'read'):
                        require(item['path'] == request['path'], 'FILE_PROTOCOL_ERROR', 'Returned workspace path changed')
                    reply = self.http.request(self.proxy(binding) + '/files/download?' + urllib.parse.urlencode({'path': item['stage']}), limit=maximum)
                    require(reply.status == 200 and len(reply.body) == item['size']
                            and hashlib.sha256(reply.body).hexdigest() == item['sha256'], 'FILE_HASH_MISMATCH', 'File download hash does not match')
                    total += len(reply.body);require(total <= maximum, 'FILE_LIMIT', 'Collection exceeds total file limit')
                    result.append({'path': item['path'], 'size': item['size'], 'sha256': item['sha256'],
                                   'contentBase64': base64.b64encode(reply.body).decode()})
                if action == 'write':
                    require(len(result) == 1 and result[0]['sha256'] == digest, 'FILE_HASH_MISMATCH', 'Workspace hash verification failed')
                    return {k: result[0][k] for k in ('path', 'size', 'sha256')}
                if action == 'read':
                    require(len(result) == 1, 'FILE_PROTOCOL_ERROR', 'Expected one file')
                    return result[0]
                return {'files': result, 'totalBytes': total, 'truncated': False}
            finally:
                # Cleanup is inside the same validated sandbox, never Host rm or Docker rm.
                self.helper(binding, op, 'cleanup')

    def action_write(self, request, operation):
        return self.file_action(request, 'write')

    def action_read(self, request, operation):
        return self.file_action(request, 'read')

    def action_collect(self, request, operation):
        return self.file_action(request, 'collect')

    def action_release(self, request, operation):
        bid = request['bindingId']
        with self.lock('binding', bid):
            binding = self.binding(bid)
            binding['state'] = 'cleanupPending';binding['verifiedClean'] = False;self.store(binding)
            try:
                residual = self.docker.inventory(bid)
                if not binding.get('containerId'):
                    if len(residual) == 1:
                        provider = residual[0]['Config']['Labels'].get('opensandbox.io/id');uid(provider)
                        require(not binding.get('providerId') or provider == binding['providerId'], 'CLEANUP_PENDING', 'Unknown provider mismatch')
                        binding['providerId'] = provider
                        facts = safe_container(residual[0], binding);facts.pop('running');binding.update(facts);self.store(binding)
                    else:
                        require(not binding.get('createUncertain'), 'CLEANUP_PENDING', 'Unknown create cannot be freed by absence alone')
                require(len(residual) <= 1, 'CLEANUP_PENDING', 'Same binding has extra residual containers')
                for item in residual:
                    safe_container(item, binding)
                code, _ = self.api_json(self.managed_path(binding), 'DELETE')
                require(code in (202, 204, 404), 'CLEANUP_PENDING', 'Managed deletion is not confirmed')
                deadline = self.clock() + 90
                while self.clock() < deadline:
                    code, _ = self.api_json(self.managed_path(binding))
                    require(code in (200, 404), 'CLEANUP_PENDING', 'Managed deletion status is unavailable')
                    item = self.docker.inspect(binding['containerId']) if binding.get('containerId') else None
                    residual = self.docker.inventory(bid)
                    if item is not None:
                        safe_container(item, binding)
                    if code == 404 and item is None and not residual:
                        require(binding.get('containerId') or not binding.get('createUncertain'), 'CLEANUP_PENDING', 'Uncertain create has no exact container proof')
                        binding.update(state='released', verifiedClean=True);binding.pop('activeOperation', None);self.store(binding)
                        return public(binding)
                    self.sleep(0.5)
                raise BridgeError('CLEANUP_PENDING', 'Physical and managed absence are not both confirmed')
            except Exception:
                binding['state'] = 'cleanupPending';self.store(binding)
                raise BridgeError('CLEANUP_PENDING', 'Cleanup could not be verified; binding retained') from None


def multipart(path, content):
    boundary = 'metainfer-' + uuid.uuid4().hex
    metadata = canonical({'path': path, 'mode': 600})
    body = bytearray()
    for name, filename, kind, data in (('metadata', 'metadata.json', 'application/json', metadata),
                                        ('file', 'upload.bin', 'application/octet-stream', content)):
        body.extend(('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"; filename="' + filename
                     + '"\r\nContent-Type: ' + kind + '\r\n\r\n').encode())
        body.extend(data);body.extend(b'\r\n')
    body.extend(('--' + boundary + '--\r\n').encode())
    return bytes(body), 'multipart/form-data; boundary=' + boundary


def secret(path, name):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600, 'CREDENTIAL_ERROR', 'Expected private credential file')
    values = dict(line.split('=', 1) for line in read_bytes(path, 64 * 1024).decode().splitlines()
                  if line and not line.startswith('#') and '=' in line)
    value = values.get(name);require(isinstance(value, str) and len(value) >= 24, 'CREDENTIAL_ERROR', 'Required credential is not available')
    return value


def main():
    # stdout has precisely one JSON response; no logging, keys, HTTP headers or traceback.
    try:
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument('--request-id', required=True)
        args = parser.parse_args();identity = uid(args.request_id)
        target = load_target();configure(target)  # Guard mount/target BEFORE credentials/state/SDK.
        request = load_json(ROOT / 'requests' / (identity + '.json'), MAX_REQUEST)
        require(request.get('operationId') == identity, 'INVALID_REQUEST', 'Request filename and operation UUID differ')
        os.chmod(ROOT / 'requests' / (identity + '.json'), 0o600)
        http = HTTP(secret(ROOT / 'secrets/cluster.env', 'CLUSTER_SERVICE_API_KEY'),
                    secret(ROOT / 'secrets/node.env', 'OPENSANDBOX_SERVER_API_KEY'))
        result = Bridge(ROOT, http, Docker(), target=target).run(request)
    except BaseException as error:
        if isinstance(error, TargetError):
            result = {'ok': False, 'error': {'code': 'TARGET_IDENTITY_ERROR', 'message': str(error)}}
        elif isinstance(error, BridgeError):
            result = {'ok': False, 'error': {'code': error.code, 'message': error.message}}
        else:
            result = {'ok': False, 'error': {'code': 'BRIDGE_FAILED', 'message': 'Bridge request failed; no confirmed result'}}
    sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
