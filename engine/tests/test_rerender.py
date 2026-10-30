"""Render again: a finished run's transcript.json and plan.json replace the
paid stages (research, transcription, planning, Jev), and only the first
`max_clips` planned clips are rendered into a new run folder."""

import asyncio
import json
from dataclasses import asdict
from types import SimpleNamespace

import pytest

from clip_engine.services import ai_clipping_pipeline as pipeline_module
from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
from clip_engine.services.editorial_context import empty_report
from clip_engine.services.intelligence_planner import ClipPlanSegment
from clip_engine.services.rendering_service import RenderingService, RenderResult
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord


def saved_run(out_dir, run_id="earlier", clips=3):
    """A finished run's files, as the pipeline writes them (asdict output)."""
    run = out_dir / run_id
    run.mkdir(parents=True)
    words = [TranscriptWord("hi", 0, 500), TranscriptWord("there", 500, 1000)]
    segments = [TranscriptSegment(0, 1000, "hi there", speaker_label="A", words=words)]
    (run / "transcript.json").write_text(json.dumps({
        "segments": [asdict(s) for s in segments], "full_text": "hi there", "language": "en",
        "status": "available", "captions_available": True,
    }))
    planned = [ClipPlanSegment(i * 30_000, i * 30_000 + 20_000, 0.9 - i / 10, summary=f"Clip {i}",
                               emphasis_words=["hi"], render_fallback="letterbox",
                               editorial=empty_report() if i == 0 else {"status": "success"} if i == 1 else None)
               for i in range(clips)]
    (run / "plan.json").write_text(json.dumps({
        "segments": [{**asdict(s), "unknown_future_key": 1} for s in planned], "total_clips": clips,
        "target_platform": "tiktok", "insights": "x", "planning_source": "transcript",
    }))
    (run / "job_output.json").write_text("{}")
    return run


@pytest.fixture
def local_pipeline(monkeypatch, tmp_path):
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
    monkeypatch.setattr(settings, "jev_enabled", True)  # a re-render ignores even an opted-in Jev
    monkeypatch.setattr(settings.__class__, "temp_directory", property(lambda self: str(tmp_path / "work")))
    pipeline = AIClippingPipeline()
    pipeline.local_mode = True
    rendered = []

    async def download(url, output_dir):
        meta = SimpleNamespace(title="Test", duration_seconds=120.0, width=1920, height=1080, description="", uploader=None)
        return SimpleNamespace(video_path=str(tmp_path / "source.mp4"), metadata=meta, file_size_bytes=1)

    async def never(*args, **kwargs):
        raise AssertionError("a paid stage ran during a re-render")

    async def render(request):
        rendered.append(request)
        open(request.output_path, "wb").write(b"mp4")
        return RenderResult(output_path=request.output_path, file_size_bytes=3, duration_ms=20_000, layout_type="talking_head")

    monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
    monkeypatch.setattr(pipeline.transcription_service, "transcribe", never)
    monkeypatch.setattr(pipeline.intelligence_planner, "plan_clips", never)
    monkeypatch.setattr(pipeline.source_context_service, "build", never)
    monkeypatch.setattr(pipeline.rendering_service, "render_clip", render)
    monkeypatch.setattr(pipeline, "_update_progress", lambda *args, **kwargs: None)
    return pipeline, rendered, tmp_path / "out"


def test_rerender_reuses_the_saved_transcript_and_plan_for_the_first_clips(local_pipeline):
    pipeline, rendered, out = local_pipeline
    saved_run(out)
    request = ClippingJobRequest(video_url="local.mp4", job_id="again", rerender_from="earlier", max_clips=2,
                                 auto_clip_count=False, banner_handle="@YassInPublic", banner_platforms=["x"])
    result = asyncio.run(pipeline.process_video(request))
    assert result.status == JobStatus.COMPLETED, result.error
    assert [r.title_text for r in rendered] == ["Clip 0", "Clip 1"]
    first = rendered[0]
    assert first.banner_handle == "@YassInPublic" and first.banner_platforms == ["x"]
    assert [w.word for w in first.transcript_segments[0].words] == ["hi", "there"]
    assert first.emphasis_words == ["hi"] and first.editorial_service is None and first.coherence_reviewer is None
    assert first.apply_padding is True  # no Jev: the usual audio padding
    # The new run is self-contained (and can itself be rendered again).
    new_run = out / "again"
    assert (new_run / "transcript.json").exists() and (new_run / "plan.json").exists()
    assert json.loads((new_run / "plan.json").read_text())["total_clips"] == 2
    manifest = json.loads((new_run / "job_output.json").read_text())
    assert manifest["total_clips"] == 2
    assert manifest["metrics"]["requested_settings"]["rerender_from"] == "earlier"
    assert manifest["metrics"]["api_costs"]["total_estimated_cost_usd"] == 0
    audit = json.loads((new_run / "edit_audit.json").read_text())
    assert audit["rerender_from"] == "earlier" and audit["outcome"] == "completed"
    assert [c["status"] for c in audit["candidates"]] == ["rendered", "rendered"]
    # The earlier run is untouched.
    assert not list((out / "earlier").glob("clip_*.mp4"))


def test_rerender_renders_every_planned_clip_when_the_count_is_automatic(local_pipeline):
    pipeline, rendered, out = local_pipeline
    saved_run(out, clips=4)
    result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url="local.mp4", job_id="again", rerender_from="earlier")))
    assert result.status == JobStatus.COMPLETED, result.error
    assert len(rendered) == 4
    # A render_fallback recorded by the earlier run does not carry over.
    assert all(c["render_fallback"] is None for c in json.loads((out / "again" / "job_output.json").read_text())["clips"])


def test_mixed_banner_position_cycles_per_clip(local_pipeline):
    pipeline, rendered, out = local_pipeline
    saved_run(out, clips=5)
    request = ClippingJobRequest(video_url="local.mp4", job_id="again", rerender_from="earlier",
                                 banner_handle="@YassInPublic", banner_position="mixed")
    assert asyncio.run(pipeline.process_video(request)).status == JobStatus.COMPLETED
    assert [r.banner_position for r in rendered] == ["bottom-center", "top-right", "middle-left", "bottom-right", "top-center"]
    with pytest.raises(ValueError):
        ClippingJobRequest(video_url="x", banner_position="left")
    assert ClippingJobRequest(video_url="x", banner_position="bottom").banner_position == "bottom"  # legacy, means bottom-center


def test_rerender_fails_clearly_when_the_run_kept_nothing(local_pipeline):
    pipeline, rendered, out = local_pipeline
    (out / "empty").mkdir(parents=True)
    result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url="local.mp4", job_id="again", rerender_from="empty")))
    assert result.status == JobStatus.FAILED
    assert "no saved transcript and plan" in (result.error or "")
    assert rendered == []


def test_rerender_run_id_is_validated():
    with pytest.raises(ValueError):
        ClippingJobRequest(video_url="x", rerender_from="../other")
    with pytest.raises(ValueError):
        ClippingJobRequest(video_url="x", rerender_from="")
    assert ClippingJobRequest(video_url="x", rerender_from="9e15acb6-5643-457f-80ed-e9ef4dedce57").rerender_from
