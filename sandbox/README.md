# sandbox/ — opensandbox-cluster remote execution bundles

Remote-side implementation of the GPU-isolated sandbox execution backend that the
MetaInfer plugin drives. The Host half (scheduling, ledger, lease, prepare/execute/
collect/release RPC, admission preflight) lives in the plugin and was submitted in
[PR #87](https://github.com/HuangPuStar/MetaInfer/pull/87) / issue #86.

This directory packages the **exact bytes deployed on the two sites** together with
their offline unit suites, so a reviewer can reproduce the remote half without SSH
access and an operator can re-install a site from the repository alone.

## Fidelity contract

- The eight files listed in `pins.json` are byte-for-byte identical to the deployed
  roots checked on 2026-11-14/16. Their SHA-256 values are the same `codeSha256`
  pins the Host verifies during preflight (`host/sandbox-targets.js`).
- `pclab19/config/targets-catalog.json` and `pclab27/config/targets-catalog.json`
  are byte-copies of the Host-authoritative catalogs. Each `config/target.json`
  must hash to its sibling catalog's `catalogSha256` (checked by
  `verify_hashes.py`).
- Any edit to a pinned file requires a matching pin update in the plugin; otherwise
  preflight fails closed. Do not hand-edit the deployed copies.

Two adapter generations are pinned on purpose — they are **not** one codebase with
different constants:

| Site | Adapter style | Cards | Root |
| --- | --- | --- | --- |
| `pclab19` | `target_config`-driven (identity labels, `Target`, `configure()`, `runtime_guard()`) | renderD132–135 | `/mnt/newdata/metainfer-opensandbox-19-20261113` |
| `pclab27` | older hardcoded build (`PATH_IDS` renderD128/129 + card1/2, fixed owner) | renderD128–129 | `/data/opensandbox-cluster-metainfer-20261111` |

`bridge.py` is identical on both sites; the adapters differ. Do not unify them
without re-running the live matrix.

## Layout

```text
sandbox/
  README.md
  pins.json                  # codeSha256 + config catalog hashes
  verify_hashes.py           # offline byte/pin verification
  run_tests.py               # runs both offline suites
  pclab19/
    bridge.py
    bridge/test_bridge.py
    adapter/{dcu_adapter.py,launch.py,test_dcu_adapter.py}
    remote-runtime/{README.md,run_tests.py,target_config.py,test_target_config.py}
    config/{target.json,targets-catalog.json}
  pclab27/
    bridge.py
    adapter/{dcu_adapter.py,launch.py,test_dcu_adapter.py}
    remote-runtime/target_config.py
    config/{target.json,targets-catalog.json}
```

## Deployment mapping

Copy the site directory to its root, preserving relative paths:

| Bundle path | Destination |
| --- | --- |
| `<site>/bridge.py` | `ROOT/bridge.py` |
| `<site>/adapter/dcu_adapter.py` | `ROOT/adapter/dcu_adapter.py` |
| `<site>/adapter/launch.py` | `ROOT/adapter/launch.py` |
| `<site>/remote-runtime/target_config.py` | `ROOT/remote-runtime/target_config.py` |
| `<site>/config/target.json` | `ROOT/config/target.json` |
| `<site>/config/targets-catalog.json` | `ROOT/config/targets-catalog.json` |

Test files are optional in production and only needed for offline acceptance.
Read the deployed catalog one-way from the Host plugin; never edit it on the server.

Launch (from the remote root, with the site virtualenv):

```text
ROOT/venv/bin/python ROOT/adapter/launch.py
ROOT/venv/bin/python ROOT/bridge.py --request-id <lowercase-uuid>
```

Secrets are **not** in this repository. The bridge expects
`ROOT/secrets/cluster.env` (`CLUSTER_SERVICE_API_KEY`) and
`ROOT/secrets/node.env` (`OPENSANDBOX_SERVER_API_KEY`), each a `0600` regular
file with a value of at least 24 characters.

`config/target.json` contains only public identity: schema version, profile,
catalog SHA-256, pool/server/owner ids, image digest and mount target + UUID.
The image digest is part of the target fingerprint; changing it invalidates old
bindings and journals by design.

## Offline verification

Run with any Python 3.10+ interpreter (the bundled DSH Python works); no Docker,
SSH, GPU, network or credentials are touched:

```text
python -B sandbox/verify_hashes.py
python -B sandbox/run_tests.py
```

Expected: all pins match; `pclab19` suite 83 tests OK (one flock test skipped on
Windows) and `pclab27` suite 22 tests OK (one flock test skipped on Windows).

The suites use fake Docker clients and injected targets. Windows skips only the
real `flock` exclusion check; production has no lockless fallback.

### Test-only adaptations

The production bytes above are untouched. Two test files were adapted so the
suites run from a plain repository checkout:

- `pclab19/remote-runtime/test_target_config.py` resolves the catalog as
  deployed root → bundle-local `config/targets-catalog.json` → legacy developer
  path, instead of only the legacy path.
- `pclab27/adapter/test_dcu_adapter.py` fixtures were reduced from the historical
  four-card layout to the deployed two-card layout (renderD128/129, card1/2), so
  the stale expectations match the pinned adapter.

Test files are not covered by `codeSha256`; only `pins.json` files are.

## Security boundary

**Trusted jobs only; not malicious multi-tenant readiness.** The native-auth
proxy can bypass cluster admission — a known unresolved gap. Docker/runc plus
device whitelisting is not a VM or hardware security boundary and provides no
global exclusivity guarantee. Disk is accounting-only, not an enforced quota.
The `pclab19/remote-runtime/README.md` file is the original deployment handoff
note and repeats these limits; this README is the authoritative packaging
contract.
