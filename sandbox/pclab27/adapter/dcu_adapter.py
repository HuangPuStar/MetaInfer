"""External native OpenSandbox v0.2.2 policy hooks. Stdlib-only until install()."""
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from threading import Lock
import os

IMAGE = "sha256:94a6bd36f4d857c24d240e0d010ce07c922ec47ea711bce179a35bbdc266fc94"
OWNER_KEY, IDS_KEY = "pclab.opensandbox/owner", "pclab.opensandbox/dcu-ids"
OWNER = "metainfer-pclab27"
SANDBOX_KEY, SIDECAR_KEY = "opensandbox.io/id", "opensandbox.io/egress-sidecar-for"
LOCK_PATH = Path(__file__).resolve().with_name("dcu-allocation.lock")
THREAD_LOCK = Lock()
PATH_IDS = {f"/dev/dri/renderD{128 + i}": i for i in range(2)}
PATH_IDS.update({f"/dev/dri/card{1 + i}": i for i in range(2)})


class PolicyError(Exception):
    def __init__(self, status_code, detail):
        self.status_code, self.detail = status_code, detail
        super().__init__(str(detail))


def require(condition, message, status=400):
    if not condition:
        raise PolicyError(status, message)


def gpu_count(value):
    require(value is None or (type(value) is str and value in ("0", "1", "2", "3", "4")),
            "gpu must be canonical string 1-4; omitted/'0' means CPU-only")
    return 0 if value is None else int(value)


def validate_request(request):
    require(request.image is not None and request.image.uri == IMAGE, "only fixed cached image allowed")
    require(request.image.auth is None, "image.auth forbidden")
    require(not any(key.startswith("opensandbox.io/") for key in (request.metadata or {})),
            "opensandbox.io/ metadata keys are reserved")
    require(getattr(request, "volumes", None) in (None, []), "volumes forbidden")
    for name in ("network_policy", "extensions", "platform", "snapshot_id",
                 "credential_proxy", "resource_requests"):
        require(getattr(request, name, None) is None, f"{name} forbidden")
    require(not getattr(request, "secure_access", False), "secure_access unsupported")
    limits = request.resource_limits.root if request.resource_limits else {}
    # disk is Cluster accounting-only: native Docker ignores it; no disk quota is claimed.
    require(set(limits) <= {"cpu", "memory", "gpu", "disk"}, "unknown resource limit")
    gpu_count(limits.get("gpu"))


def bounded_resources(memory, cpu):
    memory = 4 * 1024**3 if memory is None else memory
    cpu = 2_000_000_000 if cpu is None else cpu
    require(type(memory) is int and 0 < memory <= 32 * 1024**3, "memory must be positive, <=32GiB")
    require(type(cpu) is int and 0 < cpu <= 8_000_000_000, "cpu must be positive, <=8")
    return memory, cpu


def loopback_bindings(bindings):
    require(type(bindings) is dict and set(bindings) == {"44772", "8080"}, "exact execd/http ports required")
    result = {}
    for port, binding in bindings.items():
        require(isinstance(binding, (tuple, list)) and len(binding) == 2, "invalid port binding")
        host_port = binding[1]
        require(type(host_port) is int and 1024 <= host_port <= 65535, "invalid host port")
        result[port] = ("127.0.0.1", host_port)
    require(len({entry[1] for entry in result.values()}) == 2, "host ports must be distinct")
    return result


def scan(client):
    """Inspect ALL containers; reserve actual devices of OUR containers, including stopped."""
    used, confirmed = set(), set()
    try:
        summaries = client.api.containers(all=True, trunc=False)
        require(type(summaries) is list, "invalid Docker inventory", 503)
        for summary in summaries:
            item = client.api.inspect_container(summary["Id"])
            labels, host = item["Config"]["Labels"] or {}, item["HostConfig"]
            require(type(labels) is dict and type(host) is dict, "invalid Docker inspect", 503)
            own = labels.get(OWNER_KEY) == OWNER
            require(not (SANDBOX_KEY in labels or SIDECAR_KEY in labels) or own,
                    "foreign OpenSandbox container; refusing recovery/allocation", 503)
            if not own:
                continue  # Lead MUST separately preflight external compute FDs, not just mappings.
            require(not host.get("Privileged") and not host.get("DeviceRequests")
                    and not host.get("DeviceCgroupRules"), "unsafe owned container", 503)
            require(host["Devices"] is None or type(host["Devices"]) is list, "invalid owned devices", 503)
            for device in host["Devices"] or []:
                path = device["PathOnHost"]
                require(path == "/dev/kfd" or path in PATH_IDS, "unexpected owned device mapping", 503)
                if path in PATH_IDS:
                    used.add(PATH_IDS[path])
            if labels.get(SANDBOX_KEY):
                confirmed.add(labels[SANDBOX_KEY])
    except PolicyError:
        raise
    except Exception as exc:
        raise PolicyError(503, "Docker list/inspect failed; allocation refused") from exc
    return used, confirmed


def checkpoint(file, value=""):
    file.seek(0)
    file.truncate()
    file.write(value)
    file.flush()
    os.fsync(file.fileno())


