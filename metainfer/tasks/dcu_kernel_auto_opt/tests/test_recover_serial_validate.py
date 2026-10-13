"""Batch selection for ``recover_serial_validate``.

A merge-and-validate batch covers one M at a time, because the frozen API packs
a weight once (``prepare_weight`` has no ``M``) and therefore every M variant of
one ``(N, K)`` has to be served by one kernel + one packing.  These tests pin the
selection rules, including the failure modes that would silently merge the wrong
set.
"""

from __future__ import annotations

import dataclasses

import pytest

from ..orchestrator.config import load_config
from ..orchestrator.recover_serial_validate import (
    reconstruct_workers,
    restrict_to_batch,
    select_shape_ids,
)

SHAPE_CONFIG = """
model: Hy3 (Hunyuan 3)
assignment_mode: manual
shape_scope: subset
shapes:
  - {id: qkv_m8, M: 8, N: 1280, K: 4096, tp_size: 8, operator: "qkv_proj"}
  - {id: qkv_m16, M: 16, N: 1280, K: 4096, tp_size: 8, operator: "qkv_proj"}
  - {id: qkv_m4096, M: 4096, N: 1280, K: 4096, tp_size: 8, operator: "qkv_proj"}
  - {id: o_m8, M: 8, N: 4096, K: 1024, tp_size: 8, operator: "o_proj"}
  - {id: o_m4096, M: 4096, N: 4096, K: 1024, tp_size: 8, operator: "o_proj"}
assignments:
  worker_2: {gpu: 2, shapes: [qkv_m8, qkv_m16, qkv_m4096]}
  worker_3: {gpu: 3, shapes: [o_m8, o_m4096]}
"""


def _config():
    return load_config({
        "answers": {
            "execution_mode": "Mock (no GPU)",
            "shape_config": SHAPE_CONFIG,
            "minimum_improvement_percent": 1.0,
        }
    })


def test_empty_selector_means_every_shape():
    assert select_shape_ids(_config()) is None


def test_one_m_per_batch_keeps_every_weight_unique():
    config = _config()
    batch = select_shape_ids(config, m_values="8")
    assert batch == {"qkv_m8", "o_m8"}
    # Each (N, K) appears once, which is the whole point of the batch.
    pairs = []
    for shape in config.shapes.values():
        if shape.id in batch:
            pairs.append((shape.params["N"], shape.params["K"]))
    assert len(pairs) == len(set(pairs))


def test_several_m_values_and_explicit_ids_union():
    config = _config()
    assert select_shape_ids(config, m_values="8, 4096") == {
        "qkv_m8", "qkv_m4096", "o_m8", "o_m4096",
    }
    assert select_shape_ids(config, shape_ids="qkv_m16") == {"qkv_m16"}


def test_an_m_with_no_shape_is_an_error():
    with pytest.raises(SystemExit, match="no shape has M"):
        select_shape_ids(_config(), m_values="64")


def test_an_unknown_shape_id_is_an_error():
    with pytest.raises(SystemExit, match="unknown shape id"):
        select_shape_ids(_config(), shape_ids="nope")


def test_reconstruct_workers_honours_the_batch(tmp_path):
    """Only the batch's accepted manifests are merged, lanes stay intact."""
    config = _config()
    for worker_id, shape_ids in (("worker_2", ["qkv_m8", "qkv_m16"]),
                                 ("worker_3", ["o_m8"])):
        for shape_id in shape_ids:
            target = (
                tmp_path / "workers" / worker_id / "accepted" / shape_id
            )
            target.mkdir(parents=True)
            (target / "manifest.json").write_text(
                '{"source": "s.hip", "object": "o.o", "metrics": {}}',
                encoding="utf-8",
            )
    everything = reconstruct_workers(tmp_path, config)
    assert sorted(everything) == ["worker_2", "worker_3"]
    assert sorted(everything["worker_2"]["shapes"]) == ["qkv_m16", "qkv_m8"]

    batch = reconstruct_workers(tmp_path, config, wanted={"qkv_m8", "o_m8"})
    assert sorted(batch) == ["worker_2", "worker_3"]
    assert sorted(batch["worker_2"]["shapes"]) == ["qkv_m8"]
    assert sorted(batch["worker_3"]["shapes"]) == ["o_m8"]

    # A lane with nothing in this batch disappears rather than merging empty.
    assert reconstruct_workers(tmp_path, config, wanted={"o_m8"}) == {
        "worker_3": {"shapes": {"o_m8": everything["worker_3"]["shapes"]["o_m8"]}}
    }


def test_the_batch_is_visible_to_the_synthesizer():
    """Regression: ``_synthesize_final_candidate`` re-derives its shape list.

    It builds ``best_by_shape`` from ``config.assignments`` rather than from the
    ``workers`` mapping it is given, so a batch that only rebuilt one M has to
    hand it a restricted config -- otherwise it looks up another M's metrics
    under a lane this batch never reconstructed and dies with a KeyError on the
    first shape of that other M.
    """
    config = _config()
    kept = [
        dataclasses.replace(assignment, shape_ids=[
            shape_id for shape_id in assignment.shape_ids
            if shape_id.endswith("_m8")
        ])
        for assignment in config.assignments
    ]
    kept = [assignment for assignment in kept if assignment.shape_ids]
    batch_config = restrict_to_batch(config, kept)

    assert [(a.worker_id, a.shape_ids) for a in batch_config.assignments] == [
        ("worker_2", ["qkv_m8"]), ("worker_3", ["o_m8"]),
    ]
    # The batch config must be a copy: the task's own config is untouched.
    assert [len(a.shape_ids) for a in config.assignments] == [3, 2]
