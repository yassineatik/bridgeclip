"""The channel banner: platform icons and the creator's handle on every clip.

Placement is pure geometry (layout_renderer.banner_y): above the bottom fifth
of a 9:16 frame, where Shorts, TikTok and Reels draw their buttons, and never
over the captions. Drawing is Pillow only, so most of this runs without
FFmpeg; the one real render needs any FFmpeg on PATH.
"""

import asyncio
import os
from dataclasses import replace
import shutil
import subprocess

import numpy as np
import pytest
from PIL import Image

from clip_engine.services import rendering_service as module
from clip_engine.services.layout_analyzer import Box, ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.layout_renderer import (
    CAPTION_BOTTOM_LIMIT,
    PLATFORM_UI_TOP,
    CAPTION_FACE_GAP,
    CAPTION_TOP_LIMIT,
    CaptionPlacer,
    FaceZone,
    banner_y,
    caption_anchor,
    banner_obstacles,
    banner_x_expr,
    banner_x_span,
    is_banner_position,
    parse_banner_position,
    caption_span,
    faces_during,
    foreground_geometry,
)
from clip_engine.services.rendering_service import (
    BANNER_PLATFORMS,
    MAX_BANNER_CHARS,
    RenderingService,
    RenderRequest,
    banner_icon_path,
)

OUT_W, OUT_H = 1080, 1920
UI_TOP = int(OUT_H * PLATFORM_UI_TOP)
BANNER_H = 48

SHOTS = {
    "talking_head": ShotLayout(0, 4000, LayoutType.TALKING_HEAD),
    "two_shot": ShotLayout(0, 4000, LayoutType.TWO_SHOT, people=[Box(.1, .2, .3, .6), Box(.6, .2, .3, .6)]),
    "screen_cam": ShotLayout(0, 4000, LayoutType.SCREEN_CAM, screen_box=Box(0, 0, 1, 1), cam_box=Box(.7, .7, .3, .3)),
    "letterbox": ShotLayout(0, 4000, LayoutType.SCREEN),
    "tall_inset": ShotLayout(0, 4000, LayoutType.SCREEN, content_box=Box(.3, .05, .4, .9)),
    "wide_inset": ShotLayout(0, 4000, LayoutType.SCREEN, content_box=Box(.1, .2, .8, .6)),
}


def service_without_ffmpeg() -> RenderingService:
    service = RenderingService.__new__(RenderingService)
    service._font_path = service._resolve_font()
    return service


def request(tmp_path, **options) -> RenderRequest:
    return RenderRequest(str(tmp_path / "source.mp4"), str(tmp_path / "clip.mp4"), 0, 4000, 640, 360, **options)


# ------------------------------------------------------------------
# Placement
# ------------------------------------------------------------------


@pytest.mark.parametrize("name", list(SHOTS))
def test_banner_stays_above_the_platform_ui_and_off_the_captions(name):
    shot = SHOTS[name]
    y = banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H)
    assert 0 <= y and y + BANNER_H <= UI_TOP, (name, y)
    cap_top, cap_bottom = caption_span(shot, 640, 360, OUT_W, OUT_H)
    assert y + BANNER_H <= cap_top or y >= cap_bottom, (name, y, cap_top, cap_bottom)


def test_caption_span_brackets_the_anchor_by_alignment():
    for name, shot in SHOTS.items():
        alignment, anchor = caption_anchor(shot, 640, 360, OUT_W, OUT_H)
        top, bottom = caption_span(shot, 640, 360, OUT_W, OUT_H)
        assert top < bottom
        if alignment == 2:
            assert bottom == anchor, name
        else:
            assert top < anchor < bottom, name


def test_letterboxed_screen_puts_the_banner_between_the_picture_and_the_captions():
    shot = SHOTS["letterbox"]
    scaled_h, top = foreground_geometry(shot, 640, 360, OUT_W, OUT_H)
    y = banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H)
    cap_top, _ = caption_span(shot, 640, 360, OUT_W, OUT_H)
    assert top + scaled_h < y < y + BANNER_H < cap_top


def test_a_bar_inside_the_platform_ui_zone_keeps_the_banner_over_the_picture():
    # The bar under this inset starts below the UI line, so the banner may
    # not sit in it; it rests on the lowest safe line instead.
    shot = SHOTS["tall_inset"]
    scaled_h, top = foreground_geometry(shot, 640, 360, OUT_W, OUT_H)
    assert top + scaled_h > UI_TOP
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H) == UI_TOP - BANNER_H


def test_full_frame_banner_sits_on_the_platform_ui_line_and_scales_with_the_frame():
    shot = SHOTS["talking_head"]
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H) == UI_TOP - BANNER_H
    assert banner_y(shot, 640, 360, 540, 960, 24) == int(960 * PLATFORM_UI_TOP) - 24
    # A tall banner is moved up, never allowed to overlap the UI zone.
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, 300) + 300 <= UI_TOP
    # Without captions there is nothing to dodge: it sits on the UI line.
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, 300, avoid_captions=False) == UI_TOP - 300


