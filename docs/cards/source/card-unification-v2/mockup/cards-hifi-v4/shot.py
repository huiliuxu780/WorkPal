from pathlib import Path
import os
import shutil
import sys
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
PAGES = ['cards', 'a-detail', 'b-alerts', 'c-states', 'index']
VIEWPORT = {'width': 1452, 'height': 900}


def chrome_executable():
    configured = os.environ.get('CHROME_BIN')
    if configured:
        return configured
    for name in ('google-chrome', 'chromium', 'chromium-browser', 'chrome'):
        found = shutil.which(name)
        if found:
            return found
    mac = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    return str(mac) if mac.exists() else None


def capture():
    requested = sys.argv[1:]
    pages = requested or PAGES
    with sync_playwright() as p:
        kwargs = {'headless': True}
        executable = chrome_executable()
        if executable:
            kwargs['executable_path'] = executable
        browser = p.chromium.launch(**kwargs)
        print(f'Browser: Chromium {browser.version}; viewport: {VIEWPORT["width"]}x{VIEWPORT["height"]}; DPR 1')
        for name in pages:
            file = ROOT / f'{name}.html'
            if not file.exists():
                continue
            page = browser.new_page(viewport=VIEWPORT, device_scale_factor=1)
            page.emulate_media(reduced_motion='reduce')
            page.goto(file.as_uri(), wait_until='load')
            page.evaluate('document.fonts.ready')
            if name == 'a-detail':
                page.locator('[data-panel-open="report-panel"]').click()
            page.screenshot(path=ROOT / f'shot-{name}.png', full_page=True, animations='disabled', caret='hide')
            print(name, page.evaluate('document.documentElement.scrollWidth + "x" + document.documentElement.scrollHeight'))
            page.close()
        for width in (390, 375):
            page = browser.new_page(viewport={'width': width, 'height': 844}, device_scale_factor=1)
            page.emulate_media(reduced_motion='reduce')
            page.goto((ROOT / 'cards.html').as_uri(), wait_until='load')
            page.evaluate('document.fonts.ready')
            page.locator('section.col:has(#a7-mcp-assignment)').screenshot(path=ROOT / f'shot-a7-{width}.png', animations='disabled', caret='hide')
            page.locator('section.col:has(#a13-plan-review)').screenshot(path=ROOT / f'shot-a13-{width}.png', animations='disabled', caret='hide')
            print(f'a7-{width}/a13-{width}', page.evaluate('document.documentElement.scrollWidth + "x" + document.documentElement.scrollHeight'))
            page.close()
        architecture = ROOT.parents[1] / 'card-unification.html'
        if not requested and architecture.exists():
            page = browser.new_page(viewport=VIEWPORT, device_scale_factor=1)
            page.goto(architecture.as_uri(), wait_until='load')
            page.screenshot(path=ROOT.parents[1] / 'card-unification.png', full_page=True, animations='disabled', caret='hide')
            print('card-unification', page.evaluate('document.documentElement.scrollWidth + "x" + document.documentElement.scrollHeight'))
            page.close()
        browser.close()


def comparisons():
    for name in ('cards', 'a-detail', 'b-alerts', 'c-states'):
        old_path = ROOT / 'old' / f'shot-{name}.png'
        new_path = ROOT / f'shot-{name}.png'
        if not old_path.exists() or not new_path.exists():
            continue
        old = Image.open(old_path).convert('RGB')
        new = Image.open(new_path).convert('RGB')
        if old.width != new.width:
            raise ValueError(f'Viewport mismatch for {name}: {old.width} vs {new.width}')
        header = 44
        height = max(old.height, new.height) + header
        canvas = Image.new('RGB', (old.width + new.width, height), 'white')
        canvas.paste(old, (0, header))
        canvas.paste(new, (old.width, header))
        draw = ImageDraw.Draw(canvas)
        draw.text((16, 14), 'OLD / baseline v4', fill='#1c1c1c')
        draw.text((old.width + 16, 14), 'NEW / CARD-01 aligned', fill='#1c1c1c')
        canvas.save(ROOT / f'compare-{name}.png')
        print(f'compare-{name}: same viewport {old.width}px; old {old.height}px, new {new.height}px')


def overview():
    paths = [ROOT / f'shot-{n}.png' for n in ('cards', 'a-detail', 'b-alerts', 'c-states')]
    if not all(p.exists() for p in paths):
        return
    thumb_w, thumb_h = 600, 900
    canvas = Image.new('RGB', (thumb_w * 2 + 36, thumb_h * 2 + 72), '#f0f0ed')
    for i, path in enumerate(paths):
        im = Image.open(path).convert('RGB')
        ratio = thumb_w / im.width
        im = im.resize((thumb_w, min(thumb_h, int(im.height * ratio))))
        x = 12 + (i % 2) * (thumb_w + 12)
        y = 12 + (i // 2) * (thumb_h + 24)
        canvas.paste(im, (x, y))
    canvas.save(ROOT / 'overview.png')


if __name__ == '__main__':
    capture()
    if not sys.argv[1:]:
        comparisons()
        overview()
