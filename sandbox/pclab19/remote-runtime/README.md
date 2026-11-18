# New19 bridge/native policy handoff (local implementation only)

## Scope and authority

This is a new profile19 implementation, not a modification of the historical27 deployment. Its fixed runtime root is `/mnt/newdata/metainfer-opensandbox-19-20261113`; pool `pclab2-node19-dcu-4-7`, server `pclab19-safe-dcu`, owner `metainfer-pclab19`. Only renders132–135 (physical4–7) are admissible. CPU-only containers get **no** kfd/render/card nodes. Card aliases and protected renders128–131 are forbidden.

The authoritative topology is the Host catalog. Runtime configuration contains the raw catalog SHA256, deployment identities, fixed image digest and mount identity, **not** a second device/root/transport mapping. The catalog is copied one-way, byte for byte. Any catalog/image/identity change changes the target fingerprint: old bindings, operation journals and owned container labels fail closed; never relabel old state to bypass this guard.

The example is deliberately NOT runnable: the lead must replace its invalid image placeholder with the actual compatible cached `sha256:<64 lowercase hex>` digest. No compatible image is inferred or fabricated by this task.

## Packaging contract for the lead

Source files and destination paths:

```text
deployments/metainfer-opensandbox-pclab19-20261113/bridge/bridge.py
  -> ROOT/bridge.py
deployments/metainfer-opensandbox-pclab19-20261113/adapter/dcu_adapter.py
  -> ROOT/adapter/dcu_adapter.py
deployments/metainfer-opensandbox-pclab19-20261113/adapter/launch.py
  -> ROOT/adapter/launch.py
deployments/metainfer-opensandbox-pclab19-20261113/remote-runtime/target_config.py
  -> ROOT/remote-runtime/target_config.py
Host-authoritative opensandbox-targets.json (exact bytes)
  -> ROOT/config/targets-catalog.json
target-example.json + actual lead-pinned image digest
  -> ROOT/config/target.json
```

The exact target JSON fields are `schemaVersion`, `profile`, `catalogSha256`, `poolId`, `serverId`, `owner`, `image`, and `mount:{target,uuid}`. SchemaVersion is integer1, profile is pclab19. Current catalog SHA256 is `6eed8c85ae2dc996da80c1683ead77f07f2f60964e975d37d1144b049a60445f`.

The loader requires Linux, hostname m12r1n19, exact mounted ext4 UUID at `/mnt/newdata`, rw/nosuid/nodev options, non-symlink root on the same st_dev, canonical render char nodes226:132–135 with matching sysfs dev and catalog BDF. The kfd major is **dynamic**, checked against its sysfs dev (19 observation501:0, not assumed236). These checks stat nodes/read metadata; they do not open GPU nodes. There is no environment bypass. Configuration is bounded regular non-hardlinked, no symlinks or group/world-write.

## Launch, transport and secrets

The lead supplies native OpenSandbox v0.2.2 dependencies/config and the compatible image. Native config must select docker/bridge, no secure_runtime, and a nonempty API key. Launch adapter before importing the real application singleton, with exactly one worker; launcher binds node API127.0.0.1:18090. Cluster API is fixed127.0.0.1:18080. Suggested new service names belong only to19; never restart old27/business services.

```text
ROOT/venv/bin/python ROOT/adapter/launch.py
ROOT/venv/bin/python ROOT/bridge.py --request-id <canonical lowercase UUID>
ROOT/secrets/cluster.env: CLUSTER_SERVICE_API_KEY=<private value>
ROOT/secrets/node.env: OPENSANDBOX_SERVER_API_KEY=<private value>
```

Secrets must be private mode0600 regular files with values at least24characters. Do not print them. The bridge guards target/mount before reading requests/secrets or constructing the Docker SDK. Every request includes `profile:"pclab19"`; public bindings return that profile. Host legacy27 wire behavior remains unchanged.

## Preserved safety and unknown accounting

- Fixed image, request whitelist; no host volumes, privileged, DeviceRequests, cgroup wildcards, host network/namespaces, user-selected host paths or image pull.
- Native allocation uses explicit catalog paths, actual Linux thread+flock locking and actual owned inventory including stopped containers. Labels/masks alone never prove device access. Foreign OpenSandbox, malformed inventory, duplicate physical claims or duplicate native IDs block admission.
- Pending create marker is fsynced before the native call and cleared only after owned physical inventory confirms that exact sandbox. Unconfirmed creation blocks even CPU-only creates/restores; it is not a free-capacity signal.
- Bridge bindings and operation journals are stamped with the target identity. Session/container/managed/provider/project/node/attempt/image/device checks remain strict; live bindings cannot move between otherwise allowed cards. Unknown side effects are never replayed.
- Cleanup is exact managed/provider/container identity only. Verified clean requires confirmed managed404, exact DockerNotFound and empty same-binding inventory. Ambiguous create or transport/inspect failures stay unknown/cleanupPending and cannot free accounting on an arbitrary404.
- Never delete/clear native pending or bridge admission latches automatically. Operator reconciliation must match target ownership, managed/provider/container identity and physical inventory; retain unknown accounting until independently proven. No global rm/prune or business cleanup is implemented.

## Offline acceptance and evidence

Run from the shared repository with bundled Python, no installation:

```text
C:/Users/hm_work/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe -B deployments/metainfer-opensandbox-pclab19-20261113/remote-runtime/run_tests.py
```

For Linux independent pure tests, copy the three test modules preserving bridge/, adapter/, remote-runtime/ and the runner; use the packaged catalog above. The runner also supports the flattened production bridge. Tests use fake APIs/containers and injected targets, never a live daemon/SSH/service/GPU. Linux additionally runs an actual flock exclusion check against a temporary owned test file. Windows explicitly skips that one check and substitutes fcntl only inside the mock tests; production has no lockless fallback.

Test categories: exact132–135/BDF mapping and protected/card aliases; strict JSON/config/request shapes and IDs; mount/host/sysfs identity including dynamic kfd; GPU0/full4 and resource limits; all owned/stopped inventory and pending latches; async/unknown create and no replay; cross-target bind/journal cache; command identity/raw-byte output/explicit exit status; binary/file path and hash safety; exact cleanup including failure cases.

Red logs record tests-first failures (missing modules and reproduced accounting/mount gaps). Repeated green logs and the source-only audit diff are retained in the owned directories. This task did not SSH, mount, install, deploy, start/stop services, create real containers, open GPUs, attack networks, contact GitHub, or alter historical/business files. The lead owns deployment, image pinning, Linux/live verification and phased execution.

## Mandatory security limitation

**Trusted jobs only; not malicious multi-tenant readiness.** Native-auth proxy bypass around Cluster admission is a known unresolved gap. Docker/runc and device whitelisting are not a VM/hardware security boundary or a global exclusivity guarantee. Existing hs-gemma still holds all8 GPU FDs; human confirmation that it will not COMPUTE on4–7 is an operational assumption, not something these mocks or device labels prove. Disk resource is accounting-only, not an enforced native disk quota. Do not present a local green mock suite as deployed or GPU-tested success.
