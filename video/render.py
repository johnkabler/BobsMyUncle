"""Motion-graphic explainer for bmu (BobsMyUncle), rendered frame by frame with Pillow and piped to ffmpeg.

Usage:  python3 render.py [out.mp4] [--preview SCENE_INDEX] [--still SCENE_INDEX SECONDS]
Text holds are sized for comfortable reading (~0.4 s per word plus 2-3 s of settle time).
"""
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1920, 1080, 30
HERE = os.path.dirname(os.path.abspath(__file__))

# ---------- palette ----------
BG0 = (11, 13, 19)
BG1 = (22, 26, 38)
TEXT = (232, 234, 240)
MUTED = (150, 158, 176)
CYAN = (110, 168, 254)
GREEN = (91, 209, 117)
RED = (255, 107, 107)
AMBER = (245, 176, 65)
PURPLE = (176, 132, 255)
PANEL = (24, 28, 40)

_fonts = {}


def font(size, style='regular'):
    key = (size, style)
    if key not in _fonts:
        if style == 'mono':
            _fonts[key] = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', size, index=0)
        elif style == 'monob':
            _fonts[key] = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', size, index=1)
        elif style == 'italic':
            f = ImageFont.truetype('/System/Library/Fonts/SFNSItalic.ttf', size)
            f.set_variation_by_name('Light Italic')
            _fonts[key] = f
        else:
            # SF Pro (variable) has arrows, ✗, superscripts etc. that Helvetica Neue lacks
            f = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', size)
            f.set_variation_by_name({'regular': 'Regular', 'bold': 'Bold', 'light': 'Light', 'medium': 'Medium', 'black': 'Black', 'ultralight': 'Ultralight'}[style])
            _fonts[key] = f
    return _fonts[key]


# ---------- animation helpers ----------
GA = 1.0  # global alpha for scene fades


