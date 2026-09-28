"""Text-only assembly plan over a single complete first-pass list. No gold access."""
import argparse
import hashlib
import json
import re
from pathlib import Path

from experimentGeminiStage2Verbatim import request_all
from experimentThreePassStatement import read_key
from experimentPrimaryPages import validate as validate_primary
from strictModelJson import loads as strict_loads
from qualityPagePreflight import is_verified_blank


def build_sources(root):
    pages, cells, rows = [], {}, {}
    next_cell, next_row = 1, 1
    for path in sorted((p for p in root.glob('page-*.json') if re.fullmatch(r'page-\d+\.json', p.name)),
                       key=lambda p: int(p.stem.split('-')[1])):
        wrapper = json.loads(path.read_text())
        if wrapper.get('finishReason') not in ('stop', 'STOP') and not is_verified_blank(wrapper):
            raise ValueError(f'Incomplete source page: {path.name}')
        page_number = wrapper['page']
        raw = wrapper['result']
        validate_primary(raw)
        if is_verified_blank(wrapper) and raw != {'nearTableText': [], 'tables': []}:
            raise ValueError('Skipped blank page contains source text')
        page = {'page': page_number, 'h': [], 'tables': []}
        for text in raw['nearTableText']:
            page['h'].append([next_cell, text])
            cells[str(next_cell)] = {'id': next_cell, 'text': text, 'page': page_number, 'row': None, 'column': None}
            next_cell += 1
        for table_number, table in enumerate(raw['tables'], 1):
            output = []
            for local_row, values in enumerate(table['rows'], 1):
                if not isinstance(values, list) or not all(isinstance(x, str) for x in values):
                    raise ValueError('Malformed original row')
                output.append({'id': next_row, 'b': next_cell, 'c': values})
                rows[str(next_row)] = {'id': next_row, 'page': page_number, 'table': table_number, 'row': local_row,
                                       'cells': list(range(next_cell, next_cell + len(values)))}
                for column, value in enumerate(values, 1):
                    cells[str(next_cell)] = {'id': next_cell, 'text': value, 'page': page_number,
                                             'row': next_row, 'column': column}
                    next_cell += 1
                next_row += 1
            page['tables'].append(output)
        pages.append(page)
    numbers = [p['page'] for p in pages]
    if not pages or numbers != list(range(1, len(pages) + 1)):
        raise ValueError('Source pages must be complete and consecutive')
    return pages, {'cells': cells, 'rows': rows, 'pages': numbers}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--prompt', type=Path, default=Path('scripts/prompts/geminiSourceAssemblyV1.txt'))
    parser.add_argument('--model', default='gemini-3.8-flash')
    parser.add_argument('--layout', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    pages, registry = build_sources(args.input)
    def save(name, value):
        (args.output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2))
    save('source-input.json', pages)
    save('registry.json', registry)
    save('manifest.json', {'model': args.model, 'promptSHA256': hashlib.sha256(args.prompt.read_bytes()).hexdigest(),
                          'sourceSHA256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(args.input.glob('page-*.json')) if re.fullmatch(r'page-\d+\.json', p.name)},
                          'requestCount': 1, 'goldIncluded': False, 'imagesIncluded': False})
    print(json.dumps({'pages': len(pages), 'rows': len(registry['rows']), 'cells': len(registry['cells'])}), flush=True)
    response = request_all(read_key(), args.model, args.prompt.read_text(), pages, args.output)
    save('response.json', response)
    if response['finishReason'] != 'STOP':
        raise ValueError('Incomplete response retained; no successful assembly written')
    plan = strict_loads(response['rawContent'])
    if args.layout:
        if not isinstance(plan.get('tables'), list):
            raise ValueError('Invalid layout root')
        save('layout.json', plan)
        count = sum(len(t.get('groups', [])) for t in plan['tables'])
    else:
        if not isinstance(plan.get('rows'), list) or not isinstance(plan.get('ignored'), list):
            raise ValueError('Invalid assembly root')
        save('assembly.json', plan)
        count = len(plan['rows'])
    print(json.dumps({'rows': count, 'seconds': response['seconds'], 'finishReason': response['finishReason']}), flush=True)


if __name__ == '__main__':
    main()