def test_moved_captions_keep_off_the_banner():
    plan = ClipLayoutPlan([SHOTS["talking_head"]], 640, 360)
    assert banner_obstacles(plan, 640, 360, OUT_W, OUT_H, BANNER_H) == [(UI_TOP - BANNER_H, UI_TOP)]
    top = int(OUT_H * 250 / 1920) + 24
    assert banner_obstacles(plan, 640, 360, OUT_W, OUT_H, BANNER_H, position="top") == [(top, top + BANNER_H)]
    # Captions anchored on a seam move up off a face in the lower panel; a
    # banner sitting just there must not end up under them.
    anchors = [(10**9, 5, 1152)]
    zones = [FaceZone(0, 4000, [(150, 1150, 930, 1800)])]
    without = CaptionPlacer(anchors, zones, OUT_W, OUT_H)(0, 1000, 600, 100)
    assert without[0] == 5 and without[1] + 50 <= 1150
    banner = (without[1] - 30, without[1] + 18)  # right where the caption would go
    with_banner = CaptionPlacer(anchors, zones, OUT_W, OUT_H, obstacles=[banner])(0, 1000, 600, 100)
    assert with_banner[1] + 50 <= banner[0] - CAPTION_FACE_GAP
    assert with_banner[1] >= OUT_H * CAPTION_TOP_LIMIT + 50
    # Obstacles are per anchor: a later shot without one is placed as before.
    two = CaptionPlacer([(2000, 5, 1152), (10**9, 5, 1152)], zones, OUT_W, OUT_H, obstacles=[banner])
    assert two(0, 1000, 600, 100) == with_banner
    assert two(2500, 3000, 600, 100) == without


def test_banner_moves_off_a_face_filling_the_webcam_panel():
    # A close-up in the bottom panel of a screen + webcam shot: the platform
    # UI line and the spot under the captions both cross the face, so Auto
    # goes just above the captions, at the bottom of the screen panel.
    shot = SHOTS["screen_cam"]
    face = (150, 1150, 930, 1800)
    y = banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, faces=[face], banner_w=520)
    cap_top, cap_bottom = caption_span(shot, 640, 360, OUT_W, OUT_H)
    assert y + BANNER_H <= cap_top and y + BANNER_H < face[1]
    assert y != banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H)


def test_banner_only_dodges_faces_under_its_own_columns():
    shot = SHOTS["talking_head"]
    default = banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H)
    off_to_the_side = (0, 1300, 200, 1700)
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, faces=[off_to_the_side], banner_w=520) == default
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, faces=[off_to_the_side]) != default  # unknown width: any face counts


def test_banner_takes_the_least_covered_spot_when_faces_are_everywhere():
    shot = SHOTS["talking_head"]
    everywhere = (0, 0, OUT_W, OUT_H)
    y = banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, faces=[everywhere], banner_w=520)
    assert 0 <= y and y + BANNER_H <= UI_TOP


def test_faces_during_collects_rects_from_overlapping_zones():
    zones = [FaceZone(0, 1000, ((1, 2, 3, 4),)), FaceZone(1000, 2000, ((5, 6, 7, 8),)), FaceZone(3000, 4000, ((9, 9, 9, 9),))]
    assert faces_during(zones, 500, 1500) == [(1, 2, 3, 4), (5, 6, 7, 8)]
    assert faces_during(zones, 2000, 3000) == []


@pytest.mark.parametrize("name", ["talking_head", "two_shot", "screen_cam", "letterbox", "wide_inset"])
def test_positions_pick_their_region_first_and_stay_safe(name):
    shot = SHOTS[name]
    cap_top, cap_bottom = caption_span(shot, 640, 360, OUT_W, OUT_H)
    ys = {p: banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, position=p) for p in ("top", "middle", "bottom", "auto")}
    for p, y in ys.items():
        assert int(OUT_H * 250 / 1920) + 24 <= y and y + BANNER_H <= UI_TOP, (name, p, y)
        assert y + BANNER_H <= cap_top or y >= cap_bottom, (name, p, y)
    assert ys["top"] < ys["middle"] <= ys["bottom"], (name, ys)
    assert ys["auto"] == ys["bottom"] or name in ("letterbox", "wide_inset"), (name, ys)
    # Horizontal alignment never changes the height.
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, position="bottom-left") == ys["bottom"]


