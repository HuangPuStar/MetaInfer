"""GPU visibility policy for worker29.

DTK accepts either HIP_VISIBLE_DEVICES or ROCR_VISIBLE_DEVICES. Setting both
to the same non-zero physical index applies filtering twice and can hide the
device, so this task standardizes on HIP_VISIBLE_DEVICES only.

The number handed over is a host HCU ordinal: ``hy-smi`` prints it as
``DCU[n]``, and it is the same index the measurement gate reads that card's
state with (see :mod:`metainfer.orchestrator.gpu_inventory`).  The air board
exposes eight of them, the liquid board four, so the allowed set is discovered
rather than hard-coded -- and callers that know their task's own placement pass
it in as ``allowed``, which makes a wrong index fail here instead of silently
running on a card the task never asked for (possibly one somebody else is
using).
"""

from __future__ import annotations

from typing import Dict, Iterable, MutableMapping, Optional

from metainfer.orchestrator import gpu_inventory


def bind_worker_gpu(
    env: MutableMapping[str, str],
    physical_gpu: int,
    *,
    allowed: Optional[Iterable[int]] = None,
) -> Dict[str, str]:
    """Point ``HIP_VISIBLE_DEVICES`` at one card.

    ``allowed`` is the task's own device set when the caller knows it; without
    it every card this machine exposes is acceptable (current behaviour).
    """
    if not gpu_inventory.is_addressable(physical_gpu, allowed):
        if allowed is None:
            listed = ",".join(str(d) for d in gpu_inventory.devices())
        else:
            listed = ",".join(str(int(d)) for d in allowed)
        raise ValueError(
            f"physical_gpu must be one of {listed or '<none>'}, "
            f"got {physical_gpu}"
        )
    env.pop("ROCR_VISIBLE_DEVICES", None)
    env["HIP_VISIBLE_DEVICES"] = str(int(physical_gpu))
    return {"HIP_VISIBLE_DEVICES": str(int(physical_gpu))}


def hide_gpus_from_control_plane(
    env: MutableMapping[str, str],
) -> Dict[str, str]:
    env.pop("ROCR_VISIBLE_DEVICES", None)
    env["HIP_VISIBLE_DEVICES"] = ""
    return {"HIP_VISIBLE_DEVICES": ""}
