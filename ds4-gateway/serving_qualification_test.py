import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from serving_qualification import NativeQualification

CONTRACT = {'kind': 'qwen_vllm', 'model': 'fixture-model', 'context_length': 16384,
            'reasoning_eos': {'eos_token_ids': [248044, 248046], 'ordinary_token_id': 760}}


class API:
    """Deterministic external API fixture; no real inference or fleet connection."""
    def __init__(self):
        self.calls = []
        self.mutate = lambda route, body, result: result
        self.fail = None
        self.context = CONTRACT['context_length']

    def __call__(self, url, route, body=None):
        self.calls.append((route, copy.deepcopy(body)))
        if self.fail == route: raise OSError('fixture connection lost')
        if route == '/metrics':
            text = 'vllm:num_preemptions_total{engine="0"} 0\nvllm:request_success_total{engine="0",finished_reason="abort"} 0\nvllm:request_success_total{engine="0",finished_reason="error"} 0\n'
            result = {'status': 200, 'body_base64': base64.b64encode(text.encode()).decode()}
        else:
            status = 200
            if route == '/v1/models':
                data = {'data': [{'id': 'fixture-model', 'max_model_len': self.context}]}
            elif body.get('stream'):
                data = 'data: '+json.dumps({'choices': [{'token_ids': [760] * 16, 'finish_reason': 'length'}], 'usage': {'completion_tokens': 16}})+'\n\ndata: [DONE]\n'
            elif isinstance(body.get('prompt'), list):
                if len(body['prompt']) == self.context:
                    status = 400; data = {'error': {'message': f'Input length ({self.context}) leaves no room to generate at maximum context length ({self.context})'}}
                else:
                    data = {'choices': [{'finish_reason': 'length', 'text': 'x'}], 'usage': {'prompt_tokens': self.context - 1, 'completion_tokens': 1, 'total_tokens': self.context}}
            elif body.get('allowed_token_ids'):
                data = {'choices': [{'finish_reason': 'stop'}], 'usage': {'completion_tokens': 1}}
            else:
                last = body['messages'][-1]['content']
                text, finish, usage = '7319', 'stop', {}
                message = {'content': text}
                if isinstance(last, list): message['content'] = 'red'
                elif 'Call report_value' in last:
                    finish = 'tool_calls'; message = {'content': None, 'tool_calls': [{'id': 'fixture-call', 'type': 'function', 'function': {'name': 'report_value', 'arguments': '{"value":7319}'}}]}
                elif 'CHECK_' in last:
                    message['content'] = 'CHECK_A_OK' if 'CHECK_A_OK' in last else 'CHECK_B_OK'
                    usage = {'prompt_tokens': 7400, 'prompt_tokens_details': {'cached_tokens': 0}}
                elif 'WARM_' in last:
                    message['content'] = 'WARM_A_OK' if 'WARM_A_OK' in last else 'WARM_B_OK'
                    usage = {'prompt_tokens': 7500, 'prompt_tokens_details': {'cached_tokens': 4800}}
                data = {'choices': [{'finish_reason': finish, 'message': message}], 'usage': usage}
            raw = data.encode() if isinstance(data, str) else json.dumps(data).encode()
            result = {'status': status, 'body_base64': base64.b64encode(raw).decode()}
        return self.mutate(route, body, result)


class QualificationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.api = API(); self.path = Path(self.temp.name) / 'proof'; self.progress = []
        self.qualifier = NativeQualification(self.api, 'http://127.0.0.1:8001', copy.deepcopy(CONTRACT), progress=lambda *args: self.progress.append(args))

    def test_all_native_contract_checks_save_actual_requests_and_responses(self):
        result = self.qualifier.verify(self.path)
        self.assertEqual(result['state'], 'passed')
        self.assertEqual(len(result['cases']), 15)
        self.assertEqual(result['api']['cache_samples'][0]['warm_cached'], 4800)
        self.assertEqual(result['api']['context_length'], 16384)
        self.assertEqual(result['eos']['constrained_tokens'], 16)
        self.assertEqual(len(list(self.path.glob('*.intent.json'))), 15)
        self.assertEqual(len(list(self.path.glob('*.response.bin'))), 15)
        self.assertEqual(json.loads((self.path / 'result.json').read_text()), result)
        with self.assertRaises(FileExistsError): self.qualifier.verify(self.path)
        self.assertEqual(len(self.api.calls), 15)

    def test_wrong_model_is_a_failed_qualification_not_an_endless_readiness_wait(self):
        def change(route, body, result):
            if route == '/v1/models':
                result['body_base64'] = base64.b64encode(b'{"data":[{"id":"wrong","max_model_len":16384}]}').decode()
            return result
        self.api.mutate = change
        self.assertTrue(self.qualifier.ready())
        self.assertEqual(self.qualifier.verify(self.path)['state'], 'failed')
        self.assertFalse(any(body is not None for _, body in self.api.calls))

    def test_full_selected_spark_context_is_saved_without_a_receipt_size_cap(self):
        contract = copy.deepcopy(CONTRACT); contract['context_length'] = self.api.context = 262144
        result = NativeQualification(self.api, 'http://127.0.0.1:8001', contract).verify(self.path)
        self.assertEqual(result['state'], 'passed')
        reference = json.loads((self.path / 'context-boundary.intent.json').read_text())['request']
        raw = (self.path / reference['file']).read_bytes(); request = json.loads(raw)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), reference['sha256'])
        self.assertEqual(len(request['prompt']), 262143); self.assertEqual(request['max_tokens'], 262144)

    def test_reported_warm_cache_without_actual_reuse_fails(self):
        def change(route, body, result):
            if body and 'WARM_' in str(body.get('messages', [])[-1]):
                data = json.loads(base64.b64decode(result['body_base64'])); data['usage']['prompt_tokens_details']['cached_tokens'] = 0
                result['body_base64'] = base64.b64encode(json.dumps(data).encode()).decode()
            return result
        self.api.mutate = change
        self.assertEqual(self.qualifier.verify(self.path)['state'], 'failed')

    def test_missing_tool_call_is_not_accepted_as_a_claimed_action(self):
        def change(route, body, result):
            if body and body.get('tool_choice') == 'auto':
                data = {'choices': [{'finish_reason': 'stop', 'message': {'content': 'I called the tool.'}}]}
                result['body_base64'] = base64.b64encode(json.dumps(data).encode()).decode()
            return result
        self.api.mutate = change
        self.assertEqual(self.qualifier.verify(self.path)['state'], 'failed')

    def test_eos_before_the_constrained_reasoning_stream_finishes_fails(self):
        def change(route, body, result):
            if body and body.get('stream'):
                result['body_base64'] = base64.b64encode(b'data: {"choices":[{"token_ids":[248044]}],"usage":{"completion_tokens":1}}\n\ndata: [DONE]\n').decode()
            return result
        self.api.mutate = change
        self.assertEqual(self.qualifier.verify(self.path)['state'], 'failed')

    def test_native_failure_counter_change_fails(self):
        def change(route, body, result):
            if route == '/metrics' and len(self.api.calls) > 1:
                raw = base64.b64decode(result['body_base64']).replace(b'finished_reason="abort"} 0', b'finished_reason="abort"} 1')
                result['body_base64'] = base64.b64encode(raw).decode()
            return result
        self.api.mutate = change
        self.assertEqual(self.qualifier.verify(self.path)['state'], 'failed')

    def test_lost_inference_reply_is_preserved_and_never_retried(self):
        self.api.fail = '/v1/chat/completions'
        self.assertEqual(self.qualifier.verify(self.path)['state'], 'failed')
        self.assertEqual(sum(route == self.api.fail for route, _ in self.api.calls), 1)
        self.assertTrue((self.path / 'text.intent.json').exists())
        self.assertFalse((self.path / 'text.result.json').exists())


if __name__ == '__main__': unittest.main()
