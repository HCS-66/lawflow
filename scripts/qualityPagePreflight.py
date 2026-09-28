"""Conservative full-page preprocessing policy; never reads transaction answers."""
from PIL import Image


POLICY_VERSION = 'FULL_PAGE_PREFLIGHT_V1'


def validate_classification(value):
    if not isinstance(value, dict) or set(value) != {'pageKind', 'clockwiseRotation', 'reason'}:
        raise ValueError('Invalid preflight fields')
    if value['pageKind'] not in ('blank', 'content', 'uncertain'):
        raise ValueError('Invalid page kind')
    rotation = value['clockwiseRotation']
    if rotation is not None and (type(rotation) is not int or rotation not in (0, 90, 180, 270)):
        raise ValueError('Invalid rotation')
    if value['pageKind'] == 'blank' and rotation is not None:
        raise ValueError('Blank page cannot establish text orientation')
    if not isinstance(value['reason'], str) or not value['reason'].strip():
        raise ValueError('Missing preflight reason')


def image_metrics(path):
    with Image.open(path) as image:
        histogram = image.convert('L').histogram()
        pixels = image.width * image.height
        return {'width': image.width, 'height': image.height,
                'darkFraction160': sum(histogram[:160]) / pixels,
                'darkFraction210': sum(histogram[:210]) / pixels}


def decide(value, metrics, has_pdf_text):
    validate_classification(value)
    # Deliberately conservative: even a model-labelled blank page stays in the
    # recognition path when the complete image contains appreciable ink.
    pixel_blank = metrics['darkFraction160'] <= .00005 and metrics['darkFraction210'] <= .0001
    blank = value['pageKind'] == 'blank' and pixel_blank and not has_pdf_text
    rotation = value['clockwiseRotation'] if value['pageKind'] != 'blank' else None
    return {'blankConfirmed': blank, 'pixelBlank': pixel_blank, 'hasPdfText': has_pdf_text,
            'clockwiseRotation': rotation or 0,
            'orientationUncertain': value['pageKind'] != 'blank' and rotation is None,
            'action': 'SKIP_BLANK_EXTRACTION' if blank else 'KEEP_FULL_PAGE'}


def is_verified_blank(wrapper):
    evidence = wrapper.get('preflight', {})
    return (wrapper.get('finishReason') == 'SKIPPED_BLANK'
            and evidence.get('policyVersion') == POLICY_VERSION
            and evidence.get('blankConfirmed') is True
            and evidence.get('pixelBlank') is True and evidence.get('hasPdfText') is False
            and evidence.get('modelPageKind') == 'blank'
            and len(evidence.get('imageSHA256', '')) == 64
            and len(evidence.get('responseSHA256', '')) == 64)


def blank_wrapper(page, independent=False):
    if not page['decision']['blankConfirmed']:
        raise ValueError('An unconfirmed page cannot bypass extraction')
    value = {'pageType': 'blank', 'coverage': 'complete', 'pageIssues': [], 'rows': [],
             'bankName': '', 'ownerNames': [], 'ownerIdentifiers': []} if independent else {'nearTableText': [], 'tables': []}
    return {'page': page['page'], 'finishReason': 'SKIPPED_BLANK', 'producer': 'preflight-policy',
            'result': value, 'preflight': {**page['decision'], 'policyVersion': POLICY_VERSION,
              'modelPageKind': page['classification']['pageKind'], 'imageSHA256': page['imageSHA256'],
              'responseSHA256': page['responseSHA256']}}
