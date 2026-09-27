"""Replay a saved first-pass/independent suite with one frozen policy. Never reads gold."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=3)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    paths = [*Path('src/recognition').glob('*.ts'), Path('src/review/qualityDelivery.ts'),
             Path('scripts/prompts/geminiTableMappingV5.txt'), Path('scripts/prompts/geminiFocusedAccountsV2.txt')]
    frozen = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    (args.output / 'policy-manifest.json').write_text(json.dumps({'policies': frozen, 'standardAnswersRead': False,
        'runKind': 'SAVED_FIRST_PASS_WITH_FRESH_FULL_LIST_MAPPING', 'sourceSuite': str(args.input.resolve())}, indent=2))

    def check_policy():
        if any(hashlib.sha256(Path(p).read_bytes()).hexdigest() != h for p, h in frozen.items()):
            raise ValueError('Policy changed during suite execution; results cannot share a frozen policy')

    def run_one(source):
        root = args.output / source.name
        root.mkdir()
        manifest = json.loads((source / 'document-manifest.json').read_text())
        manifest['mappingReplay'] = 'geminiTableMappingV5.txt'
        (root / 'document-manifest.json').write_text(json.dumps(manifest, indent=2))
        for name in ('images', 'primary', 'independent'):
            (root / name).symlink_to((source / name).resolve(), target_is_directory=True)

        def run(stage, command):
            check_policy()
            with (root / f'{stage}.log').open('w') as stream:
                result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT)
            if result.returncode:
                raise RuntimeError(f'{source.name}/{stage}: failed; diagnostics retained')

        mapping = root / 'mapping'
        run('mapping', ['python3', 'scripts/experimentSourceAssembly.py', '--input', str(root / 'primary'),
            '--output', str(mapping), '--prompt', 'scripts/prompts/geminiTableMappingV5.txt', '--layout'])
        scope = ['--single-issuer'] if manifest['singleIssuer'] else []
        if manifest.get('issuerBankName'):
            scope += ['--issuer-bank', manifest['issuerBankName']]
        base = ['node_modules/.bin/tsx', 'scripts/runQualityTrial.ts', str(mapping), str(root / 'independent')]
        run('initial', [*base, str(root / 'initial'), *scope])
        run('plan', ['node_modules/.bin/tsx', 'scripts/planAccountRecovery.ts', str(root / 'initial'), str(mapping),
            str(root / 'independent'), str(root / 'recovery-plan.json')])
        plan = json.loads((root / 'recovery-plan.json').read_text())
        selected = [x['page'] for x in plan['selected']]
        extra = []
        if selected:
            run('recovery', ['python3', 'scripts/experimentFocusedAccounts.py', '--images', str(root / 'images'),
                '--output', str(root / 'recovery'), '--pages', ','.join(map(str, selected))])
            extra = ['--account-recovery-dir', str(root / 'recovery')]
        run('final', [*base, str(root / 'final'), *scope, *extra])
        run('delivery', ['node_modules/.bin/tsx', 'scripts/finalizeQualityDelivery.ts', str(root / 'final'),
            str(mapping), str(root / 'delivery')])
        state = json.loads((root / 'delivery/review-state.json').read_text())
        result = {'document': source.name, 'status': state['status'], 'requiredRows': state['requiredRowCount']}
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return result

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(run_one, p): p.name for p in sorted(args.input.iterdir()) if p.is_dir() and p.name.isdigit()}
        for future in as_completed(jobs):
            try:
                results.append(future.result())
            except Exception as error:
                results.append({'document': jobs[future], 'status': 'FAILED', 'error': str(error)})
                print(json.dumps(results[-1], ensure_ascii=False), flush=True)
            (args.output / 'execution-status.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    check_policy()
    if any(r['status'] == 'FAILED' for r in results):
        raise RuntimeError('Some documents failed; no acceptance claim')


if __name__ == '__main__':
    main()
