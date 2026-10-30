"""Build production steekem brand SVGs from Inter ExtraBold.

Converts text to SVG paths so the assets have no font dependency.
Outputs to assets/brand/:
  - wordmark-dark.svg (cream + orange ee, transparent bg)
  - wordmark-light.svg (near-black + orange ee, transparent bg)
  - favicon-dark.svg (orange ee on dark rounded square)
  - favicon-light.svg (orange ee on cream rounded square)
"""
import urllib.request
import re
import os
from io import BytesIO
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen


# Brand colors
PRIMARY_DARK = "#F5F1E8"   # cream — text on dark bg
PRIMARY_LIGHT = "#0E0E10"  # near-black — text on light bg
ACCENT = "#E8923C"         # orange — the doubled ee, same in both modes
BG_DARK = "#0E0E10"        # dark bg for favicon
BG_LIGHT = "#F5F1E8"       # cream bg for favicon
BORDER_DARK = "#2A2A2D"
BORDER_LIGHT = "#D8D2C5"


def fetch_inter_extra_bold():
    css_url = 'https://fonts.googleapis.com/css2?family=Inter:wght@800&display=swap'
    req = urllib.request.Request(css_url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                      'AppleWebKit/537.36 (KHTML, like Gecko) '
                      'Chrome/120.0.0.0 Safari/537.36',
    })
    with urllib.request.urlopen(req) as resp:
        css = resp.read().decode('utf-8')

    print(f"CSS preview: {css[:300]}...")

    blocks = re.findall(
        r'/\*\s*([^*]+?)\s*\*/\s*@font-face\s*\{[^}]*src:\s*url\((https?://[^)]+)\)',
        css, re.DOTALL,
    )
    print(f"Found {len(blocks)} blocks: {[name for name, _ in blocks]}")

    for name, url in blocks:
        if name.strip() == 'latin':
            with urllib.request.urlopen(url) as r:
                return r.read()
    raise RuntimeError("No latin subset found")


def extract_letter_paths(font, letters):
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    hmtx = font['hmtx']

    result = []
    for letter in letters:
        glyph_name = cmap[ord(letter)]
        pen = SVGPathPen(glyph_set)
        glyph_set[glyph_name].draw(pen)
        path = pen.getCommands()
        advance = hmtx[glyph_name][0]
        result.append({
            'letter': letter,
            'path': path,
            'advance': advance,
        })
    return result


def build_wordmark(letters_data, accent_indices, primary_color, accent_color,
                   output_path, upem, ascent, descent, letter_spacing_em=-0.04):
    letter_spacing = int(upem * letter_spacing_em)

    # Compute x positions
    x = 0
    positions = []
    for letter in letters_data:
        positions.append(x)
        x += letter['advance'] + letter_spacing
    total_width = x - letter_spacing  # remove trailing spacing

    pad = 60
    view_min_y = -ascent
    view_height = ascent - descent
    view_width = total_width + pad * 2

    paths_svg = []
    for i, letter in enumerate(letters_data):
        color = accent_color if i in accent_indices else primary_color
        x_pos = positions[i]
        paths_svg.append(
            f'    <g transform="translate({x_pos}, 0)" fill="{color}">'
            f'<path d="{letter["path"]}"/></g>'
        )

    svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="-{pad} {view_min_y} {view_width} {view_height}"
     role="img" aria-label="steekem">
  <g transform="scale(1, -1)">
{chr(10).join(paths_svg)}
  </g>
