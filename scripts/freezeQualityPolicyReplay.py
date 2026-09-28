"""Apply one program policy to existing model outputs; performs no model calls or gold reads."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    policies = [*Path('src/recognition').glob('*.ts'), Path('src/review/qualityDelivery.ts')]
    frozen = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in policies}
    (args.output / 'policy-manifest.json').write_text(json.dumps({'policies': frozen, 'standardAnswersRead': False,
        'modelCalls': 0, 'sourceSuite': str(args.input.resolve()), 'runKind': 'FIXED_POLICY_REPLAY'}, indent=2))
    results = []
    for source in sorted(p for p in args.input.iterdir() if p.is_dir() and p.name.isdigit()):
        root = args.output / source.name; root.mkdir()
        metadata = json.loads((source / 'document-manifest.json').read_text())
        metadata['policyReplayOf'] = str(source.resolve())
        (root / 'document-manifest.json').write_text(json.dumps(metadata, indent=2))
        for name in ['mapping', 'images', 'independent', 'primary']:
            origin = source / name
            if name == 'primary' and (source / 'primary-combined').exists(): origin = source / 'primary-combined'
            (root / name).symlink_to(origin.resolve(), target_is_directory=True)
        scope = ['--single-issuer'] if metadata['singleIssuer'] else []
        if metadata.get('issuerBankName'): scope += ['--issuer-bank', metadata['issuerBankName']]
        if (source / 'recovery').exists():
            (root / 'recovery').symlink_to((source / 'recovery').resolve(), target_is_directory=True)
            scope += ['--account-recovery-dir', str(source / 'recovery')]
        if (source / 'field-recovery').exists():
            (root / 'field-recovery').symlink_to((source / 'field-recovery').resolve(), target_is_directory=True)
            scope += ['--field-recovery-dir', str(source / 'field-recovery')]
        with (root / 'execution.log').open('w') as log:
            subprocess.run(['node_modules/.bin/tsx', 'scripts/runQualityTrial.ts', str(source / 'mapping'),
                str(source / 'independent'), str(root / 'final'), *scope], stdout=log, stderr=subprocess.STDOUT, check=True)
            subprocess.run(['node_modules/.bin/tsx', 'scripts/finalizeQualityDelivery.ts', str(root / 'final'),
                str(source / 'mapping'), str(root / 'delivery')], stdout=log, stderr=subprocess.STDOUT, check=True)
        state = json.loads((root / 'delivery/review-state.json').read_text())
        results.append({'document': source.name, 'status': state['status'], 'requiredRows': state['requiredRowCount']})
    if any(hashlib.sha256(Path(p).read_bytes()).hexdigest() != h for p, h in frozen.items()): raise ValueError('Policy changed')
    (args.output / 'execution-status.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(json.dumps(results, ensure_ascii=False))


if __name__ == '__main__': main()
