"""The heavy detail payloads revalidate from a fingerprint, not from bytes.

Why this file exists.  ``/iterations`` is the biggest response the WebUI serves
(measured on this machine: 5.7 MB for a typical finished four-worker task, 20 MB
for the heaviest).  Two separate defects made keeping such a page open expensive,
and both are pinned here:

  * the server built and hashed the whole body *before* deciding whether the
    client already had it, so an unchanged poll cost exactly as much as a
    changed one (43-58 ms of file reads + 31-35 ms of ``json.dumps``); and
  * the ``/state-signature`` gate the frontend polls first was blind to
    ``workers/*/runs/*/experiments.jsonl`` -- the round feed a real run writes --
    so appended rounds never moved the signature and the page froze on a stale
    round list.

The fix is that the signature and the ETag are the same value, which makes
"unchanged" one statement instead of two that can disagree.
"""

from __future__ import annotations

import json

import pytest

from metainfer.server import app as app_module
from metainfer.tasks.dcu_kernel_auto_opt.server import routes as dkao_routes

from .conftest import register_dkao_task

TASK = "dkao-reval"


@pytest.fixture(autouse=True)
def _clean_payload_cache():
    """Payloads are cached by (dirs, signature); keep tests hermetic."""
    dkao_routes._PAYLOAD_CACHE.clear()
    dkao_routes._PAYLOAD_CACHE_BYTES = 0
    yield
    dkao_routes._PAYLOAD_CACHE.clear()
    dkao_routes._PAYLOAD_CACHE_BYTES = 0


def _workspace(tmp_path, rounds: int = 2, heavy: bool = False):
    """A task laid out the way a real run writes it: workers/<id>/runs/<shape>."""
    state = tmp_path / "state"
    workspace = tmp_path / "workspace"
    register_dkao_task(state, workspace, task_id=TASK)
    (state / "run.json").write_text(
        json.dumps({"current_phase": "parallel_explore", "current_iteration": 1}),
        "utf-8")
    (workspace / "plan.json").write_text(
        json.dumps({"shapes": [{"id": "shape_a", "M": 16}],
                    "assignments": [{"worker_id": "worker_0", "shapes": ["shape_a"]}]}),
        "utf-8")
    root = workspace / "workers" / "worker_0"
    (root).mkdir(parents=True)
    (root / "status.json").write_text(json.dumps({
        "worker_id": "worker_0", "gpu": 0, "state": "optimizing",
        "shape_id": "shape_a"}), "utf-8")
    feed = root / "runs" / "shape_a" / "experiments.jsonl"
    feed.parent.mkdir(parents=True)
    for n in range(1, rounds + 1):
        _append_round(feed, n, heavy=heavy)
    return state, workspace, feed


def _append_round(feed, n: int, heavy: bool = False):
    row = {
        "iteration": n, "accepted": True, "correctness_passed": True,
        "shape_id": "shape_a", "hypothesis": "round %d" % n,
        "metrics": {"median_us": 10.0 - n, "p90_us": 11.0 - n},
        "artifact_dir": "artifacts/round-%d" % n,
    }
    if heavy:
        # The per-round fields no browser code reads; candidate_isa is the
        # dominant one at ~35 KiB per round in production data.
        row["candidate_isa"] = {"instructions": ["v_fma"] * 200, "available": True}
        row["inline_asm_source"] = "v_fma_f32 " * 500
        row["profile_evidence"] = {"pmc": {"VALU": 1.0}}
        row["isa_optimization"] = {"strategy": "inline_asm"}
    with feed.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")


def _url(client, path: str, params: dict | None = None):
    return client.get(f"/api/dcu-kernel-auto-opt/{TASK}{path}", params=params or {})


# --------------------------------------------------------------------------- #
# the gate must see the round feed
# --------------------------------------------------------------------------- #

