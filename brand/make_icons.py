"""Делает из маленького значка (71x71) все нужные размеры: Android, Windows (.ico), сайт.

Пример для админ-панели (из корня репозитория):
  python3 brand/make_icons.py brand/panel-app.png --browser brand/panel-browser.png \\
      --web public --desktop desktop --android android/app/src/main/res
Нужен Python 3 с Pillow (pip install pillow).
"""
import sys, os
from PIL import Image, ImageDraw, ImageFilter

def load(path):
    return Image.open(path).convert('RGB')

def up(img, size):
    """Увеличение с лёгкой резкостью (исходник маленький)."""
    big = img.resize((size, size), Image.LANCZOS)
    return big.filter(ImageFilter.UnsharpMask(radius=max(1, size / 160), percent=140, threshold=2))

def rounded(img, radius_frac=0.22):
    s = img.size[0]
    m = Image.new('L', (s * 4, s * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, s * 4 - 1, s * 4 - 1), radius=int(s * 4 * radius_frac), fill=255)
    m = m.resize((s, s), Image.LANCZOS)
    out = img.convert('RGBA')
    out.putalpha(m)
    return out

def circle(img):
    s = img.size[0]
    m = Image.new('L', (s * 4, s * 4), 0)
    ImageDraw.Draw(m).ellipse((0, 0, s * 4 - 1, s * 4 - 1), fill=255)
    m = m.resize((s, s), Image.LANCZOS)
    out = img.convert('RGBA')
    out.putalpha(m)
    return out

def flat_color(src):
    """Основной цвет фона значка (по верхним строкам)."""
    w, h = src.size
    px = [src.getpixel((x, y)) for y in range(2, 8) for x in range(2, 10)]
    return tuple(sorted(c[i] for c in px)[len(px) // 2] for i in range(3)) if False else tuple(
        sorted(p[i] for p in px)[len(px) // 2] for i in range(3))

def adaptive_foreground(src, size):
    """Слой переднего плана: весь значок в центральных 72 из 108 (безопасная зона)."""
    inner = round(size * 72 / 108)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(up(src, inner).convert('RGBA'), ((size - inner) // 2, (size - inner) // 2))
    return out

def adaptive_mono(src, size):
    """Одноцветный слой для «тематических значков» Android 13+: тёмные части картинки = форма."""
    inner = round(size * 72 / 108)
    big = up(src, inner).convert('L')
    w = inner
    # только внутри круга значка, чтобы тёмная полоса по краю не попала в форму
    ring_r = w * 0.50
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    mask = Image.new('L', (inner, inner), 0)
    pm = mask.load(); pb = big.load()
    cx = cy = (inner - 1) / 2
    for y in range(inner):
        for x in range(inner):
            if (x - cx) ** 2 + (y - cy) ** 2 <= ring_r ** 2:
                l = pb[x, y]
                a = max(0, min(255, int((70 - l) * 255 / 45)))
                pm[x, y] = a
    black = Image.new('RGBA', (inner, inner), (0, 0, 0, 255))
    black.putalpha(mask)
    out.paste(black, ((size - inner) // 2, (size - inner) // 2))
    return out

DENS = {'mdpi': (48, 108), 'hdpi': (72, 162), 'xhdpi': (96, 216), 'xxhdpi': (144, 324), 'xxxhdpi': (192, 432)}

def make_android(src, res_dir, with_bg_png=False, with_mono=True):
    col = flat_color(src)
    for d, (legacy, adaptive) in DENS.items():
        base = os.path.join(res_dir, 'mipmap-' + d)
        os.makedirs(base, exist_ok=True)
        full = up(src, legacy)
        rounded(full).save(os.path.join(base, 'ic_launcher.png'))
        circle(full).save(os.path.join(base, 'ic_launcher_round.png'))
        adaptive_foreground(src, adaptive).save(os.path.join(base, 'ic_launcher_foreground.png'))
        if with_mono:
            adaptive_mono(src, adaptive).save(os.path.join(base, 'ic_launcher_monochrome.png'))
        if with_bg_png:
            Image.new('RGB', (adaptive, adaptive), col).save(os.path.join(base, 'ic_launcher_background.png'))
    return '#%02X%02X%02X' % col

def make_desktop(src, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    big = rounded(up(src, 512))
    big.save(os.path.join(out_dir, 'icon.png'))
    big.save(os.path.join(out_dir, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

def make_web(src, out_dir, name):
    os.makedirs(out_dir, exist_ok=True)
    up(src, 192).save(os.path.join(out_dir, name))

def main():
    import argparse
    ap = argparse.ArgumentParser(description='Делает рабочие значки проекта из файлов brand/<проект>-app.png и -browser.png')
    ap.add_argument('app', help='значок приложения, например brand/panel-app.png')
    ap.add_argument('--browser', help='значок для браузера (с глобусом), например brand/panel-browser.png')
    ap.add_argument('--web', help='папка для logo.png и logo-browser.png (192 px)')
    ap.add_argument('--desktop', help='папка desktop/ (icon.png 512 и icon.ico)')
    ap.add_argument('--android', help='папка app/src/main/res Android-приложения')
    ap.add_argument('--bg-png', action='store_true', help='Android: фон адаптивного значка файлами ic_launcher_background.png (как в игре)')
    a = ap.parse_args()
    src = load(a.app)
    if a.web:
        make_web(src, a.web, 'logo.png')
        if a.browser:
            make_web(load(a.browser), a.web, 'logo-browser.png')
    if a.desktop:
        make_desktop(src, a.desktop)
    if a.android:
        col = make_android(src, a.android, with_bg_png=a.bg_png)
        print('Цвет фона адаптивного значка (values/ic_launcher_background.xml):', col)


if __name__ == '__main__':
    main()