def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def ease(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def ease_io(x):
    x = clamp(x)
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def prog(t, start, dur=0.7):
    return ease((t - start) / dur)


def col(c, a=1.0):
    return (c[0], c[1], c[2], int(255 * clamp(a) * GA))


def lerp(a, b, x):
    return a + (b - a) * x


def text(d, xy, s, f, c=TEXT, a=1.0, anchor='la', rise=0.0):
    if a <= 0:
        return
    x, y = xy
    d.text((x, y + rise), s, font=f, fill=col(c, a), anchor=anchor)


def appear(d, xy, s, f, t, start, c=TEXT, anchor='la', dur=0.7, dist=24):
    p = prog(t, start, dur)
    text(d, xy, s, f, c, p, anchor, rise=(1 - p) * dist)
    return p


def wrap(s, f, maxw):
    words, lines, cur = s.split(), [], ''
    for w in words:
        trial = (cur + ' ' + w).strip()
        if f.getlength(trial) <= maxw:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def para(d, xy, s, f, t, start, maxw, c=TEXT, lh=1.35, dur=0.7):
    """Paragraph that fades/rises in as a block. Returns bottom y."""
    x, y = xy
    p = prog(t, start, dur)
    for ln in wrap(s, f, maxw):
        text(d, (x, y), ln, f, c, p, rise=(1 - p) * 20)
        y += f.size * lh
    return y


def rrect(d, box, r, fill=None, outline=None, width=2, a=1.0):
    d.rounded_rectangle(box, r, fill=col(fill, a) if fill else None, outline=col(outline, a) if outline else None, width=width)


def arrow(d, p0, p1, c, a=1.0, width=4, head=16, frac=1.0):
    if frac <= 0 or a <= 0:
        return
    x0, y0 = p0
    x1, y1 = lerp(x0, p1[0], frac), lerp(y0, p1[1], frac)
    d.line([(x0, y0), (x1, y1)], fill=col(c, a), width=width)
    ang = math.atan2(y1 - y0, x1 - x0)
    if frac > 0.98:
        pts = [(x1, y1), (x1 - head * math.cos(ang - 0.45), y1 - head * math.sin(ang - 0.45)), (x1 - head * math.cos(ang + 0.45), y1 - head * math.sin(ang + 0.45))]
        d.polygon(pts, fill=col(c, a))


def heading(d, t, title, kicker=None, c=CYAN):
    p = prog(t, 0.2, 0.8)
    d.rectangle([120, 120, 120 + 10, 120 + 70], fill=col(c, p))
    text(d, (152, 112), title, font(68, 'bold'), TEXT, p, rise=(1 - p) * 20)
    if kicker:
        text(d, (154, 196), kicker, font(32, 'light'), MUTED, prog(t, 0.6, 0.8))


def bullets(d, t, items, x, y, start, gap, maxw, f=None, c=TEXT, dot=CYAN, spacing=26):
    f = f or font(40, 'light')
    for i, s in enumerate(items):
        st = start + i * gap
        p = prog(t, st, 0.7)
        d.ellipse([x, y + f.size * 0.42, x + 12, y + f.size * 0.42 + 12], fill=col(dot, p))
        y = para(d, (x + 36, y), s, f, t, st, maxw - 36, c) + spacing
    return y


# ---------- background ----------
def make_bg():
    img = Image.new('RGB', (W, H), BG0)
    px = img.load()
    for yy in range(0, H, 2):
        for xx in range(0, W, 2):
            dx, dy = (xx - W * 0.7) / W, (yy - H * 0.2) / H
            k = clamp(1 - math.sqrt(dx * dx + dy * dy) * 1.1)
            c = tuple(int(lerp(BG0[i], BG1[i], k)) for i in range(3))
            px[xx, yy] = c
            if xx + 1 < W:
                px[xx + 1, yy] = c
            if yy + 1 < H:
                px[xx, yy + 1] = c
                if xx + 1 < W:
                    px[xx + 1, yy + 1] = c
    return img  # RGB: ImageDraw(..., 'RGBA') then alpha-blends onto it


DOTS = [((i * 137.508) % W, (i * 97.13) % H, 0.3 + (i % 7) / 10, (i % 5) + 1) for i in range(70)]


def draw_bg(d, T):
    off = (T * 12) % 80
    for x in range(-80, W + 80, 80):
        d.line([(x + off, 0), (x + off, H)], fill=(255, 255, 255, 10))
    for y in range(-80, H + 80, 80):
        d.line([(0, y + off * 0.5), (W, y + off * 0.5)], fill=(255, 255, 255, 10))
    for (x, y, sp, r) in DOTS:
        yy = (y - T * 18 * sp) % H
        xx = x + math.sin(T * 0.3 + y) * 20
        d.ellipse([xx - r, yy - r, xx + r, yy + r], fill=(110, 168, 254, 40))


# =====================================================================
# Scenes: each is (duration_seconds, draw_fn(d, t, D)). Durations are whole bars (2.5 s at 96 BPM).
# =====================================================================

def s_title(d, t, D):
    # floating UML boxes being wired together
    boxes = [(300, 300, 'Domain'), (760, 200, 'Application'), (1240, 300, 'Infra'), (1560, 520, 'HTTP')]
    for i, (x, y, name) in enumerate(boxes):
        p = prog(t, 0.2 + i * 0.25, 0.8)
        rrect(d, [x, y, x + 240, y + 90], 14, fill=PANEL, outline=CYAN, a=p * 0.5)
        text(d, (x + 120, y + 45), name, font(30, 'medium'), MUTED, p * 0.7, 'mm')
    for i in range(len(boxes) - 1):
        (x0, y0, _), (x1, y1, _) = boxes[i + 1], boxes[i]
        arrow(d, (x0 + 10, y0 + 45), (x1 + 230, y1 + 45), CYAN, 0.35, 3, frac=prog(t, 1.2 + i * 0.3, 0.8))
    p = prog(t, 0.6, 1.0)
    text(d, (W / 2, 560), 'BobsMyUncle', font(150, 'bold'), TEXT, p, 'mm', rise=(1 - p) * 30)
    p2 = prog(t, 1.3, 0.8)
    pill = [W / 2 - 80, 660, W / 2 + 80, 730]
    rrect(d, pill, 35, fill=CYAN, a=p2)
    text(d, (W / 2, 695), 'bmu', font(44, 'monob'), BG0, p2, 'mm')
    text(d, (W / 2, 800), 'Live UML + code-quality feedback for AI coding agents', font(44, 'light'), MUTED, prog(t, 2.0, 0.9), 'mm')


def s_unclebob(d, t, D):
    heading(d, t, 'Who is Uncle Bob?')
    # monogram badge
    p = prog(t, 0.5, 1.0)
    cx, cy, r = 470, 600, 210 * (0.8 + 0.2 * p)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col(PANEL, p), outline=col(CYAN, p), width=6)
    text(d, (cx, cy - 20), 'RCM', font(120, 'black'), CYAN, p, 'mm')
    text(d, (cx, cy + 80), 'Robert C. Martin', font(34, 'medium'), TEXT, p, 'mm')
    items = [
        ('1970', 'A software professional since 1970'),
        ('2001', 'Co-author of the Agile Manifesto'),
        ('SOLID', 'Popularized the SOLID principles of object-oriented design'),
        ('2008', 'Clean Code: A Handbook of Agile Software Craftsmanship'),
        ('2017', 'Clean Architecture'),
    ]
    y = 330
    for i, (k, v) in enumerate(items):
        st = 1.5 + i * 2.2
        pp = prog(t, st, 0.7)
        rrect(d, [800, y, 1000, y + 64], 12, fill=CYAN if k != 'SOLID' else PURPLE, a=pp * 0.9)
        text(d, (900, y + 32), k, font(32, 'bold'), BG0, pp, 'mm')
        lines = wrap(v, font(38, 'light'), 760)
        for j, ln in enumerate(lines):
            text(d, (1030, y + 12 + j * 46), ln, font(38, 'light'), TEXT, pp, rise=(1 - pp) * 16)
        y += 64 + 46 * (len(lines) - 1) + 40