def test_top_position_sits_under_the_title_or_at_the_top_edge_without_one():
    shot = SHOTS["talking_head"]
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, position="top") == int(OUT_H * 250 / 1920) + 24
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, position="top", title_shown=False) == int(OUT_H * 110 / 1920)
    # A letterboxed screen puts "top" in the bar above the picture.
    screen = SHOTS["letterbox"]
    scaled_h, picture_top = foreground_geometry(screen, 640, 360, OUT_W, OUT_H)
    y = banner_y(screen, 640, 360, OUT_W, OUT_H, BANNER_H, position="top")
    assert y + BANNER_H <= picture_top


def test_a_chosen_region_stays_put_while_auto_moves_off_a_face():
    shot = SHOTS["screen_cam"]
    face = (150, 1150, 930, 1800)
    # Bottom is all face here: the user asked for it, so it stays at the bottom...
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, position="bottom", faces=[face], banner_w=520) == UI_TOP - BANNER_H
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, position="bottom-left", faces=[face], banner_w=520) == UI_TOP - BANNER_H
    # ...while Auto gets out of the way.
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, faces=[face], banner_w=520) + BANNER_H < face[1]
    # Inside a region, the spot covering the least face wins: with a face
    # only on the platform line, "bottom" takes the spot under the captions.
    low_face = (150, 1500, 930, 1800)
    y = banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, position="bottom", faces=[low_face], banner_w=520)
    assert y == caption_span(shot, 640, 360, OUT_W, OUT_H)[1] + 24 and y != UI_TOP - BANNER_H
    # A face off to the right does not count for a left-aligned banner.
    right_face = (700, 1200, 1000, 1800)
    assert banner_y(SHOTS["talking_head"], 640, 360, OUT_W, OUT_H, BANNER_H, position="bottom-left", faces=[right_face], banner_w=400) == UI_TOP - BANNER_H
    assert banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H, position="unknown") == banner_y(shot, 640, 360, OUT_W, OUT_H, BANNER_H)


def test_position_strings_parse_and_validate():
    assert parse_banner_position("auto") == ("auto", "center")
    assert parse_banner_position("bottom") == ("bottom", "center")
    assert parse_banner_position("top-right") == ("top", "right")
    assert parse_banner_position("sideways") == ("auto", "center")
    assert all(is_banner_position(p) for p in ("auto", "mixed", "top", "middle-left", "bottom-right"))
    assert not any(is_banner_position(p) for p in ("left", "top-top", "bottom-", "", None, 3))
    assert banner_x_expr("left", 1080) == "40" and banner_x_expr("right", 1080) == "W-w-40" and banner_x_expr("center", 1080) == "(W-w)/2"
    assert banner_x_span("left", 1080, 400) == (40, 440) and banner_x_span("right", 1080, 400) == (640, 1040)


# ------------------------------------------------------------------
# Drawing
# ------------------------------------------------------------------


def test_every_platform_ships_an_icon():
    for platform in BANNER_PLATFORMS:
        path = banner_icon_path(platform)
        assert path and os.path.isfile(path), platform
        with Image.open(path) as icon:
            assert icon.size == (128, 128) and icon.mode == "RGBA"
            alpha = np.asarray(icon.getchannel("A"))
            assert alpha.max() == 255 and alpha.min() == 0
    assert banner_icon_path("facebook") is None
    assert banner_icon_path("../fonts/Montserrat-Black") is None


def test_banner_needs_a_handle_and_draws_the_icons_before_it(tmp_path):
    service = service_without_ffmpeg()
    assert service._banner_overlay_image(request(tmp_path, banner_platforms=["youtube"]), 34) is None
    assert service._banner_overlay_image(request(tmp_path, banner_handle="  \n"), 34) is None

    def width_with(platforms):
        path, width, height = service._banner_overlay_image(
            request(tmp_path, banner_handle="@YassInPublic", banner_platforms=platforms), 34,
        )
        assert os.path.isfile(path) and height > 0
        return width

    plain = width_with([])
    one = width_with(["youtube"])
    all_four = width_with(["instagram", "tiktok", "x", "youtube"])
    assert plain < one < all_four
    assert all_four - one == 3 * (one - plain) - 3 * round(34 * 0.45) + 3 * round(34 * 0.3) or all_four > one + 3 * 34
    assert width_with(["facebook", "youtube"]) == one  # unknown platforms are skipped
    assert width_with(["youtube", "youtube"]) == one  # and never drawn twice


def test_banner_handle_keeps_its_case(tmp_path):
    service = service_without_ffmpeg()

    def pixels(handle):
        path, _, _ = service._banner_overlay_image(request(tmp_path, banner_handle=handle), 34)
        with Image.open(path) as image:
            return np.asarray(image.convert("RGBA")).copy()

    typed, upper = pixels("@YassInPublic"), pixels("@YASSINPUBLIC")
    assert typed.shape != upper.shape or not np.array_equal(typed, upper)
    # White text with a dark shadow and nothing else.
    opaque = typed[typed[:, :, 3] == 255]
    assert len(opaque) and (opaque[:, :3] == 255).all(axis=1).any()
    assert ((typed[:, :, 3] > 0) & (typed[:, :, 3] < 255)).any()  # the soft shadow


