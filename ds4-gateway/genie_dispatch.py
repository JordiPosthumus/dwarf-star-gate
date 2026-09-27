"""Private, content-free audit of the tool messages Hermes actually returned."""
import hashlib
import json


def dispatch_summary(messages, allowed_tools, detect_failure):
    if not isinstance(messages, list):
        return {'schema': 1, 'available': False, 'calls': [],
                'scope': 'Hermes did not return dispatch messages; tool-call activity is unknown.'}
    allowed = set(allowed_tools) | {'tool_search', 'tool_describe', 'tool_call'}
    calls = []
    pending = {}
    for message in messages:
        if not isinstance(message, dict):
            continue
        if message.get('role') == 'assistant':
            for call in message.get('tool_calls') or []:
                if not isinstance(call, dict) or not isinstance(call.get('id'), str):
                    continue
                fn = call.get('function') if isinstance(call.get('function'), dict) else {}
                name = fn.get('name')
                name = name if isinstance(name, str) else 'unrecognized'
                row = {'call_id_sha256': hashlib.sha256(call['id'].encode()).hexdigest(),
                       'tool': name if name in allowed else 'unrecognized', 'state': 'no_result'}
                if name == 'tool_call':
                    try:
                        args = json.loads(fn.get('arguments', '{}'))
                        target = args.get('name') if isinstance(args, dict) else None
                    except (ValueError, TypeError):
                        target = None
                    row['target'] = target if isinstance(target, str) and target in allowed_tools else 'unrecognized'
                calls.append(row)
                pending[call['id']] = (row, name)
        elif message.get('role') == 'tool' and isinstance(message.get('tool_call_id'), str) and message['tool_call_id'] in pending:
            row, name = pending.pop(message['tool_call_id'])
            content = message.get('content')
            raw = content if isinstance(content, str) else json.dumps(content, sort_keys=True)
            is_error, _private_suffix = detect_failure(name, raw)
            row.update(state='error' if is_error else 'returned',
                       result_sha256=hashlib.sha256(raw.encode()).hexdigest(), result_bytes=len(raw.encode()))
    return {'schema': 1, 'available': True, 'calls': calls,
            'scope': 'Hermes tool-dispatch results, not fleet completion. No arguments or result text retained. '
                     'A returned result can still describe a failed operation; no_result means unobserved.'}