def s_whyclean(d, t, D):
    heading(d, t, 'Why clean code matters')
    q = '“The ratio of time spent reading versus writing is well over 10 to 1.”'
    y = para(d, (160, 300), q, font(56, 'italic'), t, 0.8, 1600, TEXT, 1.3)
    text(d, (164, y + 10), '— Robert C. Martin, Clean Code', font(34, 'light'), MUTED, prog(t, 2.5))
    # reading vs writing bars
    base = 620
    pr = prog(t, 4.0, 1.6)
    text(d, (164, base), 'reading', font(34, 'medium'), CYAN, prog(t, 3.8))
    for i in range(10):
        a = clamp(pr * 10 - i)
        rrect(d, [360 + i * 95, base - 4, 440 + i * 95, base + 44], 8, fill=CYAN, a=a)
    text(d, (164, base + 80), 'writing', font(34, 'medium'), AMBER, prog(t, 5.2))
    rrect(d, [360, base + 76, 440, base + 124], 8, fill=AMBER, a=prog(t, 5.6))
    para(d, (160, 860), 'Messy code makes every later change slower and riskier.', font(42, 'light'), t, 7.5, 1600)
    text(d, (160, 940), '“The only way to go fast is to go well.”', font(46, 'medium'), GREEN, prog(t, 10.5), rise=(1 - prog(t, 10.5)) * 16)


def s_agents(d, t, D):
    heading(d, t, 'Now agents write the code')
    # line counter
    p = prog(t, 0.8, 9)
    n = int(ease_io(clamp((t - 0.8) / 9)) * 2400)
    rrect(d, [1180, 330, 1760, 640], 24, fill=PANEL, outline=AMBER, a=prog(t, 0.6))
    text(d, (1470, 420), f'{n:,}', font(120, 'black'), AMBER, prog(t, 0.8), 'mm')
    text(d, (1470, 530), 'lines changed this session', font(34, 'light'), MUTED, prog(t, 0.9), 'mm')
    bullets(d, t, [
        'AI agents can produce hundreds of lines in minutes.',
        'They can also make a mess — faster than any human.',
        'They need feedback they can act on, right when they make a change.',
    ], 160, 330, 1.2, 3.2, 950)


def s_inspiration(d, t, D):
    heading(d, t, 'The spark: Uncle Bob\u2019s uml-viewer', 'github.com/unclebob/uml-viewer')
    bullets(d, t, [
        'A live UML diagram of a Clojure codebase, coupled to an AI agent.',
        'Boxes colored by CRAP and mutation-testing scores.',
        'Red arrows where dependencies point the wrong way.',
    ], 160, 300, 1.0, 2.4, 1600)
    y = 760
    p = prog(t, 8.5, 0.8)
    text(d, (160, y), 'bmu rebuilds the idea for', font(44, 'light'), TEXT, p)
    chips = [('TypeScript', CYAN), ('Python', AMBER), ('Elixir', PURPLE)]
    x = 160 + font(44, 'light').getlength('bmu rebuilds the idea for') + 30
    for i, (name, c) in enumerate(chips):
        pp = prog(t, 9.0 + i * 0.4, 0.6)
        w = font(40, 'bold').getlength(name) + 48
        rrect(d, [x, y - 6, x + w, y + 56], 30, fill=c, a=pp)
        text(d, (x + w / 2, y + 25), name, font(40, 'bold'), BG0, pp, 'mm')
        x += w + 20
    text(d, (160, y + 100), '…and wires it directly into the agent\u2019s loop.', font(44, 'light'), GREEN, prog(t, 10.5))


def s_metrics_intro(d, t, D):
    p = prog(t, 0.2, 0.9)
    text(d, (W / 2, 480), 'The metrics', font(130, 'bold'), TEXT, p, 'mm', rise=(1 - p) * 30)
    text(d, (W / 2, 600), 'what bmu measures — and why each one matters', font(44, 'light'), MUTED, prog(t, 0.9), 'mm')


CODE = [
    'function applyDiscount(order, code, vip) {',
    '  if (!order) return 0',
    '  if (code === "TEN") return 10',
    '  if (code === "VIP" || vip) return 5',
    '  for (const item of order.items) {',
    '    total += item.price',
    '  }',
    '  return total > 100 ? 2 : 0',
    '}',
]
DECISIONS = [(1, 'if'), (2, 'if'), (3, 'if'), (3, '||'), (4, 'for'), (7, '? :')]