def test_signature_moves_when_a_round_is_appended(client, tmp_path):
    """The regression: runs/*/experiments.jsonl decides whether rounds changed.

    Under the old signature this returned the same digest before and after,
    so the panel reported UNCHANGED and never re-fetched -- a frozen list.
    """
    _state, _workspace_dir, feed = _workspace(tmp_path, rounds=1)
    before = _url(client, "/state-signature").json()["signature"]

    _append_round(feed, 2)
    after = _url(client, "/state-signature").json()["signature"]

    assert after != before, (
        "an appended round did not move the signature: the detail page would "
        "stay frozen on its old round list")


def test_appended_round_is_served_in_full_not_as_304(client, tmp_path):
    """A new round must produce a new body and a new ETag."""
    _state, _workspace_dir, feed = _workspace(tmp_path, rounds=1)
    first = _url(client, "/iterations")
    assert first.status_code == 200
    etag = first.headers["etag"]
    assert len(first.json()["workers"][0]["experiments"]) == 1

    _append_round(feed, 2)
    changed = _url(client, "/iterations", {"view": "lanes"})
    _again = client.get(
        f"/api/dcu-kernel-auto-opt/{TASK}/iterations",
        params={"view": "lanes"}, headers={"If-None-Match": etag})
    assert changed.status_code == 200
    assert changed.headers["etag"] != etag
    assert _again.status_code == 200, "state changed but the server said 304"
    assert len(changed.json()["workers"][0]["experiments"]) == 2


# --------------------------------------------------------------------------- #
# an unchanged poll must not rebuild
# --------------------------------------------------------------------------- #

