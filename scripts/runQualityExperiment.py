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
    parser.add_argument('--preflight', action='store_true', help='Detect blank pages and extra rotation with Gemini before extraction')
    parser.add_argument('--reuse-extractions', type=Path, help='Reuse a complete primary page set from a prior attempt on this exact PDF')
    parser.add_argument('--independent-results', type=Path, help='Independent results with explicit provenance, used only with --reuse-extractions')
    parser.add_argument('--page-context', action='store_true', help='Transcribe issuer headings and account context from every retained full page')
    parser.add_argument('--context-results', type=Path, help='Reuse a complete page-context extraction for these exact rendered images')
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
                  ['qwenPagewiseVerbatimV3.txt', 'qwenPagewiseVerbatimV5.txt', 'qwenPageContextV1.txt', 'geminiIndependentKeysV4.txt', 'geminiIndependentKeysV5.txt', 'geminiTableMappingV7.txt', 'geminiFocusedAccountsV2.txt']},
                'pageContext': args.page_context}
    if args.context_results and not args.page_context:
        raise ValueError('Context reuse requires --page-context')
    if args.context_results:
        manifest['contextResults'] = {'path': str(args.context_results.resolve()),
            'manifestSHA256': hashlib.sha256((args.context_results / 'input-manifest.json').read_bytes()).hexdigest(),
            'pageSHA256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                          for p in args.context_results.glob('page-*.json') if p.stem[5:].isdigit()}}
    reused = None
    if args.independent_results and not args.reuse_extractions:
        raise ValueError('Independent result override requires a recorded extraction source')
    if args.reuse_extractions:
        from experimentSourceAssembly import build_sources
        from experimentIndependentKeys import validate as validate_independent
        from qualityPagePreflight import is_verified_blank
        upstream = json.loads((args.reuse_extractions / 'document-manifest.json').read_text())
        if upstream['sourceSHA256'] != pdf_hash:
            raise ValueError('Reused extraction belongs to a different PDF')
        primary_source = (args.reuse_extractions / 'primary').resolve()
        independent_source = (args.independent_results or args.reuse_extractions / 'independent').resolve()
        _, registry = build_sources(primary_source)
        from pypdf import PdfReader
        if registry['pages'] != list(range(1, len(PdfReader(args.pdf).pages) + 1)):
            raise ValueError('Reused primary pages do not cover the complete PDF')
        fingerprints = {}
        for page in registry['pages']:
            path = independent_source / f'page-{page:02}.json'
            wrapper = json.loads(path.read_text())
            if wrapper.get('page') != page or (wrapper.get('finishReason') != 'STOP' and not is_verified_blank(wrapper)):
                raise ValueError('Reused independent page is not complete')
            validate_independent(wrapper['result'])
            for source in [path, primary_source / path.name]:
                fingerprints[str(source)] = hashlib.sha256(source.read_bytes()).hexdigest()
        manifest['reusedExtractions'] = {'sourceAttempt': str(args.reuse_extractions.resolve()),
          'independentResults': str(independent_source), 'pageSHA256': fingerprints,
          'sourcePrompts': upstream['prompts'], 'newInitialExtractionCalls': False}
        reused = (primary_source, independent_source)
    if args.preflight:
        manifest['preflightPromptSHA256'] = hashlib.sha256(Path('scripts/prompts/geminiPagePreflightV2.txt').read_bytes()).hexdigest()
        manifest['preflightPolicySHA256'] = hashlib.sha256(Path('scripts/qualityPagePreflight.py').read_bytes()).hexdigest()
    if identity.exists() and json.loads(identity.read_text()) != manifest:
        raise ValueError('Output directory belongs to another document or scope')
    identity.write_text(json.dumps(manifest, indent=2))
    policy_files = [*Path('src/recognition').glob('*.ts'), Path('src/review/qualityDelivery.ts'),
      *[Path('scripts', name) for name in ['runQualityExperiment.py', 'runPagePreflight.py', 'qualityPagePreflight.py',
        'qualityPreflightPlan.py', 'mergePrimaryContext.py', 'stabilizeRecoveredMapping.py', 'prepareQualityPages.py', 'experimentPrimaryPages.py', 'experimentIndependentKeys.py',
        'experimentSourceAssembly.py', 'experimentFocusedAccounts.py', 'runQualityTrial.ts']]]
    frozen_policy = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in policy_files}
    policy_path = root / 'pipeline-policy-manifest.json'
    if policy_path.exists() and json.loads(policy_path.read_text()) != frozen_policy:
        raise ValueError('Program policy changed; use another experiment directory')
    policy_path.write_text(json.dumps(frozen_policy, indent=2))
    images = args.images.resolve() if args.images else root / 'images'
    rotations = json.loads(args.rotations.read_text()) if args.rotations else {}
    preflight_args = []
    if args.preflight:
        if args.rotations:
            raise ValueError('Automatic preflight cannot be combined with manual rotation overrides')
        from runPagePreflight import run_preflight
        plan = run_preflight(args.pdf, root / 'preflight-images', root / 'preflight', four_views=True)
        rotations = {str(p['page']): p['decision']['clockwiseRotation'] for p in plan['pages'] if p['decision']['clockwiseRotation']}
        preflight_args = ['--preflight-plan', str(root / 'preflight' / 'plan.json')]
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

    if reused:
        for name, source in zip(['primary', 'independent'], reused):
            link = root / name
            if link.exists() and link.resolve() != source:
                raise ValueError('Reused extraction target mismatch')
            if not link.exists(): link.symlink_to(source, target_is_directory=True)
        print('primary and independent: reusing complete page responses with recorded provenance', flush=True)
    else:
        with ThreadPoolExecutor(max_workers=2) as pool:
            primary = pool.submit(run, 'primary', ['python3', 'scripts/experimentPrimaryPages.py', '--images', str(images),
                                '--output', str(root / 'primary'), '--pages', str(pages), *preflight_args], key)
            independent = pool.submit(run, 'independent', ['python3', 'scripts/experimentIndependentKeys.py', '--images', str(images),
                                    '--output', str(root / 'independent'), '--pages', f'1-{pages}',
                                    '--prompt', 'scripts/prompts/geminiIndependentKeysV4.txt', *preflight_args])
            primary.result(); independent.result()
    primary_input = root / 'primary'
    context = None
    if args.page_context:
        from mergePrimaryContext import merge_context
        context = args.context_results.resolve() if args.context_results else root / 'page-context'
        if args.context_results:
            context_manifest = json.loads((context / 'input-manifest.json').read_text())
            context_images = {str(p): hashlib.sha256((images / f'upright-{p:02}.jpg').read_bytes()).hexdigest()
                              for p in range(1, pages + 1)}
            if context_manifest['images'] != context_images:
                raise ValueError('Context was extracted from a different render')
        else:
            run('page-context', ['python3', 'scripts/experimentPrimaryPages.py', '--images', str(images),
                '--output', str(context), '--pages', str(pages), '--prompt', 'scripts/prompts/qwenPageContextV1.txt', '--context-only', *preflight_args], key)
        primary_input = root / 'primary-with-context'
        merge_context(root / 'primary', context, primary_input)
    mapping = root / 'mapping-initial'
    if not (mapping / 'layout.json').exists():
        run('mapping', ['python3', 'scripts/experimentSourceAssembly.py', '--input', str(primary_input), '--output', str(mapping),
                        '--prompt', 'scripts/prompts/geminiTableMappingV7.txt', '--layout'])
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
            '--prompt', 'scripts/prompts/qwenPagewiseVerbatimV5.txt'], key)
        combined = root / 'primary-combined'
        if not combined.exists(): shutil.copytree(primary_input, combined)
        replacement = root / 'primary-recovery'
        if context:
            replacement = root / 'primary-recovery-with-context'
            merge_context(root / 'primary-recovery', context, replacement)
        for page in source_pages: shutil.copy2(replacement / f'page-{page:02}.json', combined / f'page-{page:02}.json')
        (combined / 'combined-provenance.json').write_text(json.dumps({'original': str(primary_input),
            'replacement': str(replacement), 'replacedPages': source_pages, 'standardAnswersRead': False}, indent=2))
        raw_mapping = root / 'mapping-recovery-model'
        if not (raw_mapping / 'layout.json').exists():
            run('mapping-recovery', ['python3', 'scripts/experimentSourceAssembly.py', '--input', str(combined),
                '--output', str(raw_mapping), '--prompt', 'scripts/prompts/geminiTableMappingV7.txt', '--layout'])
        mapping = root / 'mapping-recovery'
        if not (mapping / 'layout.json').exists():
            from stabilizeRecoveredMapping import stabilize
            stabilize(root / 'mapping-initial', raw_mapping, mapping)
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
    before_fields = root / 'before-field-recovery'
    if not (before_fields / 'result.json').exists():
        run('before-field-recovery', [*base, str(before_fields), *scope, *extra])
    field_plan = root / 'field-recovery-plan.json'
    run('field-recovery-plan', ['node_modules/.bin/tsx', 'scripts/planCriticalFieldRecovery.ts', str(before_fields), str(mapping), str(field_plan)])
    field_pages = [item['page'] for item in json.loads(field_plan.read_text())['selected']]
    if field_pages:
        field_recovery = root / 'field-recovery'
        try:
            run('field-recovery', ['python3', 'scripts/experimentIndependentKeys.py', '--images', str(images),
                '--output', str(field_recovery), '--pages', ','.join(map(str, field_pages)),
                '--prompt', 'scripts/prompts/geminiIndependentKeysV5.txt'])
        except RuntimeError:
            print('Field recovery incomplete; unresolved checks remain required.', flush=True)
        extra += ['--field-recovery-dir', str(field_recovery)]
    run('final', [*base, str(root / 'final'), *scope, *extra])
    if any(hashlib.sha256(Path(p).read_bytes()).hexdigest() != h for p, h in frozen_policy.items()):
        raise ValueError('Program policy changed during this experiment; result is not a frozen-policy run')
    if not (root / 'mapping').exists(): (root / 'mapping').symlink_to(mapping.resolve(), target_is_directory=True)
    print(f'Frozen CSV and evidence: {root / "final"}', flush=True)


if __name__ == '__main__':
    main()