def code_panel(d, t, x, y, lines, hl=None, gutter=None, start=0.5):
    f = font(30, 'mono')
    lh = 46
    rrect(d, [x, y, x + 860, y + 40 + lh * len(lines)], 18, fill=PANEL, outline=(60, 66, 84), a=prog(t, start))
    for i, ln in enumerate(lines):
        p = prog(t, start + 0.15 * i, 0.5)
        if gutter and gutter[i] is not None:
            c = GREEN if gutter[i] else RED
            d.rectangle([x + 10, y + 22 + i * lh, x + 18, y + 22 + i * lh + 36], fill=col(c, gutter_alpha(t)))
        if hl and i in hl:
            rrect(d, [x + 26, y + 20 + i * lh, x + 846, y + 20 + i * lh + 40], 6, fill=hl[i], a=0.18)
        text(d, (x + 36, y + 24 + i * lh), ln, f, TEXT, p)


_gutter_t = [0.0]


def gutter_alpha(t):
    return prog(t, _gutter_t[0], 0.6)


def s_cc(d, t, D):
    heading(d, t, 'Cyclomatic complexity')
    hl = {}
    count = 0
    for k, (line_i, _) in enumerate(DECISIONS):
        if t > 3.0 + k * 0.9:
            hl[line_i] = AMBER
            count += 1
    code_panel(d, t, 120, 300, CODE, hl)
    p = prog(t, 3.0, 0.5)
    text(d, (120, 790), f'cc = 1 + {count} decisions = {1 + count}', font(46, 'monob'), AMBER, p)
    bullets(d, t, [
        'Counts the independent paths through a function: 1 + every if, loop, case, catch, && and ||.',
        'More paths means harder to understand — and more tests needed to cover them.',
        'bmu measures it for every function and method, in all three languages.',
    ], 1060, 300, 1.0, 3.2, 760, f=font(36, 'light'))


def s_coverage(d, t, D):
    heading(d, t, 'Test coverage')
    _gutter_t[0] = 1.6
    gut = [None, True, True, False, True, True, None, False, None]
    code_panel(d, t, 120, 300, CODE, gutter=gut)
    pct = int(ease(clamp((t - 2.0) / 2.0)) * 67)
    text(d, (120, 790), f'coverage {pct}%   uncovered: lines 4, 8', font(42, 'monob'), GREEN if pct > 80 else AMBER, prog(t, 2.0))
    bullets(d, t, [
        'Which lines your tests actually execute.',
        'Uncovered lines are behavior nobody has checked.',
        'bmu tracks coverage per function and notices when a change leaves new lines untested.',
    ], 1060, 300, 1.0, 3.2, 760, f=font(36, 'light'))


def s_crap(d, t, D):
    heading(d, t, 'CRAP: Change Risk Anti-Patterns')
    p = prog(t, 1.0, 0.8)
    text(d, (160, 300), 'CRAP = cc² × (1 − coverage)³ + cc', font(56, 'monob'), AMBER, p, rise=(1 - p) * 16)
    # chart
    x0, y0, cw, ch = 160, 420, 860, 480
    pa = prog(t, 2.5, 0.6)
    d.line([(x0, y0 + ch), (x0 + cw, y0 + ch)], fill=col(MUTED, pa), width=3)
    d.line([(x0, y0), (x0, y0 + ch)], fill=col(MUTED, pa), width=3)
    text(d, (x0 + cw, y0 + ch + 16), 'coverage →  100%', font(28, 'light'), MUTED, pa, 'ra')
    text(d, (x0 - 10, y0 - 40), 'CRAP', font(28, 'light'), MUTED, pa)
    ymax = 140

    def Y(v):
        return y0 + ch - min(v, ymax) / ymax * ch

    # threshold
    ty = Y(30)
    pt = prog(t, 3.0, 0.6)
    for xx in range(x0, x0 + cw, 24):
        d.line([(xx, ty), (xx + 12, ty)], fill=col(RED, pt), width=3)
    text(d, (x0 + cw + 12, ty - 16), 'threshold 30', font(28, 'medium'), RED, pt)
    for k, (cc, c) in enumerate([(5, GREEN), (10, AMBER), (20, RED)]):
        fr = clamp((t - 3.5 - k * 1.2) / 1.5)
        if fr <= 0:
            continue
        pts = []
        steps = 60
        for i in range(int(steps * fr) + 1):
            cov = i / steps
            pts.append((x0 + cov * cw, Y(cc * cc * (1 - cov) ** 3 + cc)))
        if len(pts) > 1:
            d.line(pts, fill=col(c, 1), width=5)
        text(d, (pts[0][0] + 14, max(pts[0][1], y0) + 6), f'cc {cc}', font(28, 'bold'), c, fr)
    bullets(d, t, [
        'Complex code without tests is risky to change.',
        'Tests pull the score back down to the complexity itself.',
        'cc 10 at 0% coverage → CRAP 110.  cc 10 at 100% → CRAP 10.',
    ], 1160, 420, 7.5, 3.4, 640, f=font(36, 'light'))


