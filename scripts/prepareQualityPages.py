"""Render whole source pages; optional explicit rotations, never crop.

STATEMENT_PDF_RENDERER=pdfium supports hosts whose Poppler installation lacks
the CJK language mappings needed by some unembedded Chinese fonts.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
from pypdf import PdfReader
from PIL import Image


def prepare(pdf, output, dpi=250, rotations=None, pages=None):
    renderer = os.environ.get('STATEMENT_PDF_RENDERER', 'poppler')
    if renderer not in ('poppler', 'pdfium'):
        raise ValueError('STATEMENT_PDF_RENDERER must be poppler or pdfium')
    rotations = rotations or {}
    total = len(PdfReader(pdf).pages)
    pages = pages or list(range(1, total + 1))
    output.mkdir(parents=True, exist_ok=False)
    manifest = {'sourceSHA256': hashlib.sha256(pdf.read_bytes()).hexdigest(), 'totalPages': total,
                'dpi': dpi, 'crop': False, 'extraClockwiseRotation': rotations, 'pages': pages,
                'renderer': renderer}
    (output / 'render-manifest.json').write_text(json.dumps(manifest, indent=2))

    def render(page):
        base = output / f'upright-{page:02}'
        subprocess.run(['pdftoppm', '-f', str(page), '-l', str(page), '-singlefile', '-r', str(dpi),
                        '-jpeg', '-jpegopt', 'quality=95', str(pdf), str(base)], check=True, capture_output=True)
        rotation = rotations.get(str(page), 0)
        if rotation not in (0, 90, 180, 270):
            raise ValueError('Rotation must be 0, 90, 180 or 270 degrees')
        if rotation:
            path = base.with_suffix('.jpg')
            with Image.open(path) as image:
                image.rotate(-rotation, expand=True).save(path, quality=95)
    if renderer == 'pdfium':
        import pypdfium2 as pdfium
        # PDFium is not thread-safe: use a single document and serial rendering.
        with pdfium.PdfDocument(str(pdf)) as document:
            for page in pages:
                rotation = rotations.get(str(page), 0)
                if rotation not in (0, 90, 180, 270):
                    raise ValueError('Rotation must be 0, 90, 180 or 270 degrees')
                source = document[page - 1]
                try:
                    bitmap = source.render(scale=dpi / 72)
                    try:
                        image = bitmap.to_pil().convert('RGB')
                        if rotation:
                            image = image.rotate(-rotation, expand=True)
                        image.save(output / f'upright-{page:02}.jpg', quality=95)
                    finally:
                        bitmap.close()
                finally:
                    source.close()
    else:
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(render, pages))
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dpi', type=int, default=250)
    parser.add_argument('--rotations', type=Path)
    parser.add_argument('--pages')
    args = parser.parse_args()
    rotations = json.loads(args.rotations.read_text()) if args.rotations else {}
    pages = [int(p) for p in args.pages.split(',')] if args.pages else None
    print(json.dumps(prepare(args.pdf, args.output, args.dpi, rotations, pages)))


if __name__ == '__main__':
    main()
