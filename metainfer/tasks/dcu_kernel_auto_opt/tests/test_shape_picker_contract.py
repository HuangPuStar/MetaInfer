"""The shape picker must only offer shapes the trusted contract accepts.

A user picked a shape from the New Task form and the task died in ``prepare``:

    tp1_wqkv_a_m16: shape (M=16, N=1536, K=4096) is outside the fixed API
    contract ...: tp_size must be 4 or 8, got 1

The picker's static topology list carried a ``tp_size: 1`` entry for every
model, and the W8A8 API contract only defines TP 4 and TP 8 shards — so that
choice could never work, no matter what else the user did. This test keeps the
two in step: anything the picker can emit must pass the contract's own
validator.
"""

from __future__ import annotations

import re
from pathlib import Path

from ..api.int8w8a8gemm.int8_w8a8_gemm_api import validate_optimization_shape

_STATIC = Path(__file__).resolve().parents[1] / "static"
_PICKER = _STATIC / "dkao-shape-input.js"


def _picker_source() -> str:
    return _PICKER.read_text(encoding="utf-8")


def test_the_picker_offers_no_topology_outside_the_contract():
    """Every ``tp_size`` in the static catalog must be contract-valid."""
    source = _picker_source()
    tp_sizes = {int(v) for v in re.findall(r"tp_size:\s*(\d+)", source)}
    assert tp_sizes, "the picker no longer declares any topology"
    assert tp_sizes <= {4, 8}, (
        f"the picker offers TP {sorted(tp_sizes)}; the contract defines 4 and 8")


def test_a_shape_from_the_pickers_catalog_is_accepted_by_the_contract():
    """The catalog's (K, N) pairs must belong to the shard they are listed under."""
    source = _picker_source()
    # Pair each topology's tp_size with the operators listed inside it, so a
    # mislabelled entry (tp4 shape under the tp1 block) cannot hide.
    topology = None
    checked = 0
    for line in source.splitlines():
        found = re.search(r"tp_size:\s*(\d+)", line)
        if found:
            topology = int(found.group(1))
            continue
        entry = re.search(
            r'operator:\s*"([^"]+)",\s*K:\s*(\d+),\s*N:\s*(\d+)', line)
        if entry and topology is not None:
            operator, k, n = entry.group(1), int(entry.group(2)), int(entry.group(3))
            if topology not in (4, 8):
                continue
            validate_optimization_shape({
                "tp_size": topology, "operator": operator,
                "M": 16, "N": n, "K": k})
            checked += 1
    assert checked > 10, f"only {checked} catalog shapes were validated"


def test_the_contract_really_rejects_tp1():
    """The premise of the fix: TP=1 is not a legal optimization shape."""
    import pytest

    with pytest.raises(ValueError, match="tp_size must be 4 or 8"):
        validate_optimization_shape({
            "tp_size": 1, "operator": "wqkv_a", "M": 16, "N": 1536, "K": 4096})