def s_mutation(d, t, D):
    heading(d, t, 'Mutation testing')
    f = font(40, 'mono')
    p = prog(t, 1.0)
    rrect(d, [160, 320, 980, 560], 18, fill=PANEL, outline=(60, 66, 84), a=p)
    text(d, (200, 360), 'if (total > 100)', f, TEXT, p)
    pm = prog(t, 2.5)
    text(d, (200, 440), 'if (total >= 100)', f, AMBER, pm)
    text(d, (620, 450), '← mutant', font(32, 'light'), MUTED, pm)
    ps = prog(t, 4.0)
    rrect(d, [160, 600, 980, 690], 18, fill=RED, a=ps * 0.18)
    text(d, (200, 625), 'tests still pass → mutant survived', font(38, 'medium'), RED, ps)
    bullets(d, t, [
        'Coverage says the code ran. Mutation testing asks: would a test notice if it were wrong?',
        'Surviving mutants point at missing assertions.',
        'bmu reads Stryker reports and flags survivors in the code you changed.',
    ], 1060, 320, 5.5, 3.4, 760, f=font(36, 'light'))


def s_deprule(d, t, D):
    heading(d, t, 'The Dependency Rule', 'from Clean Architecture')
    cx, cy = 560, 640
    rings = [(330, 'Frameworks & drivers', (60, 70, 96)), (250, 'Interface adapters', (52, 90, 120)), (170, 'Use cases', (60, 120, 150)), (90, 'Entities', (80, 150, 120))]
    for i, (r, name, c) in enumerate(rings):
        p = prog(t, 0.6 + i * 0.4, 0.8)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col(c, p * 0.85), outline=col(BG0, p), width=4)
        if i < 3:
            text(d, (cx, cy - r + 36), name, font(26, 'medium'), TEXT, p, 'mm')
        else:
            text(d, (cx, cy), name, font(28, 'bold'), TEXT, p, 'mm')
    for k, ang in enumerate([-2.4, -0.7, 0.9, 2.6]):
        fr = clamp((t - 3.0 - k * 0.25) / 0.8)
        arrow(d, (cx + 320 * math.cos(ang), cy + 320 * math.sin(ang)), (cx + 110 * math.cos(ang), cy + 110 * math.sin(ang)), GREEN, 1, 6, 22, fr)
    fr = clamp((t - 6.5) / 0.9)
    arrow(d, (cx + 60, cy - 60), (cx + 280, cy - 240), RED, 1, 7, 26, fr)
    if fr >= 1:
        text(d, (cx + 200, cy - 345), '✗ violation', font(36, 'bold'), RED, prog(t, 7.3))
    bullets(d, t, [
        'Source-code dependencies must point inward, toward the stable core.',
        'Inner layers must never import outer ones.',
        'bmu infers your layers (domain → application → infra → http) and flags any arrow that points outward.',
    ], 1040, 330, 2.0, 3.6, 780, f=font(36, 'light'))


def s_cycles(d, t, D):
    heading(d, t, 'Import cycles')
    cx, cy, R = 500, 620, 200
    names = ['orders.ts', 'pricing.ts', 'cart.ts']
    pos = [(cx + R * math.cos(-math.pi / 2 + i * 2 * math.pi / 3), cy + R * math.sin(-math.pi / 2 + i * 2 * math.pi / 3)) for i in range(3)]
    hot = int((t * 1.2) % 3) if t > 3 else -1
    for i in range(3):
        a, b = pos[i], pos[(i + 1) % 3]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        ux, uy = dx / L, dy / L
        arrow(d, (a[0] + ux * 110, a[1] + uy * 110), (b[0] - ux * 110, b[1] - uy * 110), RED if i == hot else MUTED, 1, 5, 20, clamp((t - 1.0 - i * 0.4) / 0.7))
    for i, (x, y) in enumerate(pos):
        p = prog(t, 0.5 + i * 0.2)
        rrect(d, [x - 110, y - 40, x + 110, y + 40], 14, fill=PANEL, outline=RED if t > 3 else CYAN, a=p)
        text(d, (x, y), names[i], font(30, 'mono'), TEXT, p, 'mm')
    bullets(d, t, [
        'Modules that depend on each other can\u2019t be changed, tested or reused alone.',
        'bmu finds cycles with Tarjan\u2019s algorithm and tracks them as they grow or shrink.',
    ], 1000, 380, 2.0, 3.6, 800, f=font(38, 'light'))