def test_banner_handle_is_bounded(tmp_path):
    service = service_without_ffmpeg()
    _, long_w, _ = service._banner_overlay_image(request(tmp_path, banner_handle="@" + "x" * 5000), 34)
    _, max_w, _ = service._banner_overlay_image(request(tmp_path, banner_handle="@" + "x" * (MAX_BANNER_CHARS - 1)), 34)
    assert long_w == max_w


def test_overlays_place_the_banner_per_shot_above_the_platform_ui(tmp_path):
    service = service_without_ffmpeg()
    plan = ClipLayoutPlan([SHOTS["talking_head"]], 640, 360)
    req = request(tmp_path, banner_handle="@YassInPublic", banner_platforms=["x"], title_text="A title")
    overlays = service._overlays(req, plan, OUT_W, OUT_H, False)
    assert [os.path.basename(o[0]) for o in overlays] == ["title-0-4000.png", "banner-0-4000.png"]
    path, x_expr, y_expr = overlays[1]
    with Image.open(path) as banner:
        height = banner.height
    assert x_expr == "(W-w)/2" and y_expr == str(UI_TOP - height)
    top = service._overlays(replace(req, banner_position="top"), plan, OUT_W, OUT_H, False)
    assert top[1][2] == str(int(OUT_H * 250 / 1920) + 24)
    corner = service._overlays(replace(req, banner_position="bottom-left"), plan, OUT_W, OUT_H, False)[1]
    assert corner[1:3] == ("40", str(UI_TOP - height))
    assert service._overlays(replace(req, banner_position="top-right"), plan, OUT_W, OUT_H, False)[1][1] == "W-w-40"
    # Without a title card the top spot moves up to the title line.
    no_title = service._overlays(replace(req, banner_position="top", include_title=False), plan, OUT_W, OUT_H, False)
    assert [os.path.basename(o[0]) for o in no_title] == ["banner-0-4000.png"] and no_title[0][2] == str(int(OUT_H * 110 / 1920))
    # Faces seen during the shot move it: a face on the UI line pushes it up.
    moved = service._overlays(req, plan, OUT_W, OUT_H, False, None, [[(100, 1400, 980, 1900)]])
    assert int(moved[1][2]) + height <= 1400
    # Landscape keeps the corner placement; "top" takes the top right corner.
    landscape = service._overlays(req, plan, 1920, 1080, True)
    assert landscape[-1][1:3] == ("W-w-20", "H-h-16")
    assert service._overlays(replace(req, banner_position="top"), plan, 1920, 1080, True)[-1][1:3] == ("(W-w)/2", "20")
    assert service._overlays(replace(req, banner_position="top-right"), plan, 1920, 1080, True)[-1][1:3] == ("W-w-20", "20")
    assert service._overlays(replace(req, banner_position="middle-left"), plan, 1920, 1080, True)[-1][1:3] == ("20", "(H-h)/2")


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg required")
def test_rendered_clip_shows_the_banner_only_above_the_platform_ui(tmp_path, monkeypatch):
    from .test_av_sync import source
    ffmpeg = shutil.which("ffmpeg")
    service = RenderingService()
    service._video_codec_args = lambda *args: ["-c:v", "mpeg4", "-q:v", "2", "-bf", "2"]
    monkeypatch.setattr(module, "get_output_dimensions", lambda *_: (180, 320))

    async def plan(request, width, height, start, duration):
        return ClipLayoutPlan([ShotLayout(0, duration, LayoutType.TALKING_HEAD)], width, height)

    monkeypatch.setattr(service, "_plan_layout", plan)
    path = source(tmp_path, duration=4)
    req = RenderRequest(str(path), str(tmp_path / "clip.mp4"), 0, 4000, 64, 64, pacing="natural",
                        apply_padding=False, include_captions=False, include_title=False,
                        banner_handle="@YassInPublic", banner_platforms=list(BANNER_PLATFORMS))
    result = asyncio.run(service.render_clip(req))
    assert result.render_fallback is None
    frame = subprocess.run(
        [ffmpeg, "-v", "error", "-ss", "1.0", "-i", result.output_path, "-frames:v", "1",
         "-pix_fmt", "gray", "-f", "rawvideo", "-"], capture_output=True, check=True, timeout=120,
    ).stdout
    gray = np.frombuffer(frame, np.uint8).reshape(320, 180)
    bright_rows = np.flatnonzero((gray > 160).any(axis=1))
    assert len(bright_rows), "no banner drawn"
    assert bright_rows.max() < 320 * PLATFORM_UI_TOP
    assert bright_rows.min() > 320 * 0.6
    assert not os.path.exists(tmp_path / "banner-0-4000.png")  # cleaned up after the render
