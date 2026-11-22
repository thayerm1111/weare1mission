#!/usr/bin/env python3
"""Render the One Mission welcome from a timed storyboard and a narration file.

  python3 scripts/media/render_welcome.py --audio narration.wav --output welcome-v1.mp4
  python3 scripts/media/render_welcome.py --output /tmp/welcome.mp4 --stills-only
  python3 scripts/media/render_welcome.py --output /tmp/sample.mp4 --test-seconds 8

Requires Pillow, NumPy and FFmpeg; it makes no network requests. Text/cards are
rasterized once at 2x resolution. Settled compositions are cached; only short
reveals, focus rings and the chapter progress line are drawn for each frame.
Every value in the UI is a label or placeholder, never a fabricated account,
signal outcome, profit, or performance count.
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
import subprocess
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS, AA = 720, 1280, 24, 2
INK = "#f4f3f1"
MUTED = "#b8bbc6"
DIM = "#828796"
EDGE = "#343640"
SURFACE = "#202127"
RAISED = "#292b34"
GOLD = "#e7c57b"
BLUE = "#87baff"
MINT = "#91d8b9"
VIOLET = "#b6a5f4"
ACCENTS = {"floor": GOLD, "atlas": VIOLET, "tools": BLUE, "generate": MINT,
           "review": GOLD, "flow": BLUE, "execute": GOLD, "manage": MINT, "next": VIOLET}


def rgb(color: str) -> tuple[int, int, int]:
    return tuple(int(color.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))


@lru_cache(maxsize=96)
def font(size: int, weight: str = "regular"):
    name = {"regular": "Regular", "bold": "Bold", "heavy": "Heavy"}[weight]
    path = Path(f"/usr/share/fonts/truetype/lato/Lato-{name}.ttf")
    if not path.is_file():
        path = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if weight != "regular"
                    else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    if not path.is_file():
        raise RuntimeError("Install Lato or DejaVu Sans before rendering.")
    return ImageFont.truetype(str(path), size * AA)


def wrapped(text: str, size: int, width: float, weight: str = "regular") -> list[str]:
    face = font(size, weight)
    limit = width * AA
    lines = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for word in paragraph.split():
            trial = f"{current} {word}".strip()
            if face.getlength(trial) <= limit:
                current = trial
                continue
            if current:
                lines.append(current)
            # Never allow a long token to escape its box.
            current = ""
            for char in word:
                if current and face.getlength(current + char) > limit:
                    lines.append(current)
                    current = char
                else:
                    current += char
        lines.append(current)
    return lines


class Paint:
    def __init__(self, width: int, height: int):
        self.width, self.height = width, height
        self.im = Image.new("RGBA", (width * AA, height * AA))
        self.d = ImageDraw.Draw(self.im)

    def rect(self, box, fill=SURFACE, radius=18, outline=None, line=1):
        self.d.rounded_rectangle(tuple(round(v * AA) for v in box), radius=radius * AA,
                                 fill=fill, outline=outline, width=line * AA)

    def line(self, points, color=EDGE, width=1):
        self.d.line([(round(x * AA), round(y * AA)) for x, y in points], fill=color,
                    width=round(width * AA), joint="curve")

    def circle(self, box, fill=None, outline=None, line=1):
        self.d.ellipse(tuple(round(v * AA) for v in box), fill=fill, outline=outline, width=line * AA)

    def text(self, value, x, y, width, size=24, color=INK, weight="regular", max_height=None, align="left"):
        value = str(value)
        chosen = size
        while True:
            lines = wrapped(value, chosen, width, weight)
            leading = round(chosen * 1.24)
            height = len(lines) * leading
            if max_height is None or height <= max_height:
                break
            chosen -= 1
            if chosen < 18:
                raise ValueError(f"Text cannot fit safely: {value!r} in {width}×{max_height}")
        if x < 0 or y < 0 or x + width > self.width + 1 or y + height > self.height + 1:
            raise ValueError(f"Text would clip: {value!r}, box={x,y,width,height}, canvas={self.width,self.height}")
        face = font(chosen, weight)
        for index, line in enumerate(lines):
            left = x * AA
            if align != "left":
                free = width * AA - face.getlength(line)
                left += free if align == "right" else free / 2
            self.d.text((round(left), round((y + index * leading) * AA)), line, font=face, fill=color, anchor="lt")
        return y + height

    def pill(self, text, x, y, width, accent=INK, filled=False, height=40, size=20):
        self.rect((x, y, x + width, y + height), fill=accent if filled else RAISED,
                  radius=height // 2, outline=None if filled else EDGE)
        self.text(text, x + 10, y + (height - size * 1.24) / 2 + 1, width - 20, size,
                  "#17181d" if filled else accent, "bold", max_height=height - 8, align="center")

    def button(self, text, x, y, width, accent=INK, primary=True, height=62, size=25):
        self.rect((x, y, x + width, y + height), fill=accent if primary else RAISED,
                  radius=15, outline=None if primary else EDGE)
        self.text(text, x + 18, y + (height - size * 1.24) / 2 + 1, width - 36, size,
                  "#17181d" if primary else INK, "bold", max_height=height - 12, align="center")

    def card(self):
        self.rect((1, 1, self.width - 1, self.height - 1), fill=SURFACE, radius=24, outline=EDGE)
        self.line([(26, 1), (self.width - 26, 1)], "#44444e")

    def finish(self):
        return self.im.resize((self.width, self.height), Image.Resampling.LANCZOS)


@lru_cache(maxsize=8)
def background(accent: str):
    yy, xx = np.mgrid[0:H, 0:W]
    bloom = np.exp(-(((xx - W * .88) / 470) ** 2 + ((yy - 170) / 500) ** 2))
    floor = np.exp(-(((xx - 90) / 600) ** 2 + ((yy - 1200) / 280) ** 2))
    base = np.zeros((H, W, 3), dtype=np.float32) + np.array([19, 20, 25])
    base += bloom[:, :, None] * np.array(rgb(accent)) * .085
    base += floor[:, :, None] * np.array([5, 6, 10])
    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGB")


def logo(p: Paint, x=48, y=52, size=28, color=GOLD):
    """The actual OM mark from AppShell's 58×28 inline SVG."""
    scale = size / 28
    point = lambda px, py: (x + px * scale, y + py * scale)
    p.d.ellipse(tuple(round(v * AA) for v in (*point(2.4, 4.4), *point(21.6, 23.6))),
                outline=color, width=round(2.4 * scale * AA))
    points = [(22.5, 24), (30.5, 5.2)]
    for control1, control2, end, line_end in (
            ((31, 4), (32.7, 4), (33.2, 5.2), (38.2, 17.5)),
            ((38.7, 18.7), (40.4, 18.7), (40.9, 17.5), (45.9, 5.2)),
            ((46.4, 4), (48.1, 4), (48.6, 5.2), (56.8, 24))):
        start = points[-1]
        for step in range(1, 13):
            t = step / 12
            points.append(tuple((1 - t) ** 3 * start[axis] + 3 * (1 - t) ** 2 * t * control1[axis]
                                + 3 * (1 - t) * t ** 2 * control2[axis] + t ** 3 * end[axis]
                                for axis in (0, 1)))
        points.append(line_end)
    p.line([point(px, py) for px, py in points], color, 2.4 * scale)
    for px, py in (points[0], points[-1]):
        cx, cy = point(px, py)
        r = 1.2 * scale
        p.circle((cx - r, cy - r, cx + r, cy + r), fill=color)