def s_martin(d, t, D):
    heading(d, t, 'Package metrics', 'Robert C. Martin\u2019s stability and abstractness')
    x0, y0, s = 180, 330, 560
    pa = prog(t, 0.8)
    rrect(d, [x0, y0, x0 + s, y0 + s], 6, outline=MUTED, a=pa, width=3)
    # zones
    d.polygon([(x0, y0 + s), (x0 + 200, y0 + s), (x0, y0 + s - 200)], fill=col(RED, pa * 0.25))
    d.polygon([(x0 + s, y0), (x0 + s - 200, y0), (x0 + s, y0 + 200)], fill=col(AMBER, pa * 0.25))
    fr = clamp((t - 1.5) / 1.0)
    d.line([(x0, y0), (x0 + s * fr, y0 + s * fr)], fill=col(GREEN, 1), width=4)
    text(d, (x0, y0 + s + 18), 'zone of pain ↑', font(26, 'medium'), RED, pa)
    text(d, (x0 + s - 20, y0 + 30), 'zone of uselessness', font(26, 'medium'), AMBER, pa, 'ra')
    text(d, (x0 + s / 2 + 40, y0 + s / 2 - 50), 'main sequence', font(26, 'medium'), GREEN, prog(t, 2.4))
    text(d, (x0 + s, y0 + s + 18), 'Instability I →', font(28, 'light'), MUTED, pa, 'ra')
    text(d, (x0 - 20, y0 + s / 2), 'A', font(30, 'bold'), MUTED, pa, 'rm')
    for k, (ix, ia) in enumerate([(0.15, 0.85), (0.8, 0.2), (0.5, 0.45), (0.1, 0.1), (0.9, 0.85)]):
        p = prog(t, 3.0 + k * 0.3)
        x, y = x0 + ix * s, y0 + (1 - ia) * s
        c = GREEN if abs(ia + ix - 1) < 0.3 else RED
        d.ellipse([x - 12, y - 12, x + 12, y + 12], fill=col(c, p))
    lines = [
        ('Instability', 'I = Ce / (Ca + Ce)', 'outgoing ÷ all dependencies'),
        ('Abstractness', 'A = abstract / all types', 'interfaces, behaviours, protocols'),
        ('Distance', 'D = |A + I − 1|', 'far from the main sequence = trouble'),
    ]
    y = 340
    for i, (name, formula, note) in enumerate(lines):
        st = 3.5 + i * 3.0
        text(d, (900, y), name, font(36, 'bold'), CYAN, prog(t, st))
        text(d, (900, y + 50), formula, font(40, 'monob'), TEXT, prog(t, st + 0.3))
        text(d, (900, y + 104), note, font(32, 'light'), MUTED, prog(t, st + 0.6))
        y += 190


def s_pipeline(d, t, D):
    heading(d, t, 'How bmu works')
    steps = [
        ('Your repo', 'TS · Python · Elixir', MUTED),
        ('Parse', 'tree-sitter, incremental', CYAN),
        ('UML model', 'classes, components, edges', CYAN),
        ('Metrics', 'cc · coverage · CRAP · mutants · cycles · layers', AMBER),
        ('Baseline', 'existing debt is set aside', PURPLE),
        ('Agent note', 'only what got worse', GREEN),
    ]
    bw, gap, y = 250, 50, 330
    x = 110
    for i, (title, sub, c) in enumerate(steps):
        st = 0.8 + i * 1.0
        p = prog(t, st, 0.6)
        rrect(d, [x, y, x + bw, y + 230], 18, fill=PANEL, outline=c, a=p, width=3)
        text(d, (x + bw / 2, y + 60), title, font(36, 'bold'), c, p, 'mm')
        for j, ln in enumerate(wrap(sub, font(26, 'light'), bw - 30)):
            text(d, (x + bw / 2, y + 120 + j * 34), ln, font(26, 'light'), TEXT, p, 'mm')
        if i < len(steps) - 1:
            arrow(d, (x + bw + 4, y + 115), (x + bw + gap - 4, y + 115), MUTED, 1, 4, 14, clamp((t - st - 0.4) / 0.4))
        x += bw + gap
    bullets(d, t, [
        'Incremental: only changed files are re-parsed — about 0.2 to 0.7 seconds per edit, even on a 7,000-file repo.',
        'Every finding has a stable id, so it\u2019s reported once, again only if it gets worse, and once more when it\u2019s fixed.',
    ], 160, 660, 7.5, 4.0, 1600, f=font(38, 'light'))


