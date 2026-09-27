"""Fresh model calls over a hash-identified local PDF suite. Qwen credential on stdin."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--pdf-directory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=2)
    args = parser.parse_args()
    credential = sys.stdin.readline().strip()
    if not credential:
        raise ValueError('Qwen credential required on stdin')
    args.output.mkdir(parents=True, exist_ok=False)
    pdfs = {hashlib.sha256(p.read_bytes()).hexdigest(): p for p in args.pdf_directory.glob('*.pdf')}
    policies = [*Path('src/recognition').glob('*.ts'), Path('src/review/qualityDelivery.ts'),
        *[Path('scripts', name) for name in ['runQualityExperiment.py', 'experimentPrimaryPages.py',
            'experimentIndependentKeys.py', 'experimentFocusedAccounts.py', 'experimentSourceAssembly.py']],
        *[Path('scripts/prompts', name) for name in ['qwenPagewiseVerbatimV3.txt', 'qwenPagewiseVerbatimV4.txt', 'geminiIndependentKeysV3.txt',
            'geminiTableMappingV5.txt', 'geminiFocusedAccountsV2.txt']]]
    frozen = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in policies}
    (args.output / 'policy-manifest.json').write_text(json.dumps({'policies': frozen, 'standardAnswersRead': False,
        'runKind': 'FRESH_PRIMARY_AND_INDEPENDENT_AND_MAPPING'}, indent=2))

    def check_policy():
        if any(hashlib.sha256(Path(p).read_bytes()).hexdigest() != h for p, h in frozen.items()):
            raise ValueError('Policy changed during execution')

    def run_one(source):
        root = args.output / source.name
        root.mkdir()
        metadata = json.loads((source / 'document-manifest.json').read_text())
        pdf = pdfs[metadata['sourceSHA256']]
        (root / 'images').symlink_to((source / 'images').resolve(), target_is_directory=True)
        command = ['python3', 'scripts/runQualityExperiment.py', '--pdf', str(pdf), '--output', str(root),
            '--images', str(root / 'images')]
        if metadata['singleIssuer']:
            command += ['--single-issuer']
        if metadata.get('issuerBankName'):
            command += ['--issuer-bank', metadata['issuerBankName']]
        check_policy()
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        child.stdin.write(credential + '\n'); child.stdin.close()
        with (root / 'execution.log').open('w') as stream:
            for line in child.stdout:
                stream.write(line.replace(credential, '[REDACTED]')); stream.flush()
        if child.wait():
            raise RuntimeError(f'{source.name}: execution failed; log retained')
        check_policy()
        with (root / 'delivery.log').open('w') as stream:
            subprocess.run(['node_modules/.bin/tsx', 'scripts/finalizeQualityDelivery.ts', str(root / 'final'),
                str(root / 'mapping'), str(root / 'delivery')], stdout=stream, stderr=subprocess.STDOUT, check=True)
        state = json.loads((root / 'delivery/review-state.json').read_text())
        result = {'document': source.name, 'status': state['status'], 'requiredRows': state['requiredRowCount']}
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return result

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = {pool.submit(run_one, p): p.name for p in sorted(args.inventory.iterdir()) if p.is_dir() and p.name.isdigit()}
        for future in as_completed(jobs):
            try:
                results.append(future.result())
            except Exception as error:
                results.append({'document': jobs[future], 'status': 'FAILED', 'error': str(error)})
                print(json.dumps(results[-1], ensure_ascii=False), flush=True)
            (args.output / 'execution-status.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    check_policy()
    if any(r['status'] == 'FAILED' for r in results):
        raise RuntimeError('Suite contains failed documents; no acceptance claim')


if __name__ == '__main__':
    main()