</svg>
'''
    with open(output_path, 'w') as fp:
        fp.write(svg)
    print(f"Wrote {output_path} (viewBox: -{pad} {view_min_y} {view_width} {view_height})")


def build_favicon(letters_data, primary_color, bg_color, border_color,
                  output_path, upem, ascent, descent, x_height,
                  letter_spacing_em=-0.05, padding_ratio=0.10):
    """Build favicon SVG: rounded square with 'ee' centered, in accent color.

    box_size is computed FROM the letter pair size so the letters always fit.
    padding_ratio = fraction of box on each side that's empty (e.g. 0.22 = 22%).
    """
    letter_spacing = int(upem * letter_spacing_em)

    # Compute the visible bounds of the 'ee' pair (in font units)
    advance = letters_data[0]['advance']
    pair_width = advance * 2 + letter_spacing

    # Box must be large enough that pair occupies (1 - 2*padding) fraction of width
    box_size = int(pair_width / (1 - 2 * padding_ratio))

    bg_radius = int(box_size * 0.22)   # 22% rounded corners — modern app-icon style
    border_width = int(box_size * 0.012)

    # Horizontal centering — pair width is now smaller than box_size, so x_offset is positive
    x_offset = (box_size - pair_width) / 2

    # Vertical centering: x-height letter visual center is at y = x_height/2 above baseline.
    # After scale(1,-1), this becomes y = -x_height/2.
    # We want this point at box_size/2 (vertical center of the box).
    # So y_translate = box_size/2 + x_height/2
    y_translate = (box_size + x_height) / 2

    paths_svg = []
    x = x_offset
    for letter in letters_data:
        paths_svg.append(
            f'    <g transform="translate({x:.0f}, 0)" fill="{primary_color}">'
            f'<path d="{letter["path"]}"/></g>'
        )
        x += advance + letter_spacing

    svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 {box_size} {box_size}"
     role="img" aria-label="steekem favicon">
  <rect x="0" y="0" width="{box_size}" height="{box_size}"
        rx="{bg_radius}" fill="{bg_color}"
        stroke="{border_color}" stroke-width="{border_width}"/>
  <g transform="translate(0, {y_translate:.0f}) scale(1, -1)">
{chr(10).join(paths_svg)}
  </g>
</svg>
'''
    with open(output_path, 'w') as fp:
        fp.write(svg)
    print(f"Wrote {output_path} (box_size={box_size}, pair_width={pair_width}, x_height={x_height})")


def main():
    out_dir = 'assets/brand'
    os.makedirs(out_dir, exist_ok=True)

    print("Fetching Inter ExtraBold from Google Fonts...")
    font_data = fetch_inter_extra_bold()
    print(f"Font: {len(font_data)} bytes")

    font = TTFont(BytesIO(font_data))
    upem = font['head'].unitsPerEm
    ascent = font['hhea'].ascent
    descent = font['hhea'].descent
    # x-height comes from OS/2 table — actual x-height of lowercase letters
    x_height = font['OS/2'].sxHeight
    print(f"upem={upem} ascent={ascent} descent={descent} x_height={x_height}")

    letters_steekem = extract_letter_paths(font, "steekem")
    letters_ee = extract_letter_paths(font, "ee")

    # Wordmarks (transparent bg, mode-specific text color)
    build_wordmark(
        letters_steekem, accent_indices=[2, 3],
        primary_color=PRIMARY_DARK, accent_color=ACCENT,
        output_path=f'{out_dir}/wordmark-dark.svg',
        upem=upem, ascent=ascent, descent=descent,
    )
    build_wordmark(
        letters_steekem, accent_indices=[2, 3],
        primary_color=PRIMARY_LIGHT, accent_color=ACCENT,
        output_path=f'{out_dir}/wordmark-light.svg',
        upem=upem, ascent=ascent, descent=descent,
    )

    # Favicons (rounded square with bg + orange ee)
    build_favicon(
        letters_ee, primary_color=ACCENT,
        bg_color=BG_DARK, border_color=BORDER_DARK,
        output_path=f'{out_dir}/favicon-dark.svg',
        upem=upem, ascent=ascent, descent=descent, x_height=x_height,
    )
    build_favicon(
        letters_ee, primary_color=ACCENT,
        bg_color=BG_LIGHT, border_color=BORDER_LIGHT,
        output_path=f'{out_dir}/favicon-light.svg',
        upem=upem, ascent=ascent, descent=descent, x_height=x_height,
    )

    print(f"\n✓ All brand SVGs written to {out_dir}/")


if __name__ == '__main__':
    main()