TERM = [
    (1.0, '$ agent ▸ edit src/core/domains/users/user.entity.ts', MUTED, 'type'),
    (3.5, '+ import { routes } from "@http/orders.controller"', GREEN, 'type'),
    (6.5, 'bmu: 1 code-quality regression from your recent changes', AMBER, 'line'),
    (7.0, '     (report only, not blocking):', AMBER, 'line'),
    (8.0, '  bmu-8681e [new] dependency-rule violation:', RED, 'line'),
    (8.6, '  user.entity.ts:3 → http/orders.controller.ts', RED, 'line'),
    (9.2, '  (src/core/domains (inner) must not depend on src/http (outer))', RED, 'line'),
    (13.0, '$ agent ▸ move the lookup behind a domain interface…', MUTED, 'type'),
    (17.0, 'bmu: fixed since your last edit: bmu-8681e [resolved]', GREEN, 'line'),
]


def s_loop(d, t, D):
    heading(d, t, 'Inside the agent\u2019s loop')
    x0, y0 = 120, 280
    rrect(d, [x0, y0, x0 + 1240, y0 + 640], 20, fill=(14, 16, 22), outline=(60, 66, 84), a=prog(t, 0.4))
    for i, c in enumerate([RED, AMBER, GREEN]):
        d.ellipse([x0 + 26 + i * 34, y0 + 22, x0 + 46 + i * 34, y0 + 42], fill=col(c, prog(t, 0.4)))
    f = font(28, 'mono')
    y = y0 + 80
    for st, s, c, mode in TERM:
        if t < st:
            break
        if mode == 'type':
            n = int((t - st) * 34)
            shown = s[:n]
            text(d, (x0 + 36, y), shown, f, c)
            if n < len(s) and int(t * 3) % 2 == 0:
                cw = f.getlength(shown)
                d.rectangle([x0 + 36 + cw + 2, y + 2, x0 + 36 + cw + 18, y + 34], fill=col(TEXT, 0.8))
        else:
            text(d, (x0 + 36, y), s, f, c, prog(t, st, 0.4))
        y += 52 if not s.startswith('  ') and not s.startswith('     ') else 46
        if st in (3.5, 9.2):
            y += 24
    # side captions
    caps = [(7.0, 'Delivered with the', 'tool result, same step.'), (11.0, 'Report only.', 'Never blocks the agent.'), (17.5, 'Fixed? bmu says so', '— exactly once.')]
    cy = 330
    for st, a, b in caps:
        p = prog(t, st)
        text(d, (1410, cy), a, font(34, 'medium'), TEXT, p, rise=(1 - p) * 14)
        text(d, (1410, cy + 44), b, font(34, 'light'), MUTED, p, rise=(1 - p) * 14)
        cy += 170


def s_harness(d, t, D):
    heading(d, t, 'Built for OpenCode and Grok Build')
    cards = [
        ('OpenCode V2 plugin', CYAN, ['Note appended to the edit\u2019s tool result', 'Live status in every model call', 'Native bmu tools: prime, findings, explain, diagram, diff']),
        ('Grok Build hooks', PURPLE, ['PostToolUse hook adds context after each edit', 'MCP server: bmu_prime, bmu_findings, …', 'Status line + live monitor stream']),
    ]
    for i, (title, c, items) in enumerate(cards):
        x = 140 + i * 840
        st = 0.8 + i * 4.5
        p = prog(t, st)
        rrect(d, [x, 300, x + 780, 800], 24, fill=PANEL, outline=c, a=p, width=3)
        text(d, (x + 40, 340), title, font(46, 'bold'), c, p)
        y = 430
        for j, s in enumerate(items):
            pp = prog(t, st + 0.8 + j * 1.0)
            d.ellipse([x + 44, y + 16, x + 56, y + 28], fill=col(c, pp))
            for k, ln in enumerate(wrap(s, font(36, 'light'), 660)):
                text(d, (x + 76, y + k * 46), ln, font(36, 'light'), TEXT, pp)
            y += 46 * len(wrap(s, font(36, 'light'), 660)) + 34
    p = prog(t, 11.5)
    text(d, (W / 2, 880), 'bmu install opencode   ·   bmu install grok', font(42, 'monob'), GREEN, p, 'mm')
    text(d, (W / 2, 950), 'local by default — nothing committed, nothing pushed', font(34, 'light'), MUTED, prog(t, 12.2), 'mm')


