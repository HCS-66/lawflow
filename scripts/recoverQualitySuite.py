"""Apply a frozen policy and one evidence-triggered primary reread to saved runs. No gold access."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from prepareQualityPages import prepare


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pdf-directory', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=2)
    args = parser.parse_args()
    key = sys.stdin.readline().strip()
    if not key:
        raise ValueError('Qwen credential required on stdin')
    args.output.mkdir(parents=True, exist_ok=False)
    pdfs = {hashlib.sha256(p.read_bytes()).hexdigest(): p for p in args.pdf_directory.glob('*.pdf')}
    paths = [*Path('src/recognition').glob('*.ts'), Path('src/review/qualityDelivery.ts'),
        *Path('scripts/prompts').glob('*V[345].txt'), Path('scripts/prompts/geminiFocusedAccountsV2.txt')]
    frozen = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    (args.output / 'policy-manifest.json').write_text(json.dumps({'policies': frozen, 'standardAnswersRead': False,
        'runKind': 'SAVED_READINGS_PLUS_ONE_AUTOMATIC_COVERAGE_RECOVERY', 'sourceSuite': str(args.input.resolve())}, indent=2))

    def run_one(source):
        root = args.output / source.name; root.mkdir()
        metadata = json.loads((source / 'document-manifest.json').read_text())
        (root / 'document-manifest.json').write_text(json.dumps(metadata, indent=2))
        for name in ['images', 'independent']:
            (root / name).symlink_to((source / name).resolve(), target_is_directory=True)
        primary, mapping = source / 'primary', source / 'mapping'
        recovery = root / 'recovery'
        if (source / 'recovery').exists():
            shutil.copytree(source / 'recovery', recovery)

        def run(stage, command, credential=False):
            if any(hashlib.sha256(Path(p).read_bytes()).hexdigest() != h for p, h in frozen.items()):
                raise ValueError('Policy changed during execution')
            child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if credential: child.stdin.write(key + '\n')
            child.stdin.close()
            with (root / f'{stage}.log').open('w') as stream:
                for line in child.stdout: stream.write(line.replace(key, '[REDACTED]')); stream.flush()
            if child.wait(): raise RuntimeError(f'{source.name}/{stage}: failed')

        scope = ['--single-issuer'] if metadata['singleIssuer'] else []
        if metadata.get('issuerBankName'): scope += ['--issuer-bank', metadata['issuerBankName']]
        def trial(stage):
            extra = ['--account-recovery-dir', str(recovery)] if recovery.exists() else []
            run(stage, ['node_modules/.bin/tsx', 'scripts/runQualityTrial.ts', str(mapping), str(source / 'independent'),
                str(root / stage), *scope, *extra])
        trial('initial')
        run('primary-plan', ['node_modules/.bin/tsx', 'scripts/planPrimaryRecovery.ts', str(root / 'initial'),
            str(mapping), str(root / 'primary-recovery-plan.json')])
        selected = [x['page'] for x in json.loads((root / 'primary-recovery-plan.json').read_text())['selected']]
        if selected:
            rendered = json.loads((source / 'images/render-manifest.json').read_text())
            prepare(pdfs[metadata['sourceSHA256']], root / 'primary-recovery-images', dpi=250,
                rotations=rendered['extraClockwiseRotation'], pages=selected)
            run('primary-recovery', ['python3', 'scripts/experimentPrimaryPages.py', '--images', str(root / 'primary-recovery-images'),
                '--output', str(root / 'primary-recovery'), '--pages', str(rendered['totalPages']), '--selected-pages', ','.join(map(str, selected)),
                '--prompt', 'scripts/prompts/qwenPagewiseVerbatimV4.txt'], True)
            shutil.copytree(primary, root / 'primary-combined')
            primary = root / 'primary-combined'
            for page in selected: shutil.copy2(root / 'primary-recovery' / f'page-{page:02}.json', primary / f'page-{page:02}.json')
            (primary / 'combined-provenance.json').write_text(json.dumps({'original': str((source / 'primary').resolve()),
                'replacement': str((root / 'primary-recovery').resolve()), 'replacedPages': selected, 'standardAnswersRead': False}, indent=2))
            mapping = root / 'mapping-recovery'
            run('mapping-recovery', ['python3', 'scripts/experimentSourceAssembly.py', '--input', str(primary), '--output', str(mapping),
                '--prompt', 'scripts/prompts/geminiTableMappingV5.txt', '--layout'])
            trial('after-primary-recovery')
        current = root / ('after-primary-recovery' if selected else 'initial')
        run('account-plan', ['node_modules/.bin/tsx', 'scripts/planAccountRecovery.ts', str(current), str(mapping),
            str(source / 'independent'), str(root / 'account-recovery-plan.json')])
        account_pages = [x['page'] for x in json.loads((root / 'account-recovery-plan.json').read_text())['selected']
            if not (recovery / f"page-{x['page']:02}.json").exists()]
        if account_pages:
            run('account-recovery', ['python3', 'scripts/experimentFocusedAccounts.py', '--images', str(root / 'images'),
                '--output', str(root / 'recovery-new'), '--pages', ','.join(map(str, account_pages))])
            recovery.mkdir(exist_ok=True)
            for page in account_pages: shutil.copy2(root / 'recovery-new' / f'page-{page:02}.json', recovery / f'page-{page:02}.json')
        (root / 'mapping').symlink_to(mapping.resolve(), target_is_directory=True)
        (root / 'primary').symlink_to(primary.resolve(), target_is_directory=True)
        trial('final')
        run('delivery', ['node_modules/.bin/tsx', 'scripts/finalizeQualityDelivery.ts', str(root / 'final'), str(mapping), str(root / 'delivery')])
        state = json.loads((root / 'delivery/review-state.json').read_text())
        result = {'document': source.name, 'status': state['status'], 'requiredRows': state['requiredRowCount'], 'primaryRereadPages': selected}
        print(json.dumps(result, ensure_ascii=False), flush=True); return result

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(run_one, p): p.name for p in sorted(args.input.iterdir()) if p.is_dir() and p.name.isdigit()}
        for future in as_completed(jobs):
            try: results.append(future.result())
            except Exception as error:
                results.append({'document': jobs[future], 'status': 'FAILED', 'error': str(error)})
                print(json.dumps(results[-1], ensure_ascii=False), flush=True)
            (args.output / 'execution-status.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    if any(r['status'] == 'FAILED' for r in results): raise RuntimeError('Recovery suite contains failures')


if __name__ == '__main__': main()