@contextmanager
def inventory_lock(client):
    import fcntl  # Linux required; deliberately no non-locking production fallback.
    with THREAD_LOCK, open(LOCK_PATH, "a+", encoding="utf-8") as file:
        fcntl.flock(file.fileno(), fcntl.LOCK_EX)
        try:
            used, confirmed = scan(client)
            file.seek(0)
            pending = file.read().strip()
            require(not pending or pending in confirmed,
                    "unconfirmed prior Docker create; operator reconciliation required (see README)", 503)
            if pending:
                checkpoint(file)
            yield used, file
        finally:
            fcntl.flock(file.fileno(), fcntl.LOCK_UN)


def patch_service(service_class, error_type=PolicyError):
    """Patch actual native class before main imports singleton; fake class only in tests."""
    native_create, native_start = service_class.create_sandbox, service_class._create_and_start_container
    native_restore, native_resources = service_class._restore_existing_sandboxes, service_class._resolve_resource_limits

    def translate(exc):
        if error_type is PolicyError:
            raise exc
        raise error_type(status_code=exc.status_code,
                         detail={"code": "DCU::POLICY", "message": str(exc)}) from exc

    def guard(method):
        @wraps(method)
        def wrapped(*args, **kwargs):
            try:
                return method(*args, **kwargs)
            except PolicyError as exc:
                translate(exc)
        return wrapped

    async def create(self, request):
        try:
            validate_request(request)
        except PolicyError as exc:
            translate(exc)
        return await native_create(self, request)

    @guard
    def resources(self, request):
        limits = request.resource_limits.root if request.resource_limits else {}
        try:
            memory, cpu, _ = native_resources(self, request)
        except (ValueError, OverflowError) as exc:
            raise PolicyError(400, "invalid memory/cpu limit") from exc
        require("memory" not in limits or memory is not None, "invalid memory limit")
        require("cpu" not in limits or cpu is not None, "invalid cpu limit")
        memory, cpu = bounded_resources(memory, cpu)
        return memory, cpu, gpu_count(limits.get("gpu")) or None

    @guard
    def base(self, mem_limit, nano_cpus, network_mode, gpu_count=None):
        require(network_mode == "bridge", "only bridge networking allowed")
        count = 0 if gpu_count is None else gpu_count
        require(type(count) is int and 0 <= count <= 4, "invalid internal GPU count")
        memory, cpu = bounded_resources(mem_limit, nano_cpus)
        return dict(network_mode="bridge", runtime="runc", privileged=False, cap_drop=["ALL"],
                    security_opt=["no-new-privileges:true"], pids_limit=256,
                    mem_limit=memory, memswap_limit=memory, nano_cpus=cpu, _dcu_count=count)

    @guard
    def start(self, sandbox_id, image_uri, bootstrap_command, labels, environment,
              host_config_kwargs, exposed_ports, platform):
        require(image_uri == IMAGE and platform is None, "invalid image/platform")
        cfg = dict(host_config_kwargs)
        count = cfg.pop("_dcu_count")
        safe = base(self, cfg.get("mem_limit"), cfg.get("nano_cpus"), cfg.get("network_mode"), count)
        safe.pop("_dcu_count")
        safe["port_bindings"] = loopback_bindings(cfg.get("port_bindings"))
        require(exposed_ports == ["44772", "8080"], "invalid exposed ports")
        with inventory_lock(self.docker_client) as (used, file):
            free = sorted(set(range(2)) - used)
            require(len(free) >= count, "allowed DCU capacity exhausted", 503)
            ids = free[:count]
            paths = (["/dev/kfd"] + [f"/dev/dri/renderD{128 + i}" for i in ids]) if ids else []
            safe["devices"] = [f"{path}:{path}:rw" for path in paths]
            labels = dict(labels)
            labels.update({OWNER_KEY: OWNER, IDS_KEY: ",".join(map(str, ids))})
            checkpoint(file, sandbox_id)  # Crash/timeout without confirmed create MUST NOT free IDs.
            result = native_start(self, sandbox_id, image_uri, bootstrap_command, labels,
                                  environment, safe, exposed_ports, platform)
            checkpoint(file)
            return result

    @guard
    def restore(self):
        with inventory_lock(self.docker_client):
            native_restore(self)

    @guard
    def no_pull(self, image_uri, auth_config, sandbox_id, platform=None):
        raise PolicyError(400, "image must already be cached; pulls disabled")

    service_class.create_sandbox = create
    service_class._resolve_resource_limits = resources
    service_class._base_host_config_kwargs = base
    service_class._create_and_start_container = start
    service_class._restore_existing_sandboxes = restore
    service_class._pull_image = no_pull


def install():
    """Install hooks only. Caller then imports opensandbox_server.main.app."""
    from fastapi import HTTPException
    from opensandbox_server.services.docker.docker_service import DockerSandboxService
    from opensandbox_server.services.docker import port_allocator
    port_allocator.DOCKER_PUBLISH_HOST = port_allocator.PORT_PROBE_HOST = "127.0.0.1"
    patch_service(DockerSandboxService, HTTPException)