def header(chapter, index, count):
    accent = ACCENTS.get(chapter["kind"], GOLD)
    base = background(accent).copy()
    p = Paint(W, H)
    logo(p, color=accent)
    p.text("ONE MISSION", 124, 53, 350, 23, INK, "heavy")
    p.text(f"{index + 1:02d} / {count:02d}", 566, 57, 106, 18, DIM, align="right")
    p.text("Illustrative walkthrough", 48, 101, 624, 17, DIM)
    bottom = p.text(chapter["heading"], 48, 160, 624, 52, INK, "heavy", max_height=133)
    p.text(chapter["subtitle"], 48, bottom + 17, 624, 25, MUTED, max_height=70)
    base.paste(p.finish(), (0, 0), p.finish())
    return base


@dataclass
class Layer:
    image: Image.Image
    x: int
    y: int
    at: float = .15
    reveal: float = .52


@dataclass
class Phase:
    start: float
    layers: list[Layer]
    focuses: list[tuple[int, int, int, int]] = field(default_factory=list)
    orb: tuple[int, int, int] | None = None
    cache: dict[int, Image.Image] = field(default_factory=dict)


def layer(p, x, y, at=.15):
    return Layer(p.finish(), x, y, at)


def note(text, accent=GOLD, height=96, size=23):
    p = Paint(624, height)
    p.rect((1, 1, 623, height - 1), fill="#28272b", outline=EDGE, radius=17)
    p.rect((1, 18, 5, height - 18), fill=accent, radius=2)
    p.text(text, 23, 19, 579, size, accent, "bold", max_height=height - 34)
    return p


