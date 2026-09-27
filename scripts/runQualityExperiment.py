"""One reproducible PDF-to-CSV quality experiment. Never loads standard answers.

Qwen credential: stdin. Gemini credential: existing GEMINI_API_KEY/.dev.vars loader.
Outputs and retries are retained; an existing matching page cache is resumable.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import shutil

from prepareQualityPages import prepare


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--images', type=Path, help='Previously rendered full pages with a matching render-manifest.json')
    parser.add_argument('--rotations', type=Path)
    parser.add_argument('--single-issuer', action='store_true', help='Input inventory confirms a document from one issuing bank')
    parser.add_argument('--issuer-bank', help='Bank explicitly assigned in the source-document inventory')
    parser.add_argument('--dpi', type=int, default=350)
    args = parser.parse_args()
    key = sys.stdin.readline().strip()
    if not key:
        raise ValueError('Qwen credential required on stdin')
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    pdf_hash = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
    identity = root / 'document-manifest.json'
    manifest = {'sourceSHA256': pdf_hash, 'singleIssuer': args.single_issuer, 'issuerBankName': args.issuer_bank,
                'standardAnswersRead': False, 'dpi': args.dpi,
                'prompts': {name: hashlib.sha256(Path('scripts/prompts', name).read_bytes()).hexdigest() for name in
                  ['qwenPagewiseVerbatimV3.txt', 'qwenPagewiseVerbatimV4.txt', 'geminiIndependentKeysV3.txt', 'geminiTableMappingV5.txt', 'geminiFocusedAccountsV2.txt']}}
    if identity.exists() and json.loads(identity.read_text()) != manifest:
        raise ValueError('Output directory belongs to another document or scope')
    identity.write_text(json.dumps(manifest, indent=2))
    images = args.images.resolve() if args.images else root / 'images'
    rotations = json.loads(args.rotations.read_text()) if args.rotations else {}
    if not images.exists():
        prepare(args.pdf, images, dpi=args.dpi, rotations=rotations)
    rendered = json.loads((images / 'render-manifest.json').read_text())
    if rendered['sourceSHA256'] != pdf_hash or rendered['crop'] or rendered['pages'] != list(range(1, rendered['totalPages'] + 1)):
        raise ValueError('Full-page image manifest disagrees with PDF')
    rotations = rendered['extraClockwiseRotation']
    pages = rendered['totalPages']

    def run(stage, command, credential=None):
        print(f'{stage}: running', flush=True)
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if credential:
            child.stdin.write(credential + '\n')
        child.stdin.close()
        with (root / f'{stage}.log').open('a') as log:
            for line in child.stdout:
                safe = line.replace(key, '[REDACTED]')
                log.write(safe); log.flush()
        if child.wait():
            raise RuntimeError(f'{stage} failed; retained diagnostics in its log')
        print(f'{stage}: complete', flush=True)

    with ThreadPoolExecutor(max_workers=2) as pool:
        primary = pool.submit(run, 'primary', ['python3', 'scripts/experimentPrimaryPages.py', '--images', str(images),
                            '--output', str(root / 'primary'), '--pages', str(pages)], key)
        independent = pool.submit(run, 'independent', ['python3', 'scripts/experimentIndependentKeys.py', '--images', str(images),
                                '--output', str(root / 'independent'), '--pages', f'1-{pages}',
                                '--prompt', 'scripts/prompts/geminiIndependentKeysV3.txt'])
        primary.result(); independent.result()
    mapping = root / 'mapping-initial'
    if not (mapping / 'layout.json').exists():
        run('mapping', ['python3', 'scripts/experimentSourceAssembly.py', '--input', str(root / 'primary'), '--output', str(mapping),
                        '--prompt', 'scripts/prompts/geminiTableMappingV5.txt', '--layout'])
    scope = ['--single-issuer'] if args.single_issuer else []
    if args.issuer_bank:
        scope += ['--issuer-bank', args.issuer_bank]
    base = ['node_modules/.bin/tsx', 'scripts/runQualityTrial.ts', str(mapping), str(root / 'independent')]
    if not (root / 'initial' / 'result.json').exists():
        run('initial', [*base, str(root / 'initial'), *scope])
    if (root / 'final' / 'result.json').exists():
        print('Final result already frozen; use a new output directory for a new policy trial.', flush=True)
        return
    run('primary-recovery-plan', ['node_modules/.bin/tsx', 'scripts/planPrimaryRecovery.ts', str(root / 'initial'),
        str(mapping), str(root / 'primary-recovery-plan.json')])
    source_pages = [item['page'] for item in json.loads((root / 'primary-recovery-plan.json').read_text())['selected']]
    current = root / 'initial'
    if source_pages:
        recovery_images = root / 'primary-recovery-images'
        if not recovery_images.exists(): prepare(args.pdf, recovery_images, dpi=250, rotations=rotations, pages=source_pages)
        run('primary-recovery', ['python3', 'scripts/experimentPrimaryPages.py', '--images', str(recovery_images),
            '--output', str(root / 'primary-recovery'), '--pages', str(pages), '--selected-pages', ','.join(map(str, source_pages)),
            '--prompt', 'scripts/prompts/qwenPagewiseVerbatimV4.txt'], key)
        combined = root / 'primary-combined'
        if not combined.exists(): shutil.copytree(root / 'primary', combined)
        for page in source_pages: shutil.copy2(root / 'primary-recovery' / f'page-{page:02}.json', combined / f'page-{page:02}.json')
        (combined / 'combined-provenance.json').write_text(json.dumps({'original': str(root / 'primary'),
            'replacement': str(root / 'primary-recovery'), 'replacedPages': source_pages, 'standardAnswersRead': False}, indent=2))
        mapping = root / 'mapping-recovery'
        if not (mapping / 'layout.json').exists():
            run('mapping-recovery', ['python3', 'scripts/experimentSourceAssembly.py', '--input', str(combined),
                '--output', str(mapping), '--prompt', 'scripts/prompts/geminiTableMappingV5.txt', '--layout'])
        base = ['node_modules/.bin/tsx', 'scripts/runQualityTrial.ts', str(mapping), str(root / 'independent')]
        current = root / 'after-primary-recovery'
        if not (current / 'result.json').exists(): run('after-primary-recovery', [*base, str(current), *scope])
    plan_path = root / 'recovery-plan.json'
    run('recovery-plan', ['node_modules/.bin/tsx', 'scripts/planAccountRecovery.ts', str(current), str(mapping),
                         str(root / 'independent'), str(plan_path)])
    plan = json.loads(plan_path.read_text())
    selected = [item['page'] for item in plan['selected']]
    extra = []
    if selected:
        recovery_images = root / 'recovery-images'
        if not recovery_images.exists():
            prepare(args.pdf, recovery_images, dpi=350, rotations=rotations, pages=selected)
        recovery = root / 'recovery'
        if not all((recovery / f'page-{p:02}.json').exists() for p in selected):
            run('recovery', ['python3', 'scripts/experimentFocusedAccounts.py', '--images', str(recovery_images),
                             '--output', str(recovery), '--pages', ','.join(map(str, selected))])
        extra = ['--account-recovery-dir', str(recovery)]
    run('final', [*base, str(root / 'final'), *scope, *extra])
    if not (root / 'mapping').exists(): (root / 'mapping').symlink_to(mapping.resolve(), target_is_directory=True)
    print(f'Frozen CSV and evidence: {root / "final"}', flush=True)


if __name__ == '__main__':
    main()
