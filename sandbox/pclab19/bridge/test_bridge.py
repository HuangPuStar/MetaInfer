"""Offline regressions. No network/SSH/Docker daemon/install/worker execution."""
import ast
import base64
from copy import deepcopy
from dataclasses import replace
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "remote-runtime"))
from test_target_config import fixture, native_label_values_contract
import bridge as b
TARGET = fixture()
b.configure(TARGET)

HERE = Path(__file__).resolve().parent


def new_id():
    return str(uuid.uuid4())


def request(action, bid=None, **values):
    return dict(operationId=new_id(), bindingId=bid or new_id(), action=action, profile=TARGET.profile, **values)


def binding(bid=None):
    return dict(bindingId=bid or new_id(), managedId='mi-placeholder', providerId=new_id(),
                containerId='a' * 64, projectId='project-1', nodeId='node-2', attempt=1,
                state='ready', expiresAt=2000000, gpuCount=1, renders=[132], bdfs=[b.BDF[132]],
                profile=TARGET.profile, targetIdentity=TARGET.identity,
                leaseSeconds=600, verifiedClean=False)


def inspect_row(bound):
    paths = ['/dev/kfd'] + [f'/dev/dri/renderD{i}' for i in bound['renders']] if bound['gpuCount'] else []
    return {'Id': bound.get('containerId') or 'a' * 64, 'Image': b.IMAGE,
            'Config': {'Labels': {b.OWNER_KEY: b.OWNER, 'opensandbox.io/id': bound['providerId'],
                'metainfer.binding_id': bound['bindingId'], 'metainfer.project_id': bound['projectId'],
                'metainfer.node_id': bound['nodeId'], 'metainfer.attempt': str(bound['attempt']),
                'metainfer.profile': TARGET.profile, 'metainfer.target_id': TARGET.identity_label}},
            'HostConfig': {'Devices': [{'PathOnHost': x, 'PathInContainer': x, 'CgroupPermissions': 'rw'} for x in paths],
                'Memory': 16384 * 1024**2, 'MemorySwap': 16384 * 1024**2, 'NanoCpus': 1000000000, 'PidsLimit': 256,
                'Privileged': False, 'DeviceRequests': None, 'Runtime': 'runc', 'NetworkMode': 'bridge',
                'CapDrop': ['ALL'], 'CapAdd': [], 'SecurityOpt': ['no-new-privileges:true'],
                'PortBindings': {'44772/tcp': [{'HostIp': '127.0.0.1'}], '8080/tcp': [{'HostIp': '127.0.0.1'}]}},
            'State': {'Running': True}, 'Mounts': []}


def reply(code=200, value=None, raw=None, headers=None):
    return b.Reply(code, b.canonical(value) if raw is None else raw, headers)


class Missing(Exception):
    pass


class FakeAPI:
    def __init__(self):
        self.items = []
        self.failed = False

    def inspect_container(self, identity):
        if self.failed:
            raise RuntimeError('daemon unavailable SECRET_NODE_KEY_1234567890')
        for item in self.items:
            if identity in (item['Id'], 'sandbox-' + item['Config']['Labels']['opensandbox.io/id']):
                return deepcopy(item)
        raise Missing('not found')

    def containers(self, **kwargs):
        if self.failed:
            raise RuntimeError('daemon unavailable')
        bid = kwargs['filters']['label'].split('=', 1)[1]
        return [{'Id': item['Id']} for item in self.items if item['Config']['Labels']['metainfer.binding_id'] == bid]


class FakeHTTP:
    secrets = ('SECRET_CLUSTER_KEY_1234567890', 'SECRET_NODE_KEY_1234567890')

    def __init__(self, api):
        self.api = api
        self.calls, self.posts = [], 0
        self.row, self.create_mode, self.deleted = None, 'success', False
        self.handler = None

    def request(self, path, method='GET', body=None, **kwargs):
        self.calls.append((path, method, body, kwargs))
        if self.handler:
            value = self.handler(path, method, body, kwargs)
            if value is not None:
                return value
        if method == 'POST' and '/api/v2/pools/' in path:
            self.posts += 1
            if self.create_mode == 'timeout':
                raise b.BridgeError('API_UNAVAILABLE', 'do not print SECRET_CLUSTER_KEY_1234567890')
            if self.create_mode == 'capacity':
                return reply(409, {'error': {'code': 'NO_CAPACITY'}})
            if self.create_mode == 'conflict':
                return reply(409, {'error': {'code': 'REQUEST_CONFLICT'}})
            self.deleted = False
            labels = body['sandbox']['metadata']
            bound = binding(labels['metainfer.binding_id'])
            bound.update(containerId='a' * 64, gpuCount=body['resources']['gpuCount'],
                         renders=list(TARGET.bdfs)[:body['resources']['gpuCount']])
            self.api.items = [inspect_row(bound)]
            self.row = dict(sandbox_id=body['sandbox_id'], pool_id=b.POOL, server_id=b.SERVER,
                            state='active', expires_at=2000000, provider_sandbox_id=bound['providerId'])
            return reply(201, self.row)
        if path.startswith('/api/v2/sandboxes/'):
            if method == 'DELETE':
                self.deleted = True
                self.api.items = []
                return reply(204, raw=b'')
            return reply(404, {'error': {'code': 'NOT_FOUND'}}) if self.deleted or self.row is None else reply(200, self.row)
        if path == '/api/v1/servers/' + b.SERVER:
            if method == 'PUT':
                return reply(200, {'status': 'draining'})
            return reply(200, {'id': b.SERVER, 'poolId': b.POOL, 'baseUrl': 'http://127.0.0.1:18090'})
        if path.startswith('/v1/sandboxes/'):
            return reply(200, {'status': {'state': 'Running'}})
        if path.endswith('/ping'):
            return reply(200, {'pong': True})
        if path.endswith('/files/upload') and method == 'POST':
            return reply(200, raw=b'')
        raise AssertionError(('unhandled fake route', method, path))