def field_row(p, label, placeholder, y, width=568):
    p.text(label, 28, y, width, 21, MUTED, "bold")
    p.rect((28, y + 33, 28 + width, y + 89), fill="#191a20", radius=12, outline=EDGE)
    p.text(placeholder, 44, y + 49, width - 32, 22, DIM, max_height=30)


def settings_row(p, label, value, y, accent=MUTED):
    p.text(label, 28, y, 392, 24, INK, max_height=56)
    p.text(value, 432, y + 2, 164, 21, accent, "bold", max_height=54, align="right")
    p.line([(28, y + 57), (596, y + 57)])


@lru_cache(maxsize=4)
def atlas_orb(size=124):
    """Use the app's Atlas orbit artwork, preserving its original proportions."""
    p = Paint(size, size)
    cx = cy = size / 2
    for radius in range(size // 2, 5, -1):
        k = 1 - radius / (size / 2)
        p.circle((cx - radius, cy - radius, cx + radius, cy + radius), fill=(139, 119, 224, round(48 * k)))
    asset = Path(__file__).resolve().parents[2] / "public/images/atlas-loop.webp"
    with Image.open(asset) as source:
        orbit = source.convert("RGBA")
    orbit = orbit.crop(orbit.getchannel("A").getbbox())
    ratio = (size - 4) * AA / max(orbit.size)
    orbit = orbit.resize(tuple(round(v * ratio) for v in orbit.size), Image.Resampling.LANCZOS)
    p.im.alpha_composite(orbit, ((size * AA - orbit.width) // 2, (size * AA - orbit.height) // 2))
    return p.finish()


def floor_scene():
    a = Paint(624, 126); a.card()
    a.text("Your selected account", 28, 23, 568, 28, INK, "bold")
    a.text("Balance  ·  Equity  ·  Active trades", 28, 72, 568, 23, MUTED)
    b = Paint(624, 264); b.card()
    b.text("Gold context", 28, 25, 568, 28, INK, "bold")
    b.text("Understand the market before your next step.", 28, 70, 568, 22, MUTED)
    for y in (136, 180, 224): b.line([(28, y), (596, y)], "#30323c")
    pts = [(28, 220), (80, 202), (127, 214), (175, 177), (222, 190), (265, 163), (310, 174), (356, 133), (405, 149), (453, 124), (496, 139), (543, 118), (596, 127)]
    b.line(pts, BLUE, 3)
    c = Paint(624, 176)
    c.button("Talk to Atlas", 0, 0, 624, VIOLET)
    c.button("Find a signal", 0, 80, 624, primary=False)
    return [Phase(0, [layer(a, 48, 378), layer(b, 48, 525, .48), layer(c, 48, 814, .82)], [(48, 814, 672, 876), (48, 894, 672, 956)])]


def atlas_scene():
    p = Paint(624, 432); p.card()
    p.im.alpha_composite(atlas_orb(108).resize((216, 216)), (258 * AA, 24 * AA))
    p.text("Your in-app assistant", 28, 154, 568, 27, INK, "bold", align="center")
    p.rect((28, 216, 596, 294), fill="#2a2638", radius=18, outline="#554968")
    p.text("What’s happening with gold?", 45, 240, 534, 26, INK, max_height=40, align="center")
    p.button("Talk to Atlas", 28, 326, 278, VIOLET, size=23)
    p.button("Type a question", 320, 326, 276, primary=False, size=23)
    return [Phase(0, [layer(p, 48, 378), layer(note("Allow microphone access when prompted.", VIOLET), 48, 838, .75)], [(76, 704, 354, 766), (368, 704, 644, 766)], (360, 456, 56))]


def tools_scene():
    rows = [("OM AI Plays", "Setups in your chosen market", MINT), ("GENX", "Focused gold reads", GOLD),
            ("Pulse", "Scan markets for ideas", BLUE), ("Gold Command Center", "Atlas’s dedicated gold workspace", VIOLET)]
    layers, boxes = [], []
    for i, (name, sub, accent) in enumerate(rows):
        p = Paint(624, 120); p.card()
        p.rect((25, 27, 30, 92), fill=accent, radius=2)
        p.text(name, 48, 22, 546, 28, INK, "bold")
        p.text(sub, 48, 68, 546, 22, MUTED)
        y = 370 + i * 136
        layers.append(layer(p, 48, y, .12 + i * .24)); boxes.append((48, y, 672, y + 120))
    layers.append(layer(note("Atlas stays with you across the app.", VIOLET, height=88), 48, 928, 1.1))
    return [Phase(0, layers, boxes)]


def generate_scene():
    p = Paint(624, 294); p.card()
    p.text("OM AI Plays", 28, 24, 568, 28, INK, "bold")
    p.rect((28, 80, 302, 158), fill="#191a20", radius=13, outline=EDGE)
    p.rect((318, 80, 596, 158), fill="#191a20", radius=13, outline=EDGE)
    p.text("Market", 46, 94, 236, 22, MUTED)
    p.text("Choose market", 46, 124, 236, 20, INK, "bold")
    p.text("Style", 336, 94, 238, 22, MUTED)
    p.text("Choose style", 336, 124, 238, 20, INK, "bold")
    p.text("Check the displayed cost", 28, 180, 568, 21, MUTED)
    p.button("Generate play", 28, 216, 568, MINT)
    q = Paint(624, 278); q.card()
    q.text("GENX", 28, 24, 568, 28, INK, "bold")
    q.text("Horizon", 28, 72, 568, 21, MUTED)
    for i, name in enumerate(("Quick", "Intraday", "Swing")):
        q.pill(name, 28 + i * 193, 111, 182, GOLD if i == 1 else MUTED, filled=i == 1)
    q.text("Review the cost before continuing", 28, 170, 568, 21, MUTED)
    q.button("Analyze gold", 28, 206, 568, GOLD)
    return [Phase(0, [layer(p, 48, 370), layer(q, 48, 690, .65)], [(76, 586, 644, 648), (76, 896, 644, 958)])]


def review_scene():
    p = Paint(624, 488); p.card()
    p.text("OM AI Plays", 28, 24, 568, 28, INK, "bold")
    p.text("Read the setup’s current status", 28, 70, 568, 23, GOLD)
    for i, label in enumerate(("Entry", "Stop", "Targets")):
        y = 126 + i * 56
        p.text(label, 28, y, 215, 25, INK, "bold")
        p.text("Review the level", 286, y + 1, 310, 22, MUTED, align="right")
        p.line([(28, y + 42), (596, y + 42)])
    p.text("Timeframe breakdown", 28, 310, 568, 24, INK, "bold")
    for i, tf in enumerate(("4H", "1H", "30M", "15M", "5M")):
        x = 28 + i * 115
        p.rect((x, 358, x + 108, 422), fill=RAISED, radius=13, outline=EDGE)
        p.text(tf, x + 8, 378, 92, 24, INK, "bold", align="center")
    p.text("Tap a timeframe to review its checks.", 28, 445, 568, 21, MUTED)
    q = Paint(624, 70); q.button("Explain this signal", 0, 0, 624, GOLD)
    return [Phase(0, [layer(p, 48, 370), layer(q, 48, 884, .6), layer(note("Waiting or unconfirmed? Read the label.", GOLD, 88), 48, 976, .95)], [(76 + i * 115, 728, 184 + i * 115, 792) for i in range(5)])]


def flow_scene():
    a = Paint(624, 594); a.card()
    a.text("Connect account", 28, 24, 568, 29, INK, "bold")
    a.pill("Demo", 28, 82, 274, BLUE, filled=True, height=46, size=22)
    a.pill("Live", 318, 82, 278, MUTED, height=46, size=22)
    a.text("Practice money", 28, 142, 274, 20, MUTED, align="center")
    a.text("Real funds", 318, 142, 278, 20, MUTED, align="center")
    field_row(a, "Server", "Your broker’s server", 196)
    field_row(a, "TradeLocker email", "Your TradeLocker email", 301)
    field_row(a, "TradeLocker password", "••••••••", 406)
    a.button("Connect account", 28, 525, 568, BLUE)
    b = Paint(624, 492); b.card()
    b.text("Manage accounts", 28, 24, 568, 29, INK, "bold")
    b.text("Manage execution", 28, 70, 568, 22, MUTED)
    b.rect((28, 118, 596, 220), fill="#332e26", radius=15, outline="#695b3d")
    b.text("New accounts start with\nTrading on", 47, 137, 530, 27, GOLD, "bold", max_height=78)
    settings_row(b, "Trading", "On", 252, GOLD)
    settings_row(b, "Follow every GENX signal", "Review", 316)
    settings_row(b, "Risk", "Review", 380)
    b.text("Auto-run FLOW", 28, 444, 392, 24, INK)
    b.text("Review", 432, 446, 164, 21, MUTED, "bold", align="right")
    warning = note("Enabled automation can place trades without another prompt.", GOLD, 122, 24)
    return [Phase(0, [layer(a, 48, 370)], [(76, 599, 644, 655), (76, 704, 644, 760), (76, 809, 644, 865), (76, 895, 644, 957)]),
            Phase(.49, [layer(b, 48, 370), layer(warning, 48, 890, .6)], [(76, 488, 644, 590), (76, 622, 644, 679), (76, 814, 644, 864)])]


def execute_scene():
    a = Paint(624, 484); a.card()
    a.pill("Execute BUY", 28, 24, 230, GOLD, filled=True, height=44, size=23)
    a.text("Ticket", 28, 96, 568, 30, INK, "bold")
    for i, (label, value) in enumerate((("Place on", "Receiving accounts"), ("Account", "Review selection"), ("Risk", "Review amount"), ("Size", "Review lots"), ("At the stop", "Review potential loss"))):
        y = 157 + i * 61
        a.text(label, 28, y, 205, 23, INK, "bold")
        a.text(value, 240, y + 1, 356, 22, MUTED, max_height=35, align="right")
        if i < 4: a.line([(28, y + 45), (596, y + 45)])
    b = Paint(624, 484); b.card()
    b.text("Final confirmation", 28, 29, 568, 31, INK, "bold")
    b.text("Review the order you are about to place.", 28, 88, 568, 25, MUTED, max_height=68)
    for i, name in enumerate(("Receiving accounts", "Risk and size", "Current price")):
        y = 183 + i * 57
        b.circle((28, y + 6, 40, y + 18), fill=GOLD)
        b.text(name, 58, y, 538, 25, INK)
    b.button("Yes, place buy", 28, 371, 568, GOLD)
    b.text("Only confirm when you’re ready.", 28, 448, 568, 21, MUTED, align="center")
    warning = note("Manual tickets place at the current price.", GOLD, 98, 24)
    return [Phase(0, [layer(a, 48, 370), layer(warning, 48, 887, .75)], [(76, 394, 306, 438), (76, 527, 644, 572), (76, 649, 644, 694)]),
            Phase(.58, [layer(b, 48, 370), layer(warning, 48, 887, .25)], [(76, 741, 644, 803)])]


def manage_scene():
    p = Paint(624, 370); p.card()
    p.text("Active trades", 28, 23, 568, 29, INK, "bold")
    p.text("Your selected account", 28, 70, 568, 23, MUTED)
    p.line([(28, 115), (596, 115)])
    p.text("Running pips", 28, 143, 568, 24, INK, "bold")
    p.text("Price movement from your broker", 28, 183, 568, 23, MUTED)
    p.button("Take partial", 28, 247, 176, MINT, size=21, height=56)
    p.button("Breakeven", 215, 247, 176, primary=False, size=21, height=56)
    p.button("Close trade", 402, 247, 194, primary=False, size=21, height=56)
    p.text("Each change opens a review.", 28, 326, 568, 22, MUTED)
    q = Paint(624, 242); q.card()
    q.text("Winning streaks", 28, 24, 568, 28, INK, "bold")
    for x, title, sub, color in ((28, "FLOW", "Your account", MINT), (324, "GENX", "Community callouts", GOLD)):
        q.rect((x, 82, x + 272, 211), fill=RAISED, radius=16, outline=EDGE)
        q.text(title, x + 17, 99, 238, 27, color, "bold")
        q.text(sub, x + 17, 142, 238, 21, MUTED, max_height=54)
    r = note("Take 25% or 50% only after reviewing the exact lot amount.", MINT, 98, 22)
    return [Phase(0, [layer(p, 48, 370), layer(q, 48, 754, .55), layer(r, 48, 1008, .9)], [(76, 617, 252, 673), (263, 617, 439, 673), (450, 617, 644, 673)])]


def next_scene():
    p = Paint(624, 470); p.card()
    p.im.alpha_composite(atlas_orb(136).resize((272, 272)), (244 * AA, 35 * AA))
    p.text("Ask Atlas", 28, 203, 568, 38, INK, "heavy", align="center")
    p.button("Talk to Atlas", 28, 283, 568, VIOLET, height=70, size=27)
    p.text("Or type your first question.", 28, 386, 568, 24, MUTED, align="center")
    q = Paint(624, 106)
    q.text("AI helps you understand setups.\nResults aren’t guaranteed.", 8, 12, 608, 24, MUTED, max_height=88, align="center")
    return [Phase(0, [layer(p, 48, 390), layer(q, 48, 900, .75)], [(76, 673, 644, 743)], (360, 493, 70))]


SCENES = {"floor": floor_scene, "atlas": atlas_scene, "tools": tools_scene, "generate": generate_scene,
          "review": review_scene, "flow": flow_scene, "execute": execute_scene, "manage": manage_scene, "next": next_scene}


def ease(value):
    value = max(0., min(1., value))
    return 1 - (1 - value) ** 3


class Renderer:
    def __init__(self, storyboard):
        self.chapters = storyboard["chapters"]
        if not self.chapters:
            raise ValueError("Storyboard requires chapters.")
        previous = 0.
        for chapter in self.chapters:
            if chapter["kind"] not in SCENES:
                raise ValueError(f"Unknown scene kind: {chapter['kind']}")
            start, end = float(chapter["start"]), float(chapter["end"])
            if start < 0 or end <= start or abs(start - previous) > .06:
                raise ValueError("Chapter intervals must be positive, ordered and contiguous from zero.")
            previous = end
        self.duration = previous
        self.starts = [float(ch["start"]) for ch in self.chapters]
        self.bases = [header(ch, i, len(self.chapters)) for i, ch in enumerate(self.chapters)]
        self.phases = [SCENES[ch["kind"]]() for ch in self.chapters]

    def phase_frame(self, index, phase_index, elapsed):
        phase = self.phases[index][phase_index]
        count = sum(elapsed >= item.at + item.reveal for item in phase.layers)
        if count not in phase.cache:
            image = self.bases[index].copy()
            for item in phase.layers[:count]:
                image.paste(item.image, (item.x, item.y), item.image)
            phase.cache[count] = image
        image = phase.cache[count].copy()
        for item in phase.layers[count:]:
            progress = ease((elapsed - item.at) / item.reveal)
            if progress <= 0:
                continue
            alpha = item.image.getchannel("A").point([round(i * progress) for i in range(256)])
            image.paste(item.image, (item.x, item.y + round(14 * (1 - progress))), alpha)
        accent = rgb(ACCENTS[self.chapters[index]["kind"]])
        if elapsed > 1.5 and phase.focuses:
            focused = phase.focuses[int((elapsed - 1.5) / 3.2) % len(phase.focuses)]
            opacity = round(44 + 55 * (math.sin((elapsed - 1.5) * math.pi / 1.6) ** 2))
            overlay = Image.new("RGBA", (W, H))
            d = ImageDraw.Draw(overlay)
            d.rounded_rectangle(tuple(v + (-3 if n < 2 else 3) for n, v in enumerate(focused)), radius=17, outline=(*accent, opacity), width=2)
            image.paste(overlay, (0, 0), overlay)
        if phase.orb and elapsed > .8:
            x, y, r = phase.orb
            radius = r + 6 + 3 * math.sin(elapsed * 1.5)
            overlay = Image.new("RGBA", (W, H))
            ImageDraw.Draw(overlay).ellipse((x - radius, y - radius, x + radius, y + radius), outline=(*accent, 65), width=1)
            image.paste(overlay, (0, 0), overlay)
        return image

    def scene_frame(self, index, local):
        chapter = self.chapters[index]
        length = float(chapter["end"]) - float(chapter["start"])
        phases = self.phases[index]
        starts = [p.start * length for p in phases]
        phase_index = max(0, bisect.bisect_right(starts, local) - 1)
        elapsed = local - starts[phase_index]
        image = self.phase_frame(index, phase_index, elapsed)
        if phase_index and elapsed < .42:
            previous = self.phase_frame(index, phase_index - 1, starts[phase_index] - starts[phase_index - 1])
            image = Image.blend(previous, image, ease(elapsed / .42))
        return image

    def frame(self, at):
        index = max(0, min(len(self.chapters) - 1, bisect.bisect_right(self.starts, at) - 1))
        local = at - self.starts[index]
        image = self.scene_frame(index, local)
        if index and local < .42:
            prev = self.chapters[index - 1]
            previous = self.scene_frame(index - 1, float(prev["end"]) - float(prev["start"]))
            image = Image.blend(previous, image, ease(local / .42))
        d = ImageDraw.Draw(image)
        count, gap = len(self.chapters), 7
        segment = (624 - gap * (count - 1)) / count
        for i in range(count):
            x = round(48 + i * (segment + gap))
            d.rounded_rectangle((x, 1120, round(x + segment), 1124), radius=2, fill=EDGE)
            fraction = 1 if i < index else max(0, min(1, local / (float(self.chapters[i]["end"]) - self.starts[i]))) if i == index else 0
            if fraction > 0:
                d.rounded_rectangle((x, 1120, x + max(1, round(segment * fraction)), 1124), radius=2, fill=ACCENTS[self.chapters[index]["kind"]])
        return image

    def artifacts(self, poster, contact_sheet, frame_dir=None):
        poster.parent.mkdir(parents=True, exist_ok=True)
        self.frame(min(3., self.duration / 2)).save(poster, "WEBP", quality=90, method=6)
        samples = []
        for i, ch in enumerate(self.chapters):
            duration = float(ch["end"]) - float(ch["start"])
            for number, fraction in enumerate((.3, .78) if len(self.phases[i]) > 1 else (.55,)):
                at = float(ch["start"]) + max(min(1.8, duration * fraction), duration * fraction)
                frame = self.frame(min(float(ch["end"]) - .1, at))
                title = f"{i + 1:02d} · {ch['title']}" + (f" · {number + 1}" if len(self.phases[i]) > 1 else "")
                samples.append((title, frame))
                if frame_dir:
                    frame_dir.mkdir(parents=True, exist_ok=True)
                    frame.save(frame_dir / f"{i + 1:02d}-{ch['kind']}-{number + 1}.png")
        tile_w, tile_h, label_h, columns, pad = 240, 427, 64, 3, 18
        rows = math.ceil(len(samples) / columns)
        sheet = Image.new("RGB", (columns * tile_w + (columns + 1) * pad, rows * (tile_h + label_h) + (rows + 1) * pad), "#111217")
        for index, (title, frame) in enumerate(samples):
            x = pad + (index % columns) * (tile_w + pad)
            y = pad + (index // columns) * (tile_h + label_h + pad)
            sheet.paste(frame.resize((tile_w, tile_h), Image.Resampling.LANCZOS), (x, y))
            text = Paint(tile_w, label_h)
            text.text(title, 1, 12, tile_w - 2, 18, MUTED, max_height=50)
            label = text.finish()
            sheet.paste(label, (x, y + tile_h), label)
        contact_sheet.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(contact_sheet)


def audio_duration(path):
    value = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)], text=True)
    return float(value.strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--storyboard", type=Path, default=Path(__file__).with_name("welcome-storyboard.json"))
    parser.add_argument("--audio", type=Path, help="Final, already-generated narration. Never requested from a provider here.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--poster", type=Path)
    parser.add_argument("--contact-sheet", type=Path)
    parser.add_argument("--frame-dir", type=Path, help="Optional representative full-size PNGs for review.")
    parser.add_argument("--stills-only", action="store_true")
    parser.add_argument("--test-seconds", type=float, help="Short verification render; permits an explicitly silent audio track.")
    parser.add_argument("--fps", type=int, default=FPS)
    parser.add_argument("--crf", type=int, default=21)
    parser.add_argument("--preset", default="fast")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if args.fps <= 0 or args.threads <= 0 or not 0 <= args.crf <= 40:
        parser.error("Use positive fps/threads and CRF0–40.")
    renderer = Renderer(json.loads(args.storyboard.read_text()))
    poster = args.poster or args.output.with_name(f"{args.output.stem}-poster.webp")
    contact = args.contact_sheet or args.output.with_name(f"{args.output.stem}-storyboard.png")
    renderer.artifacts(poster, contact, args.frame_dir)
    print(f"Poster: {poster}\nStoryboard: {contact}", flush=True)
    if args.stills_only:
        return
    if args.audio is None and args.test_seconds is None:
        parser.error("Production rendering requires --audio. Use --stills-only or --test-seconds for silent QA.")
    duration = min(renderer.duration, args.test_seconds) if args.test_seconds is not None else renderer.duration
    if duration <= 0:
        parser.error("Render duration must be positive.")
    if args.audio:
        length = audio_duration(args.audio)
        if args.test_seconds is None and length > duration + .25:
            parser.error(f"Narration is {length:.2f}s, beyond storyboard end {duration:.2f}s. Align chapter end times first; narration will not be clipped.")
        if args.test_seconds is None and duration - length > 1:
            print(f"Note: narration ends {duration - length:.2f}s before the final frame; audio will be padded with silence.", flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    command = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(args.fps), "-i", "pipe:0"]
    command += ["-i", str(args.audio)] if args.audio else ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
    command += ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", args.preset, "-crf", str(args.crf), "-pix_fmt", "yuv420p", "-threads", str(args.threads),
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,apad", "-t", f"{duration:.6f}", "-movflags", "+faststart", str(args.output)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    frames = math.ceil(duration * args.fps)
    try:
        for number in range(frames):
            process.stdin.write(renderer.frame(number / args.fps).tobytes())
            if number % (args.fps * 10) == 0:
                print(f"Rendered {number / args.fps:.0f}/{duration:.1f}s", flush=True)
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError("FFmpeg did not finish successfully.")
    except BaseException:
        if process.poll() is None:
            process.kill()
        process.wait()
        raise
    print(f"Video: {args.output} · {duration:.2f}s · {W}×{H} · {args.fps}fps", flush=True)


if __name__ == "__main__":
    main()
