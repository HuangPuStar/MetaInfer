"""Dependency-free policy tests: no Docker/server/GPU access; fake flock ONLY on Windows."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import copy
from dataclasses import replace
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "remote-runtime"))
from test_target_config import fixture, native_label_values_contract
import dcu_adapter as dcu
TARGET = fixture()
dcu.configure(TARGET)

HERE = Path(__file__).resolve().parent
HAS_FCNTL = importlib.util.find_spec("fcntl") is not None


def request(gpu="1", **changes):
    result = NS(image=NS(uri=dcu.IMAGE, auth=None), resource_limits=NS(root={"gpu": gpu}),
                env={}, metadata={}, secure_access=False)
    for name in ("volumes", "network_policy", "extensions", "platform", "snapshot_id",
                 "credential_proxy", "resource_requests"):
        setattr(result, name, None)
    result.__dict__.update(changes)
    return result


def container(ids=(), own=True, sandbox_id=None, paths=None, running=False):
    labels = {dcu.OWNER_KEY: dcu.OWNER, dcu.PROFILE_KEY: TARGET.profile,
              dcu.TARGET_KEY: TARGET.identity_label} if own else {}
    if sandbox_id is not None:
        labels[dcu.SANDBOX_KEY] = sandbox_id
    paths = paths if paths is not None else (["/dev/kfd"] + [f"/dev/dri/renderD{128+i}" for i in ids] if ids else [])
    return {"Image": dcu.IMAGE, "Mounts": [], "Config": {"Labels": labels}, "HostConfig": {
        "Devices": [{"PathOnHost": path, "PathInContainer": path, "CgroupPermissions": "rw"} for path in paths],
        "Privileged": False, "DeviceRequests": None, "DeviceCgroupRules": None},
        "State": {"Running": running}}


class FakeClient:
    def __init__(self):
        self.api = self
        self.items = {}
        self.inspected = []
        self.fail_list = False
        self.fail_inspect = None

    def containers(self, **kwargs):
        assert kwargs == {"all": True, "trunc": False}
        if self.fail_list:
            raise RuntimeError("list unavailable")
        return [{"Id": key} for key in list(self.items)]

    def inspect_container(self, identity):
        self.inspected.append(identity)
        if identity == self.fail_inspect:
            raise RuntimeError("inspect unavailable")
        return copy.deepcopy(self.items[identity])


def service(client, error_type=dcu.PolicyError):
    class FakeNative:
        def __init__(self):
            self.docker_client = client
            self.calls = []
            self.restored = False
            self.fail_create = False
            self.leave_container = True
            self.active = self.max_active = 0

        async def create_sandbox(self, req):
            self.calls.append(("native_request", req))
            return "native-response"

        def _resolve_resource_limits(self, req):
            return getattr(req, "parsed", (None, None, None))

        def _restore_existing_sandboxes(self):
            self.restored = True

        def _create_and_start_container(self, sid, image, command, labels, env, cfg, ports, platform):
            self.active += 1
            self.max_active = max(self.active, self.max_active)
            try:
                time.sleep(0.002)  # Expose a lost thread-lock race, without polling any service.
                self.calls.append((sid, image, command, copy.deepcopy(labels), env[:], copy.deepcopy(cfg)))
                if self.leave_container:
                    paths = [entry.split(":", 1)[0] for entry in cfg["devices"]]
                    item = container(paths=paths, sandbox_id=sid, running=True)
                    item["Config"]["Labels"] = labels
                    client.items[sid] = item  # Docker confirmed-create equivalent, visible before lock exits.
                if self.fail_create:
                    raise RuntimeError("uncertain native create/start")
                return sid
            finally:
                self.active -= 1

    dcu.patch_service(FakeNative, error_type)
    return FakeNative()


def start(svc, sid, count=1, labels=None, env=None, alter=None):
    cfg = svc._base_host_config_kwargs(1024**3, 2_000_000_000, "bridge", count)
    cfg["port_bindings"] = {"44772": ("0.0.0.0", 41001), "8080": ("::", 41002)}
    if alter:
        cfg.update(alter)
    labels = dict(labels or {}, **{dcu.SANDBOX_KEY: sid})
    return svc._create_and_start_container(sid, dcu.IMAGE, ["/bin/sh"], labels, env or [],
                                           cfg, ["44772", "8080"], None)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="test-policy-", dir=HERE)
        self.addCleanup(self.temp.cleanup)
        self.path_patch = patch.object(dcu, "LOCK_PATH", Path(self.temp.name) / "allocation.lock")
        self.path_patch.start()
        self.addCleanup(self.path_patch.stop)
        if not HAS_FCNTL:
            # Test-only module substitution. Production inventory_lock still imports real Linux fcntl.
            fake = NS(LOCK_EX=2, LOCK_UN=8, flock=lambda fd, operation: None)
            self.fcntl_patch = patch.dict(sys.modules, {"fcntl": fake})
            self.fcntl_patch.start()
            self.addCleanup(self.fcntl_patch.stop)
        self.runtime_patch = patch.object(dcu, "load_target", return_value=TARGET)
        self.runtime_patch.start()
        self.addCleanup(self.runtime_patch.stop)
        self.client = FakeClient()
        self.svc = service(self.client)

    def test_generated_labels_meet_native_limit_and_override_untrusted_target_label(self):
        for count in (0, 1):
            start(self.svc, f'label-count-{count}', count, labels={dcu.TARGET_KEY: 'untrusted'})
            labels = self.svc.calls[-1][3]
            native_label_values_contract(labels)
            self.assertEqual(labels[dcu.TARGET_KEY], TARGET.identity_label)
            self.assertEqual(labels[dcu.PROFILE_KEY], TARGET.profile)
            self.assertEqual(labels[dcu.OWNER_KEY], TARGET.owner)
            expected = [] if count == 0 else ['/dev/kfd:/dev/kfd:rw',
                                               '/dev/dri/renderD132:/dev/dri/renderD132:rw']
            self.assertEqual(self.svc.calls[-1][5]['devices'], expected)

    def test_scan_rejects_old_full_sha_foreign_and_noncanonical_target_labels(self):
        item = container(ids=(4,))
        item['Config']['Labels'][dcu.TARGET_KEY] = TARGET.identity
        self.client.items['unsafe'] = item
        with self.assertRaises(dcu.PolicyError):
            dcu.scan(self.client)
        other = replace(TARGET, identity='0' * 64).identity_label
        for value in (other, '', TARGET.identity_label[:-1], TARGET.identity_label.upper()):
            item = container(ids=(4,))
            item['Config']['Labels'][dcu.TARGET_KEY] = value
            self.client.items['unsafe'] = item
            with self.subTest(value=value), self.assertRaises(dcu.PolicyError):
                dcu.scan(self.client)
        self.client.items['unsafe'] = container(ids=(4,))
        self.assertEqual(dcu.scan(self.client)[0], {4})

    def test_target_guard_precedes_create_restore_and_lock_mutation(self):
        with patch.object(dcu, 'load_target', side_effect=dcu.TargetError('wrong mount')):
            for call in (lambda: asyncio.run(self.svc.create_sandbox(request())),
                         lambda: start(self.svc, 'must-not-create'),
                         self.svc._restore_existing_sandboxes):
                with self.assertRaises(dcu.PolicyError):
                    call()
        self.assertEqual(self.svc.calls, [])
        self.assertFalse(dcu.LOCK_PATH.exists())

    def test_owned_target_image_and_device_alias_identity_are_not_trusted_labels(self):
        for field, value in ((dcu.PROFILE_KEY, 'pclab27'), (dcu.TARGET_KEY, '0' * 64)):
            item = container(ids=(4,))
            item['Config']['Labels'][field] = value
            self.client.items['bad'] = item
            with self.subTest(field=field), self.assertRaises(dcu.PolicyError):
                dcu.scan(self.client)
        for change in ({'PathInContainer': '/dev/dri/renderD128'}, {'CgroupPermissions': 'rwm'}):
            item = container(ids=(4,));item['HostConfig']['Devices'][1].update(change)
            self.client.items['bad'] = item
            with self.subTest(change=change), self.assertRaises(dcu.PolicyError):
                dcu.scan(self.client)
        for item in (container(paths=['/dev/kfd']), container(paths=['/dev/dri/renderD132']),
                     container(paths=['/dev/kfd', '/dev/dri/renderD132', '/dev/dri/renderD132'])):
            self.client.items['bad'] = item
            with self.subTest(item=item), self.assertRaises(dcu.PolicyError):
                dcu.scan(self.client)
        item = container(ids=(4,));item['Image'] = 'sha256:' + 'b' * 64
        self.client.items['bad'] = item
        with self.assertRaises(dcu.PolicyError):
            dcu.scan(self.client)

    def test_duplicate_physical_claims_and_duplicate_native_ids_fail_closed(self):
        self.client.items['one'] = container(ids=(4,), sandbox_id='one')
        self.client.items['two'] = container(ids=(4,), sandbox_id='two')
        with self.assertRaises(dcu.PolicyError):
            dcu.scan(self.client)
        self.client.items['two'] = container(ids=(5,), sandbox_id='one')
        with self.assertRaises(dcu.PolicyError):
            dcu.scan(self.client)

    def test_returned_create_without_owned_inventory_keeps_pending_marker(self):
        self.svc.leave_container = False
        with self.assertRaises(dcu.PolicyError):
            start(self.svc, 'not-confirmed', 1)
        self.assertEqual(dcu.LOCK_PATH.read_text(), 'not-confirmed')
        self.assertEqual(self.client.items, {})
        with self.assertRaisesRegex(dcu.PolicyError, 'unconfirmed prior'):
            start(self.svc, 'blocked-even-cpu', 0)
        self.assertEqual(len(self.svc.calls), 1)

    def test_install_and_launch_guard_before_native_import_or_api_key_read(self):
        import launch
        with patch.object(dcu, 'load_target', side_effect=dcu.TargetError('wrong mount')):
            for call in (dcu.install, launch.main):
                with self.subTest(call=call), self.assertRaises(dcu.TargetError):
                    call()

    def test_gpu_canonical_and_cpu_only(self):
        for value, expected in [(None, 0)] + [(str(i), i) for i in range(5)]:
            with self.subTest(value=value):
                self.assertEqual(dcu.gpu_count(value), expected)
        for value in ("", "all", "-1", "5", "8", "1.0", "1e0", " 1", "1 ", "+1", "01", "٤",
                      1, 0, -1, 1.0, True, False, [], {}):
            with self.subTest(value=value), self.assertRaises(dcu.PolicyError):
                dcu.gpu_count(value)

    def test_resources_bounded_and_defaults(self):
        self.assertEqual(dcu.bounded_resources(None, None), (4 * 1024**3, 2_000_000_000))
        self.assertEqual(dcu.bounded_resources(32 * 1024**3, 8_000_000_000),
                         (32 * 1024**3, 8_000_000_000))
        for memory, cpu in ((0, 1), (-1, 1), (32 * 1024**3 + 1, 1), (True, 1), (1.0, 1),
                            (1, 0), (1, -1), (1, 8_000_000_001), (1, True), (1, float("nan"))):
            with self.subTest(memory=memory, cpu=cpu), self.assertRaises(dcu.PolicyError):
                dcu.bounded_resources(memory, cpu)

    def test_restricted_request_surface_and_exact_image(self):
        dcu.validate_request(request())
        for name in ("volumes", "network_policy", "extensions", "platform", "snapshot_id",
                     "credential_proxy", "resource_requests"):
            with self.subTest(field=name), self.assertRaises(dcu.PolicyError):
                dcu.validate_request(request(**{name: {}}))
        for req in (request(image=NS(uri="alpine", auth=None)), request(image=None),
                    request(image=NS(uri="harbor.sourcefind.cn:5443/hcu/admin/base/vllm:0.21.0-ubuntu22.04-dtk2604-py3.10", auth=None)),
                    request(image=NS(uri=dcu.IMAGE, auth={})), request(secure_access=True),
                    request(resource_limits=NS(root={"unsupported": "1Gi"}))):
            with self.subTest(request=req), self.assertRaises(dcu.PolicyError):
                dcu.validate_request(req)

    def test_reserved_metadata_rejected_but_allocation_labels_remain_overwritable(self):
        for key in ("opensandbox.io/id", "opensandbox.io/egress-sidecar-for",
                    "opensandbox.io/manual-cleanup", "opensandbox.io/arbitrary"):
            with self.subTest(key=key), self.assertRaisesRegex(dcu.PolicyError, "metadata keys are reserved"):
                asyncio.run(self.svc.create_sandbox(request(metadata={key: "malicious"})))
        self.assertEqual(self.svc.calls, [])
        dcu.validate_request(request(metadata={dcu.OWNER_KEY: "evil", dcu.IDS_KEY: "7"}))
        dcu.validate_request(request(metadata=None))

    def test_empty_cluster_volumes_are_not_mounts(self):
        req = request(volumes=[])
        self.assertEqual(asyncio.run(self.svc.create_sandbox(req)), "native-response")
        self.assertIs(self.svc.calls[-1][1], req)
        with self.assertRaisesRegex(dcu.PolicyError, "volumes forbidden"):
            dcu.validate_request(request(volumes=[NS(name="host-volume")]))

    def test_disk_accounting_compatibility_without_storage_quota(self):
        req = request(resource_limits=NS(root={"cpu": "2", "memory": "1Gi", "gpu": "0", "disk": "1Gi"}),
                      parsed=(1024**3, 2_000_000_000, None))
        self.assertEqual(asyncio.run(self.svc.create_sandbox(req)), "native-response")
        self.assertIs(self.svc.calls[-1][1], req)
        memory, cpu, gpu = self.svc._resolve_resource_limits(req)
        cfg = self.svc._base_host_config_kwargs(memory, cpu, "bridge", gpu)
        self.assertNotIn("storage_opt", cfg)
        self.assertNotIn("disk", cfg)
        start(self.svc, "disk-accounting", 0)
        self.assertNotIn("storage_opt", self.svc.calls[-1][5])

    def test_supplied_invalid_native_resources_are_not_unlimited(self):
        for key in ("cpu", "memory"):
            req = request(resource_limits=NS(root={key: "garbage"}))
            with self.subTest(key=key), self.assertRaises(dcu.PolicyError):
                self.svc._resolve_resource_limits(req)
        req = request(resource_limits=NS(root={"cpu": "2", "memory": "1Gi", "gpu": "0"}),
                      parsed=(1024**3, 2_000_000_000, None))
        self.assertEqual(self.svc._resolve_resource_limits(req), (1024**3, 2_000_000_000, None))

    def test_real_native_async_method_is_delegated_only_after_validation(self):
        self.assertEqual(asyncio.run(self.svc.create_sandbox(request(gpu="0"))), "native-response")
        before = len(self.svc.calls)
        with self.assertRaises(dcu.PolicyError):
            asyncio.run(self.svc.create_sandbox(request(gpu="all")))
        self.assertEqual(len(self.svc.calls), before)

    def test_actual_devices_not_spoofed_ids_or_running_state(self):
        item = container(ids=(4, 6), sandbox_id="stopped", running=False)
        item["Config"]["Labels"][dcu.IDS_KEY] = "5,7"
        self.client.items["owned-stopped"] = item
        self.client.items["dormant-external"] = container(ids=(4, 5), own=False, running=False)
        self.client.items["protected-external"] = container(own=False, paths=["/dev/dri/renderD128"], running=True)
        used, known = dcu.scan(self.client)
        self.assertEqual(used, {4, 6})
        self.assertEqual(known, {"stopped"})
        self.assertEqual(set(self.client.inspected), set(self.client.items))

    def test_card_aliases_and_protected_devices_fail_closed(self):
        for path in ('/dev/dri/card1', '/dev/dri/card5', '/dev/dri/card8',
                     '/dev/dri/renderD128', '/dev/dri/renderD129', '/dev/dri/renderD130', '/dev/dri/renderD131'):
            self.client.items['old-owned'] = container(paths=['/dev/kfd', path])
            with self.subTest(path=path), self.assertRaises(dcu.PolicyError):
                dcu.scan(self.client)

    def test_forbidden_owned_mapping_and_unsafe_modes_fail_closed(self):
        for path in ("/dev/dri/renderD128", "/dev/dri/card5", "/dev/dri", "/dev/mem"):
            self.client.items["bad"] = container(paths=[path])
            with self.subTest(path=path), self.assertRaises(dcu.PolicyError):
                dcu.scan(self.client)
        for devices in ({}, "", False):
            item = container()
            item["HostConfig"]["Devices"] = devices
            self.client.items["bad"] = item
            with self.subTest(devices=devices), self.assertRaises(dcu.PolicyError):
                dcu.scan(self.client)
        item = container()
        del item["HostConfig"]["Devices"]
        self.client.items["bad"] = item
        with self.assertRaises(dcu.PolicyError):
            dcu.scan(self.client)
        for key, value in (("Privileged", True), ("DeviceRequests", [{"Count": -1}]),
                           ("DeviceCgroupRules", ["c *:* rwm"])):
            item = container()
            item["HostConfig"][key] = value
            self.client.items["bad"] = item
            with self.subTest(key=key), self.assertRaises(dcu.PolicyError):
                dcu.scan(self.client)

    def test_inspect_failure_even_external_fails_closed(self):
        self.client.items["external"] = container(own=False)
        self.client.fail_inspect = "external"
        with self.assertRaisesRegex(dcu.PolicyError, "inspect failed"):
            start(self.svc, "must-not-create")
        self.assertEqual(self.svc.calls, [])
        self.client.fail_inspect = None
        self.client.fail_list = True
        with self.assertRaises(dcu.PolicyError):
            dcu.scan(self.client)
        self.client.fail_list = False
        self.client.items["external"] = {"Config": {"Labels": None}}
        with self.assertRaises(dcu.PolicyError):
            dcu.scan(self.client)

    def test_foreign_native_or_sidecar_blocks_restore_and_allocation(self):
        for key in (dcu.SANDBOX_KEY, dcu.SIDECAR_KEY):
            item = container(own=False)
            item["Config"]["Labels"][key] = "foreign"
            self.client.items["foreign"] = item
            with self.subTest(key=key), self.assertRaisesRegex(dcu.PolicyError, "foreign"):
                self.svc._restore_existing_sandboxes()
            self.assertFalse(self.svc.restored)
            with self.assertRaises(dcu.PolicyError):
                start(self.svc, "new")
        self.client.items.clear()
        self.svc._restore_existing_sandboxes()
        self.assertTrue(self.svc.restored)

    def test_boundary_allocation_overwrites_metadata_and_hardens_host_config(self):
        env = ["HIP_VISIBLE_DEVICES=7", "ROCR_VISIBLE_DEVICES=all", "NVIDIA_VISIBLE_DEVICES=all"]
        start(self.svc, "full", 4, {dcu.OWNER_KEY: "evil", dcu.IDS_KEY: "7"}, env,
              {"binds": ["/:/host:rw"], "cap_add": ["SYS_ADMIN"], "privileged": True,
               "devices": ["/dev/dri:/dev/dri:rwm"], "device_requests": [{"Count": -1}],
               "runtime": "nvidia", "security_opt": ["seccomp=unconfined"]})
        call = self.svc.calls[-1]
        labels, passed_env, cfg = call[3:]
        self.assertEqual(labels[dcu.OWNER_KEY], dcu.OWNER)
        self.assertEqual(labels[dcu.IDS_KEY], "4,5,6,7")
        self.assertEqual(passed_env, env)
        self.assertEqual(cfg["devices"], [f"{p}:{p}:rw" for p in ["/dev/kfd"] +
                         [f"/dev/dri/renderD{128+i}" for i in TARGET.physical_ids]])
        self.assertEqual(cfg["cap_drop"], ["ALL"])
        self.assertEqual(cfg["security_opt"], ["no-new-privileges:true"])
        self.assertFalse(cfg["privileged"])
        self.assertEqual((cfg["runtime"], cfg["network_mode"], cfg["pids_limit"]), ("runc", "bridge", 256))
        self.assertEqual(cfg["mem_limit"], cfg["memswap_limit"])
        self.assertEqual({entry[0] for entry in cfg["port_bindings"].values()}, {"127.0.0.1"})
        for key in ("binds", "cap_add", "device_requests", "_dcu_count"):
            self.assertNotIn(key, cfg)

    def test_zero_gpu_does_not_map_kfd_or_render_even_with_masks(self):
        start(self.svc, "cpu", 0, env=["HIP_VISIBLE_DEVICES=all"])
        self.assertEqual(self.svc.calls[-1][5]["devices"], [])
        self.assertEqual(self.svc.calls[-1][3][dcu.IDS_KEY], "")

    def test_port_binding_constraints_and_host_network_rejected(self):
        valid = {"44772": ("0.0.0.0", 1024), "8080": ("::", 65535)}
        self.assertEqual(dcu.loopback_bindings(valid), {"44772": ("127.0.0.1", 1024),
                                                     "8080": ("127.0.0.1", 65535)})
        for bad in (None, {}, {"44772": ("x", 10000)}, {**valid, "22": ("x", 22000)},
                    {**valid, "8080": ("x", 1024)}, {**valid, "8080": ("x", "1234")},
                    {**valid, "8080": ("x", True)}, {**valid, "8080": ("x", 0)},
                    {**valid, "8080": ("x", 65536)}, {**valid, "8080": [("x", 1234)]}):
            with self.subTest(binding=bad), self.assertRaises(dcu.PolicyError):
                dcu.loopback_bindings(bad)
        for mode in ("host", "container:sidecar", "custom"):
            with self.subTest(mode=mode), self.assertRaises(dcu.PolicyError):
                self.svc._base_host_config_kwargs(None, None, mode, 1)
        for count in (-1, 5, True, "1"):
            with self.subTest(count=count), self.assertRaises(dcu.PolicyError):
                self.svc._base_host_config_kwargs(None, None, "bridge", count)

    def test_thread_concurrency_has_disjoint_allocations(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda i: start(self.svc, f"t{i}"), range(4)))
        self.assertEqual(set(results), {"t0", "t1", "t2", "t3"})
        self.assertEqual(self.svc.max_active, 1)
        self.assertEqual({call[3][dcu.IDS_KEY] for call in self.svc.calls}, {"4", "5", "6", "7"})
        with self.assertRaisesRegex(dcu.PolicyError, "capacity exhausted"):
            start(self.svc, "overflow")

    def test_stopped_owned_containers_hold_until_real_deletion(self):
        start(self.svc, "first", 2)
        self.client.items["first"]["State"]["Running"] = False
        start(self.svc, "second", 2)
        with self.assertRaises(dcu.PolicyError):
            start(self.svc, "third")
        del self.client.items["first"]
        start(self.svc, "reused", 2)
        self.assertEqual(self.svc.calls[-1][3][dcu.IDS_KEY], "4,5")

    def test_lingering_uncertain_create_is_counted_by_real_devices(self):
        self.svc.fail_create = True
        with self.assertRaisesRegex(RuntimeError, "uncertain"):
            start(self.svc, "failed", 2)
        self.assertEqual(dcu.scan(self.client)[0], {4, 5})
        self.assertEqual(dcu.LOCK_PATH.read_text(), "failed")
        self.svc.fail_create = False
        start(self.svc, "remaining", 2)
        self.assertEqual(self.svc.calls[-1][3][dcu.IDS_KEY], "6,7")
        self.assertEqual(dcu.LOCK_PATH.read_text(), "")
        with self.assertRaises(dcu.PolicyError):
            start(self.svc, "overflow")

    def test_unconfirmed_create_quarantines_instead_of_unsafe_free(self):
        self.svc.fail_create = True
        self.svc.leave_container = False
        with self.assertRaises(RuntimeError):
            start(self.svc, "late-or-removed", 2)
        self.assertEqual(self.client.items, {})
        self.svc.fail_create = False
        for count in (0, 1, 2):
            with self.subTest(count=count), self.assertRaisesRegex(dcu.PolicyError, "unconfirmed prior"):
                start(self.svc, f"blocked-{count}", count)
        with self.assertRaises(dcu.PolicyError):
            self.svc._restore_existing_sandboxes()
        self.assertFalse(self.svc.restored)
        self.assertEqual(len(self.svc.calls), 1)

    def test_pulls_disabled_and_http_error_translation(self):
        with self.assertRaisesRegex(dcu.PolicyError, "cached"):
            self.svc._pull_image(dcu.IMAGE, None, "new")
        class FakeHTTPError(Exception):
            def __init__(self, status_code, detail):
                self.status_code, self.detail = status_code, detail
        svc = service(self.client, FakeHTTPError)
        with self.assertRaises(FakeHTTPError) as ctx:
            asyncio.run(svc.create_sandbox(request(gpu="-1")))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.detail["code"], "DCU::POLICY")

    @unittest.skipUnless(HAS_FCNTL, "Windows lacks fcntl: actual cross-process flock requires Linux")
    def test_real_flock_excludes_another_process(self):
        child = ("import fcntl,sys; f=open(sys.argv[1], 'a+'); "
                 "fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)")
        with dcu.inventory_lock(self.client):
            completed = subprocess.run([sys.executable, "-B", "-c", child, str(dcu.LOCK_PATH)],
                                       capture_output=True, text=True, timeout=10)
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("BlockingIOError", completed.stderr)
        completed = subprocess.run([sys.executable, "-B", "-c", child, str(dcu.LOCK_PATH)],
                                   capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)


if __name__ == "__main__":
    unittest.main()