class TestBridge(b.Bridge):
    def helper(self, bound, op, action, **args):
        return {'ready': True}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='.test-', dir=HERE)
        self.api = FakeAPI()
        self.http = FakeHTTP(self.api)
        self.docker = b.Docker(type('Client', (), {'api': self.api})(), Missing)
        self.bridge = TestBridge(self.directory.name, self.http, self.docker, clock=lambda: 1000, sleep=lambda n: None, target=TARGET)

    def tearDown(self):
        self.directory.cleanup()

    def acquired(self):
        req = request('acquire', projectId='project-1', nodeId='node-2', attempt=1, gpuCount=1, leaseSeconds=600)
        result = self.bridge.run(req)
        self.assertTrue(result['ok'], result)
        return req, result['data']

    def live(self):
        bound = binding()
        bound['managedId'] = 'mi-' + bound['bindingId']
        self.bridge.store(bound)
        self.api.items = [inspect_row(bound)]
        self.http.deleted = False
        self.http.row = dict(sandbox_id=bound['managedId'], pool_id=b.POOL, server_id=b.SERVER,
                             provider_sandbox_id=bound['providerId'], expires_at=bound['expiresAt'], state='active')
        return bound

    def test_created_metadata_meets_native_limit_without_shortening_private_sha(self):
        req, _ = self.acquired()
        body = next(call[2] for call in self.http.calls if call[1] == 'POST' and '/api/v2/pools/' in call[0])
        native_label_values_contract(body['sandbox']['metadata'])
        self.assertEqual(body['sandbox']['metadata']['metainfer.target_id'], TARGET.identity_label)
        bound = self.bridge.binding(req['bindingId'])
        operation = b.load_json(Path(self.directory.name) / 'operations' / (req['operationId'] + '.json'))
        self.assertEqual(bound['targetIdentity'], TARGET.identity)
        self.assertEqual(operation['targetIdentity'], TARGET.identity)
        self.assertEqual(len(bound['targetIdentity']), 64)
        # A compact Docker label is not a substitute for private journal/session identity.
        b.atomic_json(Path(self.directory.name) / 'bindings' / (req['bindingId'] + '.json'),
                      dict(bound, targetIdentity=TARGET.identity_label))
        self.http.calls.clear()
        self.assertEqual(self.bridge.run(request('status', req['bindingId']))['error']['code'],
                         'TARGET_IDENTITY_ERROR')
        self.assertEqual(self.http.calls, [])
        self.bridge.store(bound)
        b.atomic_json(Path(self.directory.name) / 'operations' / (req['operationId'] + '.json'),
                      dict(operation, targetIdentity=TARGET.identity_label))
        self.assertEqual(self.bridge.run(req)['error']['code'], 'TARGET_IDENTITY_ERROR')
        self.assertEqual(self.http.calls, [])

    def test_old_full_sha_and_foreign_or_noncanonical_labels_fail_physical_check(self):
        bound = binding()
        row = inspect_row(bound)
        row['Config']['Labels']['metainfer.target_id'] = TARGET.identity
        with self.assertRaises(b.BridgeError):
            b.safe_container(row, bound)
        other = replace(TARGET, identity='0' * 64).identity_label
        for value in (other, '', TARGET.identity_label[:-1], TARGET.identity_label.upper()):
            row = inspect_row(bound)
            row['Config']['Labels']['metainfer.target_id'] = value
            with self.subTest(value=value), self.assertRaises(b.BridgeError):
                b.safe_container(row, bound)
        self.assertEqual(b.safe_container(inspect_row(bound), bound)['renders'], [132])

    def test_profile_is_required_and_foreign_target_requests_have_no_side_effect(self):
        for profile in (None, 'pclab27', 'pclab19 '):
            req = request('acquire', projectId='project-1', nodeId='node-2', attempt=1,
                          gpuCount=1, leaseSeconds=600)
            if profile is None:
                del req['profile']
            else:
                req['profile'] = profile
            result = self.bridge.run(req)
            self.assertEqual(result['error']['code'], 'TARGET_IDENTITY_ERROR')
        self.assertEqual(self.http.calls, [])
        self.assertEqual(list((Path(self.directory.name) / 'operations').glob('*.json')), [])

    def test_wrong_runtime_does_not_create_state_or_touch_transport(self):
        absent = Path(self.directory.name) / 'not-created'
        with patch.object(b, 'load_target', side_effect=b.TargetError('wrong mount')):
            with self.assertRaises(b.TargetError):
                b.Bridge(absent, self.http, self.docker)
        self.assertFalse(absent.exists())
        self.assertEqual(self.http.calls, [])

    def test_target_identity_binds_persisted_session_and_journal(self):
        bound = self.live()
        path = Path(self.directory.name) / 'bindings' / (bound['bindingId'] + '.json')
        for field, value in [('profile', 'pclab27'), ('targetIdentity', '0' * 64)]:
            b.atomic_json(path, dict(bound, **{field: value}))
            self.http.calls.clear()
            result = self.bridge.run(request('release', bound['bindingId']))
            self.assertEqual(result['error']['code'], 'TARGET_IDENTITY_ERROR')
            self.assertEqual(self.http.calls, [])
        self.bridge.store(bound)
        req, public = self.acquired()
        self.assertEqual(public['profile'], 'pclab19')
        operation = Path(self.directory.name) / 'operations' / (req['operationId'] + '.json')
        previous = b.load_json(operation)
        previous['targetIdentity'] = '0' * 64
        b.atomic_json(operation, previous)
        self.http.calls.clear()
        self.assertEqual(self.bridge.run(req)['error']['code'], 'TARGET_IDENTITY_ERROR')
        self.assertEqual(self.http.calls, [])

    def test_all_protected_gpu_nodes_and_card_aliases_rejected(self):
        bound = binding()
        for path in ['/dev/dri/renderD128', '/dev/dri/renderD129', '/dev/dri/renderD130',
                     '/dev/dri/renderD131', '/dev/dri/card5', '/dev/dri', '/dev/kfd/../mem']:
            row = inspect_row(bound)
            row['HostConfig']['Devices'][1] = {'PathOnHost': path, 'PathInContainer': path,
                                               'CgroupPermissions': 'rw'}
            with self.subTest(path=path), self.assertRaises(b.BridgeError):
                b.safe_container(row, bound)
        row = inspect_row(bound);row['Config']['Labels']['metainfer.target_id'] = '0' * 64
        with self.assertRaises(b.BridgeError):
            b.safe_container(row, bound)

    def test_cpu_only_and_full_allowed_set_request_shape(self):
        for count in (0, 4):
            req = request('acquire', projectId='project-1', nodeId='node-2', attempt=1,
                          gpuCount=count, leaseSeconds=600)
            result = self.bridge.run(req)
            self.assertTrue(result['ok'], result)
            bound = self.bridge.binding(req['bindingId'])
            self.assertEqual(bound['renders'], list(TARGET.bdfs)[:count])
            self.assertEqual(result['data']['renders'], [f'/dev/dri/renderD{i}' for i in list(TARGET.bdfs)[:count]])
            posted = [call for call in self.http.calls if call[1] == 'POST' and '/api/v2/pools/' in call[0]][-1][2]
            self.assertEqual(posted['resources'], {'cpu': 1, 'memoryMb': 16384, 'diskGb': 1,
                                                 'gpuCount': count, 'environment': {}})
            self.assertEqual(set(posted['sandbox']), {'image', 'entrypoint', 'metadata'})
            self.assertEqual(posted['sandbox']['image'], {'uri': TARGET.image})
            devices = self.api.items[0]['HostConfig']['Devices']
            self.assertEqual([d['PathOnHost'] for d in devices],
                             ['/dev/kfd'] + [f'/dev/dri/renderD{i}' for i in TARGET.bdfs] if count else [])
            cleaned = self.bridge.run(request('release', req['bindingId']))
            self.assertTrue(cleaned['ok'], cleaned)
            self.assertTrue(cleaned['data']['verifiedClean'])

    def test_live_binding_cannot_move_between_allowed_physical_cards(self):
        bound = self.live();row = self.api.items[0]
        row['HostConfig']['Devices'][1].update(PathOnHost='/dev/dri/renderD133', PathInContainer='/dev/dri/renderD133')
        self.assertEqual(self.bridge.run(request('exec', bound['bindingId'], command='true', timeoutMs=1000))['error']['code'],
                         'UNSAFE_CONTAINER')
        self.assertFalse(any(call[0].endswith('/command') for call in self.http.calls))

    def test_cli_wrong_mount_fails_before_credentials_docker_and_request_read(self):
        output = io.StringIO()
        with patch.object(b.sys, 'argv', ['bridge.py', '--request-id', new_id()]), \
             patch.object(b, 'load_target', side_effect=b.TargetError('wrong mount')), \
             patch.object(b, 'secret') as secret, patch.object(b, 'Docker') as docker, \
             patch.object(b, 'load_json') as read_request, patch.object(b.sys, 'stdout', output):
            b.main()
        result = json.loads(output.getvalue())
        self.assertEqual(result['error']['code'], 'TARGET_IDENTITY_ERROR')
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        secret.assert_not_called();docker.assert_not_called();read_request.assert_not_called()

    def test_acquire_durable_before_post_and_completed_op_cache(self):
        def check(path, method, body, kwargs):
            if method == 'POST' and '/api/v2/pools/' in path:
                on_disk = self.bridge.binding(body['sandbox']['metadata']['metainfer.binding_id'])
                self.assertEqual(on_disk['state'], 'creating')
                operations = list((Path(self.directory.name) / 'operations').glob('*.json'))
                self.assertEqual(b.load_json(operations[0])['state'], 'inProgress')
        self.http.handler = check
        req, bound = self.acquired()
        self.assertEqual(bound['renders'], ['/dev/dri/renderD132'])
        self.assertEqual(bound['bdfs'], [b.BDF[132]])
        self.assertEqual(self.bridge.run(req), {'ok': True, 'data': bound})
        self.assertEqual(self.http.posts, 1)
        other = dict(req, operationId=new_id())
        self.assertTrue(self.bridge.run(other)['ok'])
        self.assertEqual(self.http.posts, 1)

    def test_202_without_provider_waits_for_managed_status_without_reposting(self):
        def delayed(path, method, body, kwargs):
            if method == 'POST' and '/api/v2/pools/' in path:
                self.http.handler = None
                try:
                    created = self.http.request(path, method, body, **kwargs).json()
                finally:
                    self.http.handler = delayed
                created['provider_sandbox_id'] = None
                created['state'] = 'creating'
                return reply(202, created)
        self.http.handler = delayed
        _, bound = self.acquired()
        self.assertEqual(bound['renders'], ['/dev/dri/renderD132'])
        self.assertEqual(self.http.posts, 1)

    def test_inprogress_never_replays_even_when_ssh_reconnects(self):
        req = request('status')
        operation = dict(operationId=req['operationId'], bindingId=req['bindingId'],
                         requestHash=hashlib.sha256(b.canonical(req)).hexdigest(), state='inProgress', action=req['action'],
                         profile=TARGET.profile, targetIdentity=TARGET.identity)
        self.bridge.journal(operation)
        result = self.bridge.run(req)
        self.assertEqual(result['error']['code'], 'OPERATION_UNKNOWN')
        self.assertEqual(self.http.calls, [])
        self.assertEqual(b.load_json(Path(self.directory.name) / 'operations' / (req['operationId'] + '.json'))['state'], 'inProgress')

    def test_operation_id_conflict_is_not_cached_command(self):
        req, _ = self.acquired()
        result = self.bridge.run(dict(req, gpuCount=2))
        self.assertEqual(result['error']['code'], 'OPERATION_CONFLICT')
        self.assertEqual(self.http.posts, 1)

    def test_unknown_create_latches_admission_and_cannot_release_by_404(self):
        self.http.create_mode = 'timeout'
        req = request('acquire', projectId='project-1', nodeId='node-2', attempt=1, gpuCount=1, leaseSeconds=600)
        self.assertEqual(self.bridge.run(req)['error']['code'], 'OPERATION_UNKNOWN')
        self.assertEqual(self.bridge.binding(req['bindingId'])['state'], 'createUnknown')
        self.assertTrue((Path(self.directory.name) / 'admission-blocked.json').exists())
        self.assertEqual(self.bridge.run(req)['error']['code'], 'OPERATION_UNKNOWN')
        self.assertEqual(self.http.posts, 1)
        result = self.bridge.run(request('release', req['bindingId']))
        self.assertEqual(result['error']['code'], 'CLEANUP_PENDING')
        self.assertFalse(self.bridge.binding(req['bindingId'])['verifiedClean'])
        newer = request('acquire', projectId='project-1', nodeId='node-2', attempt=1, gpuCount=1, leaseSeconds=600)
        self.assertEqual(self.bridge.run(newer)['error']['code'], 'ADMISSION_BLOCKED')

    def test_only_capacity_409_is_queue_and_a_new_operation_can_retry(self):
        self.http.create_mode = 'capacity'
        req = request('acquire', projectId='project-1', nodeId='node-2', attempt=1, gpuCount=1, leaseSeconds=600)
        self.assertEqual(self.bridge.run(req)['error']['code'], 'NO_CAPACITY')
        self.assertEqual(self.bridge.binding(req['bindingId'])['state'], 'waiting')
        self.assertEqual(self.bridge.run(req)['error']['code'], 'NO_CAPACITY')
        self.assertEqual(self.http.posts, 1)
        self.http.create_mode = 'success'
        self.assertTrue(self.bridge.run(dict(req, operationId=new_id()))['ok'])
        self.assertEqual(self.http.posts, 2)

    def test_other_409_is_unknown_not_queue(self):
        self.http.create_mode = 'conflict'
        req = request('acquire', projectId='project-1', nodeId='node-2', attempt=1, gpuCount=1, leaseSeconds=600)
        self.assertEqual(self.bridge.run(req)['error']['code'], 'OPERATION_UNKNOWN')

    def test_malformed_uuid_gpu_command_and_unexpected_fields_rejected(self):
        base = request('acquire', projectId='project-1', nodeId='node-2', attempt=1, gpuCount=1, leaseSeconds=600)
        for key, values in {'gpuCount': (-1, 5, True, '1'), 'leaseSeconds': (59, 7201), 'attempt': (0, True),
                            'operationId': ('../x', base['operationId'].upper())}.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    self.assertFalse(self.bridge.run(dict(base, **{key: value}))['ok'])
        self.assertFalse(self.bridge.run(dict(base, apiKey='evil'))['ok'])
        self.assertFalse(self.bridge.run(request('exec', command='x', timeoutMs=999))['ok'])
        self.assertFalse(self.bridge.run(request('exec', command='x' * (128 * 1024 + 1), timeoutMs=1000))['ok'])
        self.assertFalse(self.bridge.run(request('exec', command='x', timeoutMs=1000, cwd='/'))['ok'])
        self.assertEqual(self.http.posts, 0)

    def test_path_and_binary_request_validation(self):
        for path in ('../x', '/x', './x', 'a//b', 'a/..', 'a/.git/x', 'A/.GIT/x', 'C:/x', 'a\\b', 'a\0b', 'a/'):
            with self.subTest(path=path):
                self.assertFalse(self.bridge.run(request('read', path=path))['ok'])
        b.relative_path('src/你好.py')
        self.assertFalse(self.bridge.run(request('write', path='good', contentBase64='%%'))['ok'])
        self.assertFalse(self.bridge.run(request('write', path='good', contentBase64='', mode=0o644))['ok'])
        self.assertFalse(self.bridge.run(request('read', path='good', maxBytes=b.MAX_FILE + 1))['ok'])
        self.assertFalse(self.bridge.run(request('collect', maxBytes=0))['ok'])

    def test_sdk_notfound_is_distinct_from_daemon_error(self):
        self.assertIsNone(self.docker.inspect('absent'))
        self.api.failed = True
        with self.assertRaises(b.BridgeError) as caught:
            self.docker.inspect('absent')
        self.assertEqual(caught.exception.code, 'DOCKER_UNAVAILABLE')
        with self.assertRaises(b.BridgeError):
            self.docker.inventory(new_id())

    def test_release_needs_precise_sdk_absence_and_clears_only_owned_binding(self):
        bound = self.live()
        result = self.bridge.run(request('release', bound['bindingId']))
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['data']['verifiedClean'])
        self.assertEqual(result['data']['state'], 'released')
        again = self.bridge.run(request('release', bound['bindingId']))
        self.assertTrue(again['data']['verifiedClean'])
        self.assertTrue(all(method != 'POST' for _, method, _, _ in self.http.calls))

    def test_docker_unavailable_never_marks_clean(self):
        bound = self.live();self.api.failed = True
        result = self.bridge.run(request('release', bound['bindingId']))
        self.assertEqual(result['error']['code'], 'CLEANUP_PENDING')
        self.assertEqual(self.bridge.binding(bound['bindingId'])['state'], 'cleanupPending')
        self.assertFalse(self.bridge.binding(bound['bindingId'])['verifiedClean'])
        self.assertNotIn('SECRET_', json.dumps(result))

    def test_safe_config_rejects_identity_privilege_mount_and_protected_gpu(self):
        bound = binding();original = inspect_row(bound)
        self.assertEqual(b.safe_container(original, bound)['renders'], [132])
        changes = [lambda r: r.update(Image='mutable:tag'), lambda r: r.update(Id='b' * 64),
            lambda r: r['HostConfig'].update(Privileged=True), lambda r: r['HostConfig'].update(CapAdd=['SYS_ADMIN']),
            lambda r: r['HostConfig'].update(DeviceRequests=[{}]), lambda r: r['HostConfig'].update(DeviceCgroupRules=['a *:* rwm']),
            lambda r: r['HostConfig'].update(NetworkMode='host'), lambda r: r['HostConfig'].update(Runtime='nvidia'),
            lambda r: r['HostConfig'].update(PidMode='host'), lambda r: r['HostConfig'].update(IpcMode='host'),
            lambda r: r['HostConfig'].update(IpcMode='container:foreign'), lambda r: r['HostConfig'].update(UTSMode='host'),
            lambda r: r['HostConfig'].update(CgroupnsMode='host'), lambda r: r['HostConfig'].update(VolumesFrom=['foreign']),
            lambda r: r['HostConfig'].update(Binds=['/:/host']), lambda r: r['HostConfig'].update(Mounts=[{}]), lambda r: r.update(Mounts=[{}]),
            lambda r: r['HostConfig'].update(PidsLimit=-1), lambda r: r['HostConfig'].update(Memory=0),
            lambda r: r['HostConfig'].update(SecurityOpt=['seccomp:unconfined']),
            lambda r: r['HostConfig']['Devices'][1].update(PathOnHost='/dev/dri/renderD128'),
            lambda r: r['HostConfig']['Devices'][1].update(CgroupPermissions='rwm'),
            lambda r: r['HostConfig']['PortBindings']['44772/tcp'][0].update(HostIp='0.0.0.0'),
            lambda r: r['Config']['Labels'].update({'metainfer.binding_id': new_id()})]
        for change in changes:
            row = deepcopy(original);change(row)
            with self.subTest(change=change), self.assertRaises(b.BridgeError):
                b.safe_container(row, bound)

    def test_sse_and_json_line_protocol_parser(self):
        events = b.parse_events(b'event: message\n' + b'data: {"type":"stdout","text":"hi"}\n\n'
                                b': keepalive\n{"type":"execution_complete"}\n')
        self.assertEqual([e['type'] for e in events], ['stdout', 'execution_complete'])
        with self.assertRaises(b.BridgeError):
            b.parse_events(b'data: nope\n')

    def test_execd_command_identity_is_not_the_host_request_uuid_contract(self):
        compact = 'e2511504dda847af8304e33bcd02e33a'
        canonical = new_id()
        self.assertEqual(b.command_identity(compact), compact)
        self.assertEqual(b.command_identity(canonical), canonical)
        with self.assertRaises(b.BridgeError):
            b.uid(compact)
        for invalid in ('../' + compact, compact + '?x=1', 'G' * 32, '', None):
            with self.subTest(invalid=invalid), self.assertRaises(b.BridgeError):
                b.command_identity(invalid)

    def test_background_nonzero_uses_raw_byte_cursor_and_is_cached(self):
        bound = self.live();cid = 'e2511504dda847af8304e33bcd02e33a';step = [0];paths = []
        raw1 = b.canonical({'stream': 'stdout', 'dataBase64': base64.b64encode('你好'.encode()).decode()}) + b'\n'
        raw2 = (b.canonical({'stream': 'stderr', 'dataBase64': base64.b64encode(b'failure').decode()}) + b'\n' +
                b.canonical({'stream': 'complete', 'exitCode': 7, 'durationMs': 6, 'truncated': False}) + b'\n')
        def handler(path, method, body, kwargs):
            if path.endswith('/command'):
                event = {'type': 'init', 'text': cid}
                kwargs['event_callback'](event)
                journal = b.load_json(Path(self.directory.name) / 'operations' / (req['operationId'] + '.json'))
                self.assertEqual(journal['commandId'], cid)
                return reply(raw=b.canonical(event) + b'\n{"type":"execution_complete"}\n')
            if '/command/status/' in path:
                return reply(value={'id': cid, 'running': step[0] == 0, 'exit_code': 7 if step[0] else None})
            if '/logs?cursor=' in path:
                paths.append(path)
                data = (raw1, raw2)[step[0]];step[0] += 1
                return reply(raw=data, headers={'EXECD-COMMANDS-TAIL-CURSOR': str(len(raw1) if step[0] == 1 else len(raw1) + len(raw2))})
        self.http.handler = handler
        req = request('exec', bound['bindingId'], command='exit 7', timeoutMs=10000)
        result = self.bridge.run(req)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['data']['exitCode'], 7)
        self.assertFalse(result['data']['success'])
        self.assertEqual(result['data']['stdout'], '你好')
        self.assertEqual(result['data']['stderr'], 'failure')
        self.assertTrue(paths[1].endswith('cursor=' + str(len(raw1))))
        before = len(self.http.calls)
        self.assertEqual(self.bridge.run(req), result)
        self.assertEqual(len(self.http.calls), before)

    def test_unknown_command_is_not_replayed_and_freezes_more_commands(self):
        bound = self.live();starts = [0]
        def handler(path, method, body, kwargs):
            if path.endswith('/command'):
                starts[0] += 1
                kwargs['event_callback']({'type': 'init', 'text': new_id()})
                raise b.BridgeError('API_UNAVAILABLE', 'stream disconnected')
        self.http.handler = handler
        req = request('exec', bound['bindingId'], command='irreversible', timeoutMs=10000)
        self.assertEqual(self.bridge.run(req)['error']['code'], 'OPERATION_UNKNOWN')
        self.assertEqual(self.bridge.run(req)['error']['code'], 'OPERATION_UNKNOWN')
        self.assertEqual(starts[0], 1)
        self.assertEqual(self.bridge.run(request('exec', bound['bindingId'], command='again', timeoutMs=10000))['error']['code'], 'BINDING_BUSY')
        self.assertTrue(self.bridge.run(request('release', bound['bindingId']))['ok'])

    def test_long_exec_does_not_hold_binding_lock_against_release(self):
        bound = self.live();entered = threading.Event();go = threading.Event();result = []
        def handler(path, method, body, kwargs):
            if path.endswith('/command'):
                entered.set();go.wait(3)
                raise b.BridgeError('API_UNAVAILABLE', 'cancelled')
        self.http.handler = handler
        req = request('exec', bound['bindingId'], command='long', timeoutMs=10000)
        thread = threading.Thread(target=lambda: result.append(self.bridge.run(req)));thread.start()
        self.assertTrue(entered.wait(2))
        try:
            released = self.bridge.run(request('release', bound['bindingId']))
            self.assertTrue(released['ok'], released)
        finally:
            go.set();thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.bridge.binding(bound['bindingId'])['state'], 'released')

    def test_multipart_has_metadata_file_integer_mode_and_binary_body(self):
        content = b'\0\xff\r\n\0binary'
        body, kind = b.multipart('/tmp/target', content)
        self.assertIn(b'name="metadata"; filename="metadata.json"', body)
        self.assertIn(b'name="file"; filename="upload.bin"', body)
        self.assertIn(b'"mode":600', body)
        self.assertIn(content, body)
        self.assertTrue(kind.startswith('multipart/form-data; boundary='))

    def test_redaction_and_public_binding_do_not_include_secrets_or_headers(self):
        value = self.bridge.clean({'headers': {'Authorization': self.http.secrets[0]},
                                  'message': 'failure ' + self.http.secrets[1], 'nested': [self.http.secrets[0]]})
        self.assertNotIn('SECRET_', json.dumps(value));self.assertNotIn('headers', value)
        self.assertEqual(set(b.public(binding())), set(b.PUBLIC_FIELDS))

    def test_creating_crash_window_is_uncertain_before_http_post(self):
        def check(path, method, body, kwargs):
            if method == 'POST' and '/api/v2/pools/' in path:
                persisted = self.bridge.binding(body['sandbox']['metadata']['metainfer.binding_id'])
                self.assertTrue(persisted['createUncertain'])
        self.http.handler = check
        req, _ = self.acquired()
        self.assertFalse(self.bridge.binding(req['bindingId'])['createUncertain'])
        crashed = binding();crashed.update(state='creating', providerId=None, containerId=None,
                                            renders=[], bdfs=[], createUncertain=True)
        self.bridge.store(crashed);self.api.items = [];self.http.row = None
        result = self.bridge.run(request('release', crashed['bindingId']))
        self.assertEqual(result['error']['code'], 'CLEANUP_PENDING')
        self.assertFalse(self.bridge.binding(crashed['bindingId'])['verifiedClean'])
        newer = request('acquire', projectId='project-1', nodeId='node-2', attempt=2, gpuCount=1, leaseSeconds=600)
        before = self.http.posts
        self.assertEqual(self.bridge.run(newer)['error']['code'], 'ADMISSION_BLOCKED')
        self.assertEqual(self.http.posts, before)
        self.assertTrue((Path(self.directory.name) / 'admission-blocked.json').exists())

    def test_extra_same_binding_container_blocks_execution_before_post(self):
        bound = self.live();extra = inspect_row(bound);extra['Id'] = 'b' * 64
        self.api.items.append(extra)
        result = self.bridge.run(request('exec', bound['bindingId'], command='x', timeoutMs=10000))
        self.assertEqual(result['error']['code'], 'UNSAFE_CONTAINER')
        self.assertFalse(any(path.endswith('/command') for path, _, _, _ in self.http.calls))

    def file_setup(self, content=b'\x00\xff\r\nbinary', mutate=None):
        bound = self.live();stages = [];uploaded = []
        def helper(bound, op, action, **kwargs):
            stages.append(action)
            if action in ('prepare', 'cleanup'):
                return {'stage': '/tmp/metainfer-files-' + op}
            values = {'files': [{'path': kwargs.get('path', 'artifact.bin'), 'size': len(content),
                       'sha256': hashlib.sha256(content).hexdigest(),
                       'stage': '/tmp/metainfer-files-' + op + '/0.bin'}], 'totalBytes': len(content)}
            return mutate(values) if mutate else values
        self.bridge.helper = helper
        def handler(path, method, body, kwargs):
            if path.endswith('/files/upload'):
                uploaded.append((body, kwargs['content_type']))
                return reply(200, raw=b'')
            if '/files/download?' in path:
                return reply(200, raw=content)
        self.http.handler = handler
        return bound, stages, uploaded

    def test_binary_upload_empty_200_then_hash_readback_and_cached_result(self):
        content = b'\x00\xff\r\nbinary'
        bound, stages, uploaded = self.file_setup(content)
        req = request('write', bound['bindingId'], path='src/data.bin',
                      contentBase64=base64.b64encode(content).decode(), mode=644)
        result = self.bridge.run(req)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['data'], {'path': 'src/data.bin', 'size': len(content),
                                         'sha256': hashlib.sha256(content).hexdigest()})
        self.assertEqual(stages, ['prepare', 'write', 'cleanup'])
        self.assertIn(b'name="metadata"; filename="metadata.json"', uploaded[0][0])
        self.assertEqual(self.bridge.run(req), result)
        self.assertEqual(len(uploaded), 1)
        self.assertFalse(self.bridge.binding(bound['bindingId']).get('activeOperation'))

    def test_read_and_collect_return_binary_base64_not_text(self):
        content = b'\x00\xff\r\nbinary'
        bound, stages, uploaded = self.file_setup(content)
        result = self.bridge.run(request('read', bound['bindingId'], path='src/data.bin'))
        self.assertEqual(base64.b64decode(result['data']['contentBase64']), content)
        result = self.bridge.run(request('collect', bound['bindingId'], maxBytes=1024))
        self.assertEqual(result['data']['totalBytes'], len(content))
        self.assertEqual(base64.b64decode(result['data']['files'][0]['contentBase64']), content)
        self.assertEqual(uploaded, [])

    def test_file_manifest_rejects_escaping_wrong_path_duplicate_hash_and_count(self):
        mutations = [
            lambda v: dict(v, files=[dict(v['files'][0], stage='/tmp/metainfer-files-evil/0.bin')]),
            lambda v: dict(v, files=[dict(v['files'][0], stage=v['files'][0]['stage'].replace('/0.bin', '/../etc/passwd'))]),
            lambda v: dict(v, files=[dict(v['files'][0], path='other-file')]),
            lambda v: dict(v, files=[dict(v['files'][0], sha256='0' * 64)]),
            lambda v: dict(v, files=v['files'] * 129),
            lambda v: dict(v, files=[])]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                bound, stages, _ = self.file_setup(mutate=mutate)
                result = self.bridge.run(request('read', bound['bindingId'], path='expected-file'))
                self.assertFalse(result['ok'], result)
                self.assertEqual(stages[-1], 'cleanup')

    def test_collect_rejects_duplicate_paths_and_total_size_overrun(self):
        def duplicate(v):
            return dict(v, files=v['files'] + [dict(v['files'][0], stage=v['files'][0]['stage'].replace('/0.bin', '/1.bin'))])
        bound, _, _ = self.file_setup(mutate=duplicate)
        result = self.bridge.run(request('collect', bound['bindingId']))
        self.assertFalse(result['ok'])
        def overrun(v):
            return dict(v, files=v['files'] + [dict(v['files'][0], path='second',
                                  stage=v['files'][0]['stage'].replace('/0.bin', '/1.bin'))])
        bound, _, _ = self.file_setup(mutate=overrun)
        result = self.bridge.run(request('collect', bound['bindingId'], maxBytes=12))
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['code'], 'FILE_LIMIT')

    def test_cli_invalid_request_uuid_is_one_json_and_does_not_read_credentials(self):
        stdout = io.StringIO()
        with patch('sys.argv', ['bridge.py', '--request-id', '../escape']), patch('sys.stdout', stdout), \
                patch.object(b, 'secret', side_effect=AssertionError('should not read keys')):
            b.main()
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(stdout.getvalue())['error']['code'], 'INVALID_REQUEST')

    def test_full_128k_command_is_staged_and_not_an_execve_argument(self):
        bound = self.live();cid = new_id();uploads = [];starts = []
        terminal = b.canonical({'stream': 'complete', 'exitCode': 0, 'durationMs': 1, 'truncated': False}) + b'\n'
        def handler(path, method, body, kwargs):
            if path.endswith('/files/upload'):
                uploads.append(body)
                return reply(200, raw=b'')
            if path.endswith('/command'):
                starts.append(body['command']);kwargs['event_callback']({'type': 'init', 'text': cid})
                return reply(raw=b'{"type":"execution_complete"}\n')
            if '/command/status/' in path:
                return reply(value={'id': cid, 'running': False, 'exit_code': 0})
            if '/logs?cursor=' in path:
                return reply(raw=terminal, headers={'EXECD-COMMANDS-TAIL-CURSOR': str(len(terminal))})
        self.http.handler = handler
        command = '#' + 'x' * (128 * 1024 - 1)
        result = self.bridge.run(request('exec', bound['bindingId'], command=command, timeoutMs=10000))
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['data']['exitCode'], 0)
        self.assertLess(len(starts[0].encode()), 16 * 1024)
        self.assertNotIn(command, starts[0])
        self.assertIn(b.canonical({'command': command, 'timeoutMs': 10000}), uploads[0])

    def test_http_200_without_explicit_exit_or_valid_byte_cursor_is_unknown(self):
        for problem in ('no-exit', 'boolean-exit', 'no-terminal', 'no-cursor', 'wrong-cursor'):
            with self.subTest(problem=problem):
                bound = self.live();cid = new_id()
                terminal = {'stream': 'complete', 'exitCode': False if problem == 'boolean-exit' else 0,
                            'durationMs': 1, 'truncated': False}
                logs = b'' if problem == 'no-terminal' else b.canonical(terminal) + b'\n'
                def handler(path, method, body, kwargs):
                    if path.endswith('/command'):
                        kwargs['event_callback']({'type': 'init', 'text': cid})
                        return reply(raw=b'{"type":"execution_complete"}\n')
                    if '/command/status/' in path:
                        return reply(value={'id': cid, 'running': False, 'exit_code': None if problem == 'no-exit' else 0})
                    if '/logs?cursor=' in path:
                        headers = {} if problem == 'no-cursor' else {'EXECD-COMMANDS-TAIL-CURSOR': str(len(logs) + (problem == 'wrong-cursor'))}
                        return reply(raw=logs, headers=headers)
                self.http.handler = handler
                req = request('exec', bound['bindingId'], command='x', timeoutMs=10000)
                result = self.bridge.run(req)
                self.assertEqual(result['error']['code'], 'OPERATION_UNKNOWN')
                self.assertEqual(self.bridge.binding(bound['bindingId'])['activeOperation'], req['operationId'])
                self.assertTrue(self.bridge.run(request('release', bound['bindingId']))['ok'])

    def test_internal_programs_are_syntax_valid_and_descriptor_constrained(self):
        ast.parse(b.FILE_HELPER);ast.parse(b.EXEC_WRAPPER)
        self.assertIn('os.O_NOFOLLOW', b.FILE_HELPER)
        self.assertIn('dir_fd=fd', b.FILE_HELPER)
        self.assertIn('st_nlink!=1', b.FILE_HELPER)
        self.assertNotIn('subprocess', b.FILE_HELPER)


if __name__ == '__main__':
    unittest.main(verbosity=2)
