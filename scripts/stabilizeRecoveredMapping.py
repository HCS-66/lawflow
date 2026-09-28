"""Retain unchanged table mappings after a bounded source-page reread."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil
from collections import defaultdict


def indexes(registry):
    row_keys = {int(k): (v['page'], v['table'], v['row']) for k, v in registry['rows'].items()}
    cell_keys, page_content = {}, defaultdict(list)
    occurrences = defaultdict(int)
    for key, cell in sorted(registry['cells'].items(), key=lambda p: int(p[0])):
        base = (cell['page'], row_keys.get(cell['row']), cell['column'], cell['text'])
        ordinal = occurrences[base]; occurrences[base] += 1
        cell_keys[int(key)] = (*base, ordinal)
        page_content[cell['page']].append((*base[1:], ordinal))
    return row_keys, cell_keys, dict(page_content)


def stabilize(previous, reread, output):
    if output.exists():
        raise ValueError('Mapping evidence is immutable; choose a new destination')
    old_registry = json.loads((previous / 'registry.json').read_text())
    new_registry = json.loads((reread / 'registry.json').read_text())
    old = json.loads((previous / 'layout.json').read_text())
    new = json.loads((reread / 'layout.json').read_text())
    if old_registry['pages'] != new_registry['pages']:
        raise ValueError('Recovery changed the original page inventory')
    old_rows, old_cells, old_content = indexes(old_registry)
    new_rows, new_cells, new_content = indexes(new_registry)
    row_lookup = {v: k for k, v in new_rows.items()}
    cell_lookup = {v: k for k, v in new_cells.items()}
    unchanged = {p for p in old_registry['pages'] if old_content.get(p) == new_content.get(p)}
    prior_tables = {(t['page'], t['table']): t for t in old['tables']}
    reused, fallback, tables = [], [], []

    def field(selector):
        value = copy.deepcopy(selector)
        if value and 'fixed' in value:
            value['fixed'] = cell_lookup[old_cells[value['fixed']]]
        return value

    for latest in new['tables']:
        key = (latest['page'], latest['table'])
        if latest['page'] not in unchanged or key not in prior_tables:
            tables.append(latest); continue
        try:
            table = copy.deepcopy(prior_tables[key])
            table['fields'] = {k: field(v) for k, v in table['fields'].items()}
            table['groups'] = [[row_lookup[old_rows[r]] for r in group] for group in table['groups']]
            for item in table['ignored']:
                item['r'] = [row_lookup[old_rows[r]] for r in item['r']]
            for item in table.get('overrides', []):
                item['firstRow'] = row_lookup[old_rows[item['firstRow']]]
                item['fields'] = {k: field(v) for k, v in item['fields'].items()}
        except KeyError:
            tables.append(latest); fallback.append(list(key)); continue
        tables.append(table); reused.append(list(key))
    # A source reread adds observations; it does not revoke an established type dictionary.
    rules = copy.deepcopy(old['typeRules'])
    rule_keys = {(r['accountKind'], ''.join(r['text'].replace('\\n', '').split())) for r in rules}
    for rule in new['typeRules']:
        key = (rule['accountKind'], ''.join(rule['text'].replace('\\n', '').split()))
        if key not in rule_keys:
            rules.append(rule); rule_keys.add(key)
    output.mkdir(parents=True)
    shutil.copy2(reread / 'registry.json', output / 'registry.json')
    (output / 'layout.json').write_text(json.dumps({'tables': tables, 'typeRules': rules}, ensure_ascii=False, indent=2))
    evidence = {'kind': 'PRESERVE_UNCHANGED_PAGE_MAPPINGS', 'standardAnswersRead': False,
                'unchangedPages': sorted(unchanged), 'reusedTables': reused, 'unavailableCrossPageReference': fallback,
                'inputs': {str(p.resolve()): hashlib.sha256(p.read_bytes()).hexdigest()
                           for root in [previous, reread] for p in [root / 'layout.json', root / 'registry.json']}}
    (output / 'stabilization-manifest.json').write_text(json.dumps(evidence, indent=2))
    return evidence


def rebase_empty_page_recovery(previous, new_registry, output):
    """No model mapping is needed when all changed source pages now contain zero tables."""
    if output.exists():
        raise ValueError('Mapping evidence is immutable')
    old_registry = json.loads((previous / 'registry.json').read_text())
    old = json.loads((previous / 'layout.json').read_text())
    old_rows, old_cells, old_content = indexes(old_registry)
    new_rows, new_cells, new_content = indexes(new_registry)
    if old_registry['pages'] != new_registry['pages']:
        raise ValueError('Original page inventory changed')
    changed = {p for p in old_registry['pages'] if old_content.get(p) != new_content.get(p)}
    if any(r['page'] in changed for r in new_registry['rows'].values()):
        raise ValueError('Changed pages still have source tables and require a new mapping')
    row_lookup, cell_lookup = {v: k for k, v in new_rows.items()}, {v: k for k, v in new_cells.items()}
    result = copy.deepcopy(old)
    result['tables'] = [t for t in result['tables'] if t['page'] not in changed]
    for table in result['tables']:
        for selector in [*table['fields'].values(), *[s for o in table.get('overrides', []) for s in o['fields'].values()]]:
            if selector and 'fixed' in selector:
                selector['fixed'] = cell_lookup[old_cells[selector['fixed']]]
        table['groups'] = [[row_lookup[old_rows[r]] for r in group] for group in table['groups']]
        for item in table['ignored']:
            item['r'] = [row_lookup[old_rows[r]] for r in item['r']]
        for item in table.get('overrides', []):
            item['firstRow'] = row_lookup[old_rows[item['firstRow']]]
    output.mkdir(parents=True)
    (output / 'layout.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    (output / 'registry.json').write_text(json.dumps(new_registry, ensure_ascii=False, indent=2))
    (output / 'stabilization-manifest.json').write_text(json.dumps({'kind': 'RECOVERY_WITH_NO_READABLE_TABLES',
        'sourceMapping': str(previous.resolve()), 'changedPages': sorted(changed), 'standardAnswersRead': False,
        'retainedMappings': len(result['tables']), 'newMappingCall': False}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--previous', type=Path, required=True)
    parser.add_argument('--reread', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = stabilize(args.previous, args.reread, args.output)
    print(json.dumps({'preservedTables': len(result['reusedTables']), 'unchangedPages': len(result['unchangedPages'])}))
