"""Reject duplicate model object keys rather than silently dropping evidence."""
import json


def loads(text):
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate JSON key in model response')
            result[key] = value
        return result
    return json.loads(text, object_pairs_hook=object_pairs)