def s_commands(d, t, D):
    heading(d, t, 'For humans, too')
    cmds = [
        ('bmu prime', 'architecture brief + findings'),
        ('bmu findings --new', 'regressions since the baseline'),
        ('bmu explain bmu-8681e', 'what, where, and how to fix'),
        ('bmu diagram src/core', 'Mermaid UML slice'),
        ('bmu diff main', 'structural changes vs a branch'),
        ('bmu serve', 'live drill-down viewer'),
    ]
    y = 320
    for i, (c, note) in enumerate(cmds):
        st = 0.8 + i * 1.4
        text(d, (160, y), c, font(38, 'monob'), CYAN, prog(t, st))
        text(d, (160, y + 48), note, font(30, 'light'), MUTED, prog(t, st + 0.3))
        y += 110
    # mini component diagram
    nodes = {'domains': (1300, 360), 'application': (1580, 520), 'infra': (1300, 700), 'http': (1600, 820)}
    pd = prog(t, 2.0)
    edges = [('application', 'domains', GREEN), ('infra', 'domains', GREEN), ('http', 'application', GREEN), ('domains', 'http', RED)]
    for k, (a, b, c) in enumerate(edges):
        (x0, y0), (x1, y1) = nodes[a], nodes[b]
        st = 3.0 + k * 0.8 + (3 if c == RED else 0)
        arrow(d, (x0, y0), (x1 - (x1 - x0) * 0.25, y1 - (y1 - y0) * 0.25), c, 1, 5 if c == RED else 4, 18, clamp((t - st) / 0.7))
    for name, (x, y) in nodes.items():
        rrect(d, [x - 120, y - 42, x + 120, y + 42], 14, fill=(232, 246, 232), outline=GREEN, a=pd)
        text(d, (x, y), name + '/', font(30, 'medium'), BG0, pd, 'mm')


def s_outro(d, t, D):
    p = prog(t, 0.3, 1.0)
    text(d, (W / 2, 430), 'Clean code, at agent speed.', font(110, 'bold'), TEXT, p, 'mm', rise=(1 - p) * 30)
    p2 = prog(t, 1.5)
    rrect(d, [W / 2 - 80, 540, W / 2 + 80, 610], 35, fill=CYAN, a=p2)
    text(d, (W / 2, 575), 'bmu', font(44, 'monob'), BG0, p2, 'mm')
    text(d, (W / 2, 690), 'github.com/johnkabler/BobsMyUncle', font(46, 'medium'), CYAN, prog(t, 2.2), 'mm')
    text(d, (W / 2, 770), 'Inspired by Robert C. Martin\u2019s uml-viewer and Clean Architecture', font(36, 'light'), MUTED, prog(t, 3.0), 'mm')


SCENES = [
    (7.5, s_title),
    (17.5, s_unclebob),
    (17.5, s_whyclean),
    (15.0, s_agents),
    (15.0, s_inspiration),
    (5.0, s_metrics_intro),
    (17.5, s_cc),
    (15.0, s_coverage),
    (20.0, s_crap),
    (20.0, s_mutation),
    (17.5, s_deprule),
    (12.5, s_cycles),
    (17.5, s_martin),
    (20.0, s_pipeline),
    (22.5, s_loop),
    (17.5, s_harness),
    (15.0, s_commands),
    (12.5, s_outro),
]


def total():
    return sum(dur for dur, _ in SCENES)


def render_frame(bg, si, t, T):
    global GA
    dur, fn = SCENES[si]
    frame = bg.copy()
    d = ImageDraw.Draw(frame, 'RGBA')
    GA = 1.0
    draw_bg(d, T)
    fade_in = clamp(t / 0.5)
    fade_out = clamp((dur - t) / 0.6) if si < len(SCENES) - 1 else clamp((dur - t) / 2.5)
    GA = min(fade_in, fade_out)
    fn(d, t, dur)
    # progress bar
    GA = 1.0
    d.rectangle([0, H - 6, W * (T / total()), H], fill=(110, 168, 254, 160))
    return frame


def main():
    args = sys.argv[1:]
    bg = make_bg()
    if args and args[0] == '--still':
        si, sec = int(args[1]), float(args[2])
        T = sum(d for d, _ in SCENES[:si]) + sec
        render_frame(bg, si, sec, T).convert('RGB').save(args[3] if len(args) > 3 else f'/tmp/still_{si}.png')
        return
    out = args[0] if args else os.path.join(HERE, 'bmu-explainer-silent.mp4')
    only = int(args[2]) if len(args) > 2 and args[1] == '--preview' else None
    ff = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                           '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', out], stdin=subprocess.PIPE)
    T0 = 0.0
    for si, (dur, _) in enumerate(SCENES):
        if only is not None and si != only:
            T0 += dur
            continue
        n = int(round(dur * FPS))
        for k in range(n):
            t = k / FPS
            ff.stdin.write(render_frame(bg, si, t, T0 + t).convert('RGB').tobytes())
        T0 += dur
        print(f'scene {si + 1}/{len(SCENES)} done', flush=True)
    ff.stdin.close()
    ff.wait()
    print('wrote', out, f'({total():.1f}s)')


if __name__ == '__main__':
    main()