def test_an_unchanged_poll_does_not_rebuild_the_payload(client, tmp_path, monkeypatch):
    """The core of the fix: 304 is decided before the body is built."""
    _workspace(tmp_path, rounds=2)
    calls = {"n": 0}
    real = dkao_routes.read_worker_lanes

    def counting(*args, **kwargs):
        calls["n"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(dkao_routes, "read_worker_lanes", counting)

    first = _url(client, "/iterations", {"view": "lanes"})
    assert first.status_code == 200
    assert calls["n"] == 1, "the first request must build the payload"

    for _ in range(4):
        again = client.get(
            f"/api/dcu-kernel-auto-opt/{TASK}/iterations",
            params={"view": "lanes"},
            headers={"If-None-Match": first.headers["etag"]})
        assert again.status_code == 304
        assert not again.content
    assert calls["n"] == 1, (
        "an unchanged poll rebuilt the payload: the ETag is being derived from "
        "the body instead of from the fingerprint")


def test_summary_revalidates_too(client, tmp_path):
    _workspace(tmp_path, rounds=1)
    first = _url(client, "/summary")
    assert first.status_code == 200
    assert first.headers.get("etag")
    again = client.get(f"/api/dcu-kernel-auto-opt/{TASK}/summary",
                       headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 304


# --------------------------------------------------------------------------- #
# the oversized-body cliff
# --------------------------------------------------------------------------- #

def test_a_payload_past_the_middleware_cap_still_revalidates(
    client, tmp_path, monkeypatch
):
    """The 20 MB task used to lose its ETag and re-send 20 MB every poll.

    The middleware only content-hashes bodies up to ``_ETAG_MAX_BYTES``, and
    past that it silently emitted no ETag at all -- four tasks on this machine
    are already past it.  These routes now revalidate themselves, so the cap no
    longer applies to them.  Shrinking the cap to a few bytes stands in for a
    payload that outgrows it.
    """
    _workspace(tmp_path, rounds=2)
    monkeypatch.setattr(app_module, "_ETAG_MAX_BYTES", 8)

    first = _url(client, "/iterations", {"view": "lanes"})
    assert first.status_code == 200
    assert first.headers.get("etag"), (
        "the heavy payload lost its ETag once it outgrew the middleware cap")

    again = client.get(f"/api/dcu-kernel-auto-opt/{TASK}/iterations",
                       params={"view": "lanes"},
                       headers={"If-None-Match": first.headers["etag"]})
    assert again.status_code == 304
    assert not again.content


# --------------------------------------------------------------------------- #
# ?view=lanes
# --------------------------------------------------------------------------- #

def test_the_default_body_is_unchanged(client, tmp_path):
    """`view=lanes` is opt-in: the default contract keeps every field."""
    _workspace(tmp_path, rounds=1, heavy=True)
    body = _url(client, "/iterations").json()
    lane = body["workers"][0]
    experiment = lane["experiments"][0]
    assert "candidate_isa" in experiment
    assert "inline_asm_source" in experiment


def test_lanes_view_drops_only_what_no_frontend_reads(client, tmp_path):
    _workspace(tmp_path, rounds=1, heavy=True)
    body = _url(client, "/iterations", {"view": "lanes"}).json()
    experiment = body["workers"][0]["experiments"][0]

    for dropped in ("candidate_isa", "inline_asm_source",
                    "profile_evidence", "isa_optimization"):
        assert dropped not in experiment
    # The fields the detail view actually renders must survive.
    for kept in ("iteration", "shape_id", "metrics", "accepted",
                 "correctness_passed", "hypothesis", "artifact_dir"):
        assert kept in experiment, f"{kept} is rendered by the frontend"


def test_lanes_view_keeps_the_lane_scalars(client, tmp_path):
    """Lane-level fields the panel binds to, minus the unused `latest` blob."""
    _workspace(tmp_path, rounds=1)
    lane = _url(client, "/iterations", {"view": "lanes"}).json()["workers"][0]
    for kept in ("worker_id", "gpu", "state", "experiments",
                 "bootstrap_attempts", "guidance"):
        assert kept in lane, f"{kept} is rendered by the frontend"
    assert "latest" not in lane


def test_the_two_views_do_not_share_an_etag(client, tmp_path):
    """Two cuts of one state must not collide in a client's cache."""
    _workspace(tmp_path, rounds=1, heavy=True)
    full = _url(client, "/iterations")
    lanes = _url(client, "/iterations", {"view": "lanes"})
    assert full.headers["etag"] != lanes.headers["etag"]

    # Revalidating the full view with the lanes tag must not answer 304.
    wrong = client.get(f"/api/dcu-kernel-auto-opt/{TASK}/iterations",
                       headers={"If-None-Match": lanes.headers["etag"]})
    assert wrong.status_code == 200


def test_an_unknown_view_falls_back_to_the_full_body(client, tmp_path):
    """A stray query string cannot invent a third cache entry."""
    _workspace(tmp_path, rounds=1, heavy=True)
    body = _url(client, "/iterations", {"view": "nonsense"}).json()
    assert "candidate_isa" in body["workers"][0]["experiments"][0]


# --------------------------------------------------------------------------- #
# non-finite floats
# --------------------------------------------------------------------------- #

def test_non_finite_floats_serialise_as_null(client, tmp_path):
    """`inf` must become `null`, exactly as FastAPI's response model did.

    The handlers now return a `Response`, which bypasses the Pydantic step that
    used to do this.  Getting it wrong is not cosmetic in either direction:
    `allow_nan=True` emits a bare `Infinity` that the browser's `JSON.parse`
    rejects (the whole detail page breaks), and `allow_nan=False` raises, i.e.
    a 500 on any task whose round file holds a non-finite measurement.  Real
    data does: `experiments.jsonl` is written with `json.dumps`' default
    `allow_nan=True`.
    """
    _state, workspace_dir, feed = _workspace(tmp_path, rounds=0)
    with feed.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "iteration": 1, "correctness_passed": True, "shape_id": "shape_a",
            "acceptance": {"candidate_us": float("inf"),
                           "best_us": 1.5,
                           "candidate_p90_us": float("-inf"),
                           "ratio": float("nan")},
        }) + "\n")

    for view in (None, "lanes"):
        params = {"view": view} if view else {}
        resp = _url(client, "/iterations", params)
        assert resp.status_code == 200, resp.text
        assert b"Infinity" not in resp.content, (
            "a bare Infinity is not valid JSON: the browser's JSON.parse "
            "rejects it and the detail page stops rendering")
        assert b"NaN" not in resp.content

        acceptance = resp.json()["workers"][0]["experiments"][0]["acceptance"]
        assert acceptance["candidate_us"] is None
        assert acceptance["candidate_p90_us"] is None
        assert acceptance["ratio"] is None
        # Finite values keep their exact value.
        assert acceptance["best_us"] == 1.5
