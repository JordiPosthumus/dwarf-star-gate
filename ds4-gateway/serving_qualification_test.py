import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from serving_qualification import NativeQualification,cache_capacity,compare_cache_capacity

CONTRACT = {'kind': 'qwen_vllm', 'model': 'fixture-model', 'context_length': 16384,
            'reasoning_eos': {'eos_token_ids': [248044, 248046], 'ordinary_token_id': 760}}


class API:
    """Deterministic external API fixture; no real inference or fleet connection."""
    def __init__(self):
        self.calls = []
        self.mutate = lambda route, body, result: result
        self.fail = None
        self.context = CONTRACT['context_length']
        self.cache_tokens = None

    def __call__(self, url, route, body=None):
        self.calls.append((route, copy.deepcopy(body)))
        if self.fail == route: raise OSError('fixture connection lost')
        if route == '/metrics':
            text = 'vllm:num_preemptions_total{engine="0"} 0\nvllm:request_success_total{engine="0",finished_reason="abort"} 0\nvllm:request_success_total{engine="0",finished_reason="error"} 0\n'
            if self.cache_tokens is not None:text+=f'vllm:cache_config_info{{engine="0",kv_cache_size_tokens="{self.cache_tokens}",block_size="8",num_gpu_blocks="340",cache_dtype="auto",enable_prefix_caching="True"}} 1.0\n'
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



# Real thread coordination around synthetic API responses. No fleet connection.
class ParallelAPI(API):
    def __init__(self, capacity=2):
        super().__init__()
        import threading
        self.lock=threading.Lock();self.slots=threading.Semaphore(capacity)
        self.observed=threading.Event();self.capacity=capacity;self.active=0
        self.decode_completed=[];self.bad_tool=False;self.lose_decode=False

    def __call__(self,url,route,body=None):
        import time
        if route=='/v1/completions' and body.get('max_tokens')==256:
            self.calls.append((route,copy.deepcopy(body)))
            if self.lose_decode and body['prompt'][0]==1403:raise OSError('Lost synthetic reply')
            with self.slots:
                with self.lock:self.active+=1
                try:
                    self.observed.wait(2);time.sleep(.03)
                    data={'choices':[{'finish_reason':'length','token_ids':[760]*256}],
                          'usage':{'prompt_tokens':4096,'completion_tokens':256,'total_tokens':4352}}
                    self.decode_completed.append(body['prompt'][0])
                    return {'status':200,'body_base64':base64.b64encode(json.dumps(data).encode()).decode()}
                finally:
                    with self.lock:self.active-=1
        value=super().__call__(url,route,body)
        if route=='/metrics':
            with self.lock:active=self.active
            if active==self.capacity:self.observed.set()
            raw=base64.b64decode(value['body_base64'])+f'vllm:num_requests_running{{engine="0"}} {active}\nvllm:num_requests_waiting{{engine="0"}} 0\n'.encode()
            value['body_base64']=base64.b64encode(raw).decode()
        elif body and '8462' in json.dumps(body):
            value['body_base64']=base64.b64encode(base64.b64decode(value['body_base64']).replace(b'7319',b'8462')).decode()
        if body and body.get('tool_choice')=='auto' and self.bad_tool:
            data=json.loads(base64.b64decode(value['body_base64']))
            data['choices'][0]['message']['tool_calls'][0]['function']['arguments']='{"value":9999}'
            value['body_base64']=base64.b64encode(json.dumps(data).encode()).decode()
        return value

class ConcurrencyQualificationTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'proof';self.contract={**copy.deepcopy(CONTRACT),'concurrency':2}
        self.api=ParallelAPI()
    def verify(self):return NativeQualification(self.api,'http://127.0.0.1:8001',self.contract).verify(self.path)
    def test_two_request_probe_and_distinct_full_flows_preserve_evidence(self):
        result=self.verify();self.assertEqual(result['state'],'passed')
        self.assertIn('native_concurrency',result['checks_passed']);self.assertEqual(result['concurrency']['peak_running'],2)
        self.assertEqual([f['value'] for f in result['concurrency']['flows']],[7319,8462])
        for label,value in [('A',7319),('B',8462)]:
            body=json.loads((self.path/f'pair-{label}-tool.request.json').read_text());self.assertIn(str(value),body['messages'][0]['content'])
            response=json.loads((self.path/f'pair-{label}-tool.response.bin').read_bytes());self.assertEqual(json.loads(response['choices'][0]['message']['tool_calls'][0]['function']['arguments']),{'value':value})
            boundary=json.loads((self.path/f'pair-{label}-context-boundary.request.json').read_text());self.assertEqual(len(boundary['prompt']),16383);self.assertEqual(boundary['max_tokens'],16384)
        for case in result['cases']:
            self.assertEqual(hashlib.sha256((self.path/(case['case']+'.response.bin')).read_bytes()).hexdigest(),case['response_sha256'])
    def test_serial_server_cannot_pass_from_two_successful_serial_replies(self):
        self.api=ParallelAPI(capacity=1);self.assertEqual(self.verify()['state'],'failed')
        self.assertCountEqual(self.api.decode_completed,[1403,1404]);self.assertFalse((self.path/'pair-A-text.intent.json').exists())
    def test_actual_wrong_tool_arguments_fail_even_when_overlap_was_observed(self):
        self.api.bad_tool=True;self.assertEqual(self.verify()['state'],'failed')
        self.assertTrue((self.path/'pair-A-tool.response.bin').exists());self.assertTrue((self.path/'pair-B-tool.response.bin').exists())
    def test_lost_reply_is_not_retried_or_used_to_cancel_the_other_request(self):
        self.api.lose_decode=True;self.assertEqual(self.verify()['state'],'failed')
        self.assertEqual(self.api.decode_completed,[1404]);self.assertFalse((self.path/'concurrency-decode-A.result.json').exists())
        self.assertTrue((self.path/'concurrency-decode-B.result.json').exists())
        self.assertEqual(sum(bool(body and body.get('prompt',[None])[0]==1403) for _,body in self.api.calls),1)
    def test_expired_observation_window_still_waits_for_both_native_replies(self):
        from unittest.mock import patch
        ticks=iter([0,31])
        with patch('serving_qualification.time.monotonic',side_effect=lambda:next(ticks,31)):
            result=self.verify()
        self.assertEqual(result['state'],'failed');self.assertCountEqual(self.api.decode_completed,[1403,1404])
        self.assertTrue((self.path/'concurrency-decode-A.result.json').exists())
        self.assertTrue((self.path/'concurrency-decode-B.result.json').exists())
    def test_missing_native_gauges_prevent_probe_dispatch(self):
        self.api=API();self.assertEqual(self.verify()['state'],'failed')
        self.assertFalse(any(body is not None for _,body in self.api.calls))
    def test_only_explicit_matching_enrollment_can_qualify_a_changed_recipe(self):
        before=['model','--max-model-len','16384','--max-num-seqs','1']
        profile={'before':{'Config':{'Cmd':before}},'create':{'Cmd':before[:-1]+['2']}}
        NativeQualification(self.api,'http://127.0.0.1',self.contract).validate_profile(profile,'candidate')
        NativeQualification(self.api,'http://127.0.0.1',CONTRACT).validate_profile(profile,'previous')
        with self.assertRaisesRegex(ValueError,'changed native concurrency'):NativeQualification(self.api,'http://127.0.0.1',CONTRACT).validate_profile(profile,'candidate')
        with self.assertRaisesRegex(ValueError,'match'):NativeQualification(self.api,'http://127.0.0.1',self.contract).validate_profile(profile,'previous')
        for value in [1,3,True,'2',2.0]:
            with self.assertRaises(ValueError):NativeQualification(self.api,'http://127.0.0.1',{**CONTRACT,'concurrency':value})

class CacheCapacityTest(unittest.TestCase):
    def test_uses_explicit_capacity_instead_of_mamba_block_arithmetic(self):
        raw=b'vllm:cache_config_info{engine="0",kv_cache_size_tokens="492425",block_size="8",num_gpu_blocks="340",mamba_block_size="1600"} 1.0\n'
        value=cache_capacity(raw)
        self.assertEqual(value['kv_cache_size_tokens'],492425)
        self.assertNotEqual(value['kv_cache_size_tokens'],340*8)
        self.assertEqual(cache_capacity(raw+raw)['state'],'unavailable')
        self.assertEqual(cache_capacity(raw.replace(b'kv_cache_size_tokens="492425",',b''))['state'],'unavailable')
        self.assertEqual(cache_capacity(raw.replace(b'492425',b'None'))['state'],'unavailable')
        self.assertEqual(cache_capacity(raw.replace(b'492425',b'-1'))['state'],'unavailable')
        self.assertEqual(cache_capacity(raw.replace(b'engine="0",',b'engine="0",broken,'))['state'],'unavailable')

    def test_comparison_distinguishes_loss_equality_and_unknown(self):
        before={'state':'observed','kv_cache_size_tokens':500000}
        result=compare_cache_capacity(before,{**before,'kv_cache_size_tokens':480000})
        self.assertEqual((result['state'],result['delta_tokens'],result['delta_percent']),('decreased',-20000,-4.0))
        self.assertEqual(compare_cache_capacity(before,before)['state'],'equal')
        self.assertEqual(compare_cache_capacity(before,{'state':'unavailable'})['state'],'unavailable')

    def test_failed_inference_retains_precheck_capacity_and_does_not_invent_after(self):
        api=API();api.cache_tokens=492425;api.fail='/v1/chat/completions'
        with tempfile.TemporaryDirectory() as directory:
            result=NativeQualification(api,'http://127.0.0.1:8001',CONTRACT).verify(Path(directory)/'failed')
        self.assertEqual(result['state'],'failed')
        self.assertEqual(result['cache_capacity']['before']['kv_cache_size_tokens'],492425)
        self.assertEqual(result['cache_capacity']['after']['state'],'unavailable')

    def test_baseline_only_observes_metrics_once_and_keeps_raw_evidence(self):
        api=API();api.cache_tokens=492425
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)/'baseline'
            result=NativeQualification(api,'http://127.0.0.1:8001',CONTRACT).observe_cache(folder)
            raw=(folder/result['raw_reference']['file']).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(),result['raw_reference']['sha256'])
            self.assertEqual(result['observation'],cache_capacity(raw))
        self.assertEqual([route for route,_ in api.calls],['/metrics'])

    def test_unavailable_baseline_is_unknown_without_a_retry(self):
        api=API();api.fail='/metrics'
        with tempfile.TemporaryDirectory() as directory:
            result=NativeQualification(api,'http://127.0.0.1:8001',CONTRACT).observe_cache(Path(directory)/'baseline')
        self.assertEqual(result['observation']['state'],'unavailable')
        self.assertNotIn('raw_reference',result);self.assertEqual(len(api.calls),1)

if __name__ == '__main__': unittest.main()
