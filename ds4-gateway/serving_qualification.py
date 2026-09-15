"""Native API qualification for the enrolled Qwen/vLLM serving workflow.

Reuses the exercised selected-Spark checks. Diagnostic request parameters never
become launch settings. No mutation, approval, recovery or readmission occurs.
"""
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import struct
import time
import uuid
import zlib
from concurrent.futures import ThreadPoolExecutor
from operation_runner import save

def require(condition, message):
    if not condition:
        raise ValueError(message)


def choice(result, finish='stop'):
    rows = result.get('choices', [])
    require(len(rows) == 1 and rows[0].get('finish_reason') == finish,
            'Missing, incomplete or unexpected finish reason')
    return rows[0]['message']


def cache_usage(result):
    usage = result.get('usage', {})
    prompt = usage.get('prompt_tokens')
    cached = (usage.get('prompt_tokens_details') or {}).get('cached_tokens')
    require(type(prompt) is int and type(cached) is int and 0 <= cached <= prompt,
            'Cache token evidence missing or invalid')
    return prompt, cached


def red_image():
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 128, 128, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress((b'\x00' + b'\xff\x00\x00' * 128) * 128)) + chunk(b'IEND', b''))
    return 'data:image/png;base64,' + base64.b64encode(png).decode()


def api_checks(request, nonce, contract, value=7319):
    MODEL, CONTEXT = contract['model'], contract['context_length']
    def chat(text, **extra):
        return dict(model=MODEL, messages=[{'role': 'user', 'content': text}],
                    max_tokens=CONTEXT, temperature=1.0, top_p=.95, top_k=20,
                    min_p=0, presence_penalty=0, repetition_penalty=1,
                    chat_template_kwargs={'enable_thinking': True, 'preserve_thinking': True,
                                          'reasoning_effort': 'xhigh'}, **extra)

    models = request('models', '/v1/models')['data']
    require(any(m.get('id') == MODEL and m.get('max_model_len') == CONTEXT for m in models),
            'Advertised model or max_model_len differs')
    answer = choice(request('text', '/v1/chat/completions', chat(f'Reply with the number {value}.')))
    require(str(value) in (answer.get('content') or ''), 'Synthetic text answer failed')
    tools = [{'type': 'function', 'function': {'name': 'report_value',
              'description': 'Return the supplied integer.', 'parameters': {'type': 'object',
              'properties': {'value': {'type': 'integer'}}, 'required': ['value']}}}]
    body = chat(f'Call report_value with value {value}. Use the tool exactly once.', tools=tools, tool_choice='auto')
    message = choice(request('tool', '/v1/chat/completions', body), 'tool_calls')
    calls = message.get('tool_calls') or []
    require(len(calls) == 1 and calls[0].get('id') and calls[0]['function']['name'] == 'report_value'
            and json.loads(calls[0]['function']['arguments']) == {'value': value}, 'Tool boundary failed')
    history = chat('unused', tools=tools)
    history['messages'] = body['messages'] + [message,
        {'role': 'tool', 'tool_call_id': calls[0]['id'], 'content': f'{{"value":{value}}}'},
        {'role': 'user', 'content': 'Give the returned integer without further tool calls.'}]
    followup = choice(request('tool-followup', '/v1/chat/completions', history))
    require(str(value) in (followup.get('content') or ''), 'Tool follow-up failed')
    vision = chat([{'type': 'text', 'text': 'What single solid color fills this image? Answer with its name.'},
                   {'type': 'image_url', 'image_url': {'url': red_image()}}])
    require('red' in (choice(request('vision', '/v1/chat/completions', vision)).get('content') or '').lower(),
            'Image check failed')

    # Two interleaved conversations, preserving each actual assistant response.
    conversations = []
    for key in ['A', 'B']:
        text = f'{nonce}-{key}. Synthetic cache verification.\n' + '\n'.join(
            f'Record {i}: local inference cache verification keeps configuration unchanged.' for i in range(500))
        body = chat(text + f'\nReply with CHECK_{key}_OK.')
        result = request('cold-' + key, '/v1/chat/completions', body)
        message = choice(result)
        require(f'CHECK_{key}_OK' in (message.get('content') or ''), 'Cold conversation failed')
        prompt, cached = cache_usage(result)
        require(prompt >= 2000 and cached == 0, 'A fresh uncached prefix was not demonstrated')
        conversations.append((key, body, message, prompt, cached))
    samples = []
    for key, body, message, cold_prompt, cold_cached in conversations:
        body['messages'] += [message, {'role': 'user', 'content': f'Now reply with WARM_{key}_OK.'}]
        result = request('warm-' + key, '/v1/chat/completions', body)
        require(f'WARM_{key}_OK' in (choice(result).get('content') or ''), 'Warm conversation failed')
        prompt, cached = cache_usage(result)
        require(prompt >= cold_prompt and cached > cold_cached and cached >= 2000,
                'Substantial warm prefix reuse was not demonstrated')
        samples.append({'conversation': key, 'cold_prompt': cold_prompt, 'cold_cached': cold_cached,
                        'warm_prompt': prompt, 'warm_cached': cached})

    boundary = dict(model=MODEL, prompt=[8137, 27109, 6193] + [42] * (CONTEXT - 4),
                    max_tokens=CONTEXT, temperature=1.0, top_p=.95, top_k=20)
    result = request('context-boundary', '/v1/completions', boundary)
    usage = result.get('usage', {})
    require(usage.get('prompt_tokens') == CONTEXT - 1 and usage.get('completion_tokens') == 1
            and usage.get('total_tokens') == CONTEXT and result['choices'][0].get('finish_reason') == 'length',
            'Full-context boundary was not demonstrated')
    result = request('context-overflow', '/v1/completions',
                     dict(boundary, prompt=[42] * CONTEXT, max_tokens=1), expected=400)
    reason = result.get('error', {}).get('message', '')
    require(f'Input length ({CONTEXT})' in reason and 'no room to generate' in reason
            and f'maximum context length ({CONTEXT})' in reason, 'Unexpected context rejection reason')
    return {'cache_samples': samples, 'context_length': CONTEXT}


def eos_checks(request, contract):
    eos = contract['reasoning_eos']
    body = dict(model=contract['model'], messages=[{'role': 'user', 'content': 'Think briefly about why two plus two equals four, then answer 4.'}],
                max_tokens=16, temperature=1.0, top_p=.95, top_k=20, min_p=0, presence_penalty=0, repetition_penalty=1,
                allowed_token_ids=eos['eos_token_ids'] + [eos['ordinary_token_id']],
                chat_template_kwargs={'enable_thinking': True, 'preserve_thinking': True, 'reasoning_effort': 'xhigh'},
                stream=True, stream_options={'include_usage': True}, return_token_ids=True, include_reasoning=True)
    raw = request('reasoning-eos-guard', '/v1/chat/completions', body, raw=True)
    chunks = [json.loads(line[6:]) for line in raw.decode().splitlines() if line.startswith('data: ') and line != 'data: [DONE]']
    ids, usage = [], {}
    for chunk in chunks:
        if chunk.get('usage'): usage = chunk['usage']
        for row in chunk.get('choices', []): ids.extend(row.get('token_ids') or [])
    require(usage.get('completion_tokens') == 16 and len(ids) == 16 and set(ids) == {eos['ordinary_token_id']},
            'Reasoning EOS guard did not preserve the constrained stream')
    result = request('content-eos-restored', '/v1/completions', dict(model=contract['model'], prompt='A simple sentence:',
                     max_tokens=16, allowed_token_ids=eos['eos_token_ids'], return_token_ids=True))
    require(result['choices'][0]['finish_reason'] == 'stop' and 0 < result['usage']['completion_tokens'] <= 2,
            'EOS did not regain its normal stopping behavior outside reasoning')
    return {'constrained_tokens': len(ids), 'normal_finish': result['choices'][0]['finish_reason'],
            'scope': 'Constrained diagnostic requests only; no production output cap or exhaustive output-length proof.'}


def validate_contract(contract):
    keys={'kind', 'model', 'context_length', 'reasoning_eos'}
    require(isinstance(contract, dict) and set(contract) in (keys,keys|{'concurrency'}), 'Use the enrolled complete qualification contract')
    require('concurrency' not in contract or type(contract['concurrency']) is int and contract['concurrency']==2,
            'Only the explicit two-request native qualification is supported')
    require(contract['kind'] == 'qwen_vllm' and isinstance(contract['model'], str) and contract['model']
            and type(contract['context_length']) is int and contract['context_length'] >= 8192, 'Unsupported model qualification contract')
    eos = contract['reasoning_eos']
    require(isinstance(eos, dict) and set(eos) == {'eos_token_ids', 'ordinary_token_id'}
            and isinstance(eos['eos_token_ids'], list) and len(eos['eos_token_ids']) >= 1
            and all(type(token) is int and token >= 0 for token in eos['eos_token_ids'])
            and type(eos['ordinary_token_id']) is int and eos['ordinary_token_id'] >= 0
            and eos['ordinary_token_id'] not in eos['eos_token_ids'], 'Use the verified model token IDs for the EOS checks')


def native_load(raw):
    result={}
    for name in ['num_requests_running','num_requests_waiting']:
        prefix='vllm:'+name
        values=[float(line.rsplit(' ',1)[1]) for line in raw.decode().splitlines()
                if line.startswith(prefix+'{') or line.startswith(prefix+' ')]
        require(values and all(v>=0 and v<float('inf') and v.is_integer() for v in values),
                'Native concurrency gauges are missing or invalid')
        result[name]=int(sum(values))
    return result


def cache_capacity(raw):
    """Use the engine's explicit token capacity, not block-count arithmetic."""
    try:
        rows=[line for line in raw.decode().splitlines() if line.startswith('vllm:cache_config_info{')]
        if len(rows)!=1:
            return {'state':'unavailable','reason':'missing' if not rows else 'multiple_engine_rows'}
        match=re.fullmatch(r'vllm:cache_config_info\{(.*)\}\s+1(?:\.0+)?',rows[0])
        if not match:raise ValueError('Invalid metric')
        labels={};position=0
        for item in re.finditer(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"(?:,|$)',match[1]):
            if item.start()!=position or item[1] in labels:raise ValueError('Invalid labels')
            labels[item[1]]=json.loads('"'+item[2]+'"');position=item.end()
        if position!=len(match[1]):raise ValueError('Invalid labels')
        tokens=labels.get('kv_cache_size_tokens','')
        if not tokens.isascii() or not tokens.isdigit() or int(tokens)<=0:
            return {'state':'unavailable','reason':'no_explicit_token_capacity'}
        return {'state':'observed','kv_cache_size_tokens':int(tokens),
                'reported_settings':{key:labels[key] for key in ['engine','cache_dtype','enable_prefix_caching','gpu_memory_utilization','block_size','mamba_block_size','num_gpu_blocks'] if key in labels}}
    except (ValueError,UnicodeError):
        return {'state':'unavailable','reason':'invalid_metric'}


def compare_cache_capacity(baseline, current):
    result={'baseline':baseline,'current':current,
            'scope':'Reported KV token capacity across these observations, not cache hits, latency, quality or approval of a reduction. Startup memory availability can also affect capacity.'}
    if baseline.get('state')!='observed' or current.get('state')!='observed':
        return {**result,'state':'unavailable'}
    delta=current['kv_cache_size_tokens']-baseline['kv_cache_size_tokens']
    return {**result,'state':'decreased' if delta<0 else 'increased' if delta>0 else 'equal',
            'delta_tokens':delta,'delta_percent':100*delta/baseline['kv_cache_size_tokens']}


def concurrency_checks(request, nonce, contract):
    before=native_load(request('concurrency-idle','/metrics',raw=True))
    require(not any(before.values()),'Native work was already present before the concurrency probe')
    token=contract['reasoning_eos']['ordinary_token_id']
    def decode(label,prefix):
        body={'model':contract['model'],'prompt':[prefix]+[42]*4095,'max_tokens':256,
              'temperature':0,'allowed_token_ids':[token],'return_token_ids':True}
        result=request('concurrency-decode-'+label,'/v1/completions',body)
        require(result['usage']['completion_tokens']==256 and result['choices'][0]['finish_reason']=='length'
                and result['choices'][0].get('token_ids')==[token]*256,'Concurrent decode response failed')
        return result['usage']
    peak=0;samples=0
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(decode,'A',1403),pool.submit(decode,'B',1404)]
        end=time.monotonic()+30
        # Bound observation/storage only. Futures still finish normally even if
        # observation fails or this window expires; there is no inference timeout.
        while not all(f.done() for f in futures) and time.monotonic()<end:
            pending=all(not f.done() for f in futures)
            load=native_load(request('concurrency-load-'+str(samples),'/metrics',raw=True));samples+=1
            if pending:peak=max(peak,load['num_requests_running'])
            time.sleep(.25)
        usages=[f.result() for f in futures]
    require(peak==2,'Two simultaneous native requests were not demonstrated')
    require(not any(native_load(request('concurrency-finished','/metrics',raw=True)).values()),
            'Native work remains after the concurrency probe')
    def flow(label,value):
        def scoped(name,*args,**kwargs):return request('pair-'+label+'-'+name,*args,**kwargs)
        return {'value':value,'api':api_checks(scoped,nonce+'-'+label,contract,value),
                'eos':eos_checks(scoped,contract)}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(flow,'A',7319),pool.submit(flow,'B',8462)]
        flows=[f.result() for f in futures]
    return {'peak_running':peak,'observation_samples':samples,'decode_usage':usages,'flows':flows,
            'scope':'Measured overlapping constrained decoding, then two distinct client flows through full API/cache/context/EOS checks. Full-context requests may serialize under memory pressure. No speed ranking, exhaustive quality/output proof or guarantee that every check overlapped.'}


class NativeQualification:
    checks_supported = frozenset(['model_context', 'text', 'tools', 'vision', 'prefix_cache', 'context_boundary', 'reasoning_eos', 'fault_counters'])
    def __init__(self, transport, url, contract, *, progress=lambda *args: None):
        validate_contract(contract)
        self.transport, self.url, self.contract, self.progress = transport, url, contract, progress
        if contract.get('concurrency')==2:self.checks_supported=self.checks_supported|{'native_concurrency'}

    def validate_profile(self, profile, which):
        def flag(command, name):
            values = []
            for index, value in enumerate(command):
                if value == name:
                    require(index + 1 < len(command), 'Incomplete serving argument')
                    values.append(command[index + 1])
                elif value.startswith(name + '='): values.append(value.split('=', 1)[1])
            require(len(values) <= 1, 'Ambiguous serving argument')
            return values[0] if values else None
        before, after = profile['before']['Config']['Cmd'], profile['create']['Cmd']
        command = after if which == 'candidate' else before
        require(flag(command, '--max-model-len') == str(self.contract['context_length']),
                'Qualification context must match the exact serving recipe')
        model = flag(command, '--served-model-name')
        require(model is None or model == self.contract['model'], 'Qualification model must match the exact serving recipe')
        require(all(flag(before, name) == flag(after, name) for name in ['--host', '--port', '--served-model-name']),
                'This retained serving adapter preserves the enrolled endpoint and model identity; route changes need their own reviewed workflow')
        sequences=flag(command,'--max-num-seqs')
        if self.contract.get('concurrency')==2:
            require(sequences=='2','Enrolled concurrency must match the exact serving recipe')
        require(flag(before, '--max-num-seqs') == flag(after, '--max-num-seqs') or sequences=='1'
                or self.contract.get('concurrency')==2,
                'This qualifier does not establish changed native concurrency; an enrolled concurrency qualification is required')

    def ready(self):
        # This is only a readiness observation. It does not qualify a server.
        response = self.transport(self.url, '/v1/models')
        # Once the API answers, the actual qualification must reject a wrong
        # model/context or malformed response rather than waiting forever for it.
        return response['status'] in [200, 400, 401, 403, 404]

    def verify(self, directory):
        folder = Path(directory)
        folder.mkdir(mode=0o700, parents=True, exist_ok=False)
        nonce = str(uuid.uuid4())
        cases = []

        def artifact(name, data):
            with (folder / name).open('xb') as stream:
                os.chmod(stream.name, 0o600)
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            return {'file': name, 'sha256': hashlib.sha256(data).hexdigest()}

        def request(name, route, body=None, expected=200, raw=False):
            self.progress('qualifying_' + name.lower().replace('-', '_'), 'Checking native serving behavior: ' + name + '.')
            start = time.time()
            # Full-context inputs can be large. Keep their exact bytes as an
            # artifact, not inside the bounded operation-status receipt.
            request_artifact = artifact(name + '.request.json', json.dumps(body, separators=(',', ':')).encode()) if body is not None else None
            intent = {'case': name, 'at': start, 'route': route, 'request': request_artifact}
            save(folder, name + '.intent.json', intent)
            # No inference retry: the saved intent distinguishes a lost response.
            value = self.transport(self.url, route, body)
            data = base64.b64decode(value['body_base64'], validate=True)
            artifact(name + '.response.bin', data)
            receipt = {'case': name, 'status': value['status'], 'elapsed_s': time.time() - start,
                       'response_sha256': hashlib.sha256(data).hexdigest()}
            save(folder, name + '.result.json', receipt)
            cases.append(receipt)
            require(value['status'] == expected, name + ': unexpected HTTP status')
            return data if raw else json.loads(data)

        capacity={'before':{'state':'unavailable','reason':'not_observed'},'after':{'state':'unavailable','reason':'not_observed'}}
        try:
            raw_before=request('native-metrics-before', '/metrics', raw=True)
            capacity['before']=cache_capacity(raw_before)
            before_metrics = failure_metrics(raw_before)
            concurrent=concurrency_checks(request,nonce,self.contract) if self.contract.get('concurrency')==2 else None
            api = concurrent['flows'][0]['api'] if concurrent else api_checks(request, nonce, self.contract)
            eos = concurrent['flows'][0]['eos'] if concurrent else eos_checks(request, self.contract)
            raw_after=request('native-metrics-after', '/metrics', raw=True)
            capacity['after']=cache_capacity(raw_after)
            after_metrics = failure_metrics(raw_after)
            require(before_metrics == after_metrics, 'Native error, abort or preemption counters changed during qualification')
            result = {'state': 'passed', 'at': time.time(), 'contract': self.contract,
                      'checks_passed': sorted(self.checks_supported),
                      'cases': cases, 'api': api, 'eos': eos, 'failure_metrics_before': before_metrics, 'failure_metrics_after': after_metrics,
                      'scope': 'Native API/cache/context/tools/vision/EOS and failure-counter checks. Separate retained-identity, native-idle, runtime settings and readmission checks remain required. Concurrency is qualified only when explicitly enrolled and present in the result; not an exhaustive output-length or quality proof.'}
            if concurrent:result['concurrency']=concurrent
        except Exception:
            result = {'state': 'failed', 'at': time.time(), 'contract': self.contract, 'cases': cases,
                      'error': 'A native qualification check did not complete successfully. Inspect the saved request and response evidence; no inference was retried.'}
        result['cache_capacity']=capacity
        save(folder, 'result.json', result)
        return result

    def observe_cache(self, directory):
        folder=Path(directory);folder.mkdir(mode=0o700,parents=True,exist_ok=False)
        result={'at':time.time(),'observation':{'state':'unavailable','reason':'metrics_unavailable'}}
        try:
            response=self.transport(self.url,'/metrics')
            raw=base64.b64decode(response['body_base64'],validate=True)
            file=folder/'metrics.response.bin'
            with file.open('xb') as stream:
                os.chmod(file,0o600);stream.write(raw);stream.flush();os.fsync(stream.fileno())
            result['raw_reference']={'file':file.name,'sha256':hashlib.sha256(raw).hexdigest()}
            if response['status']==200:result['observation']=cache_capacity(raw)
        except (OSError,RuntimeError,ValueError):
            pass  # A missing measurement is explicit, not an invented capacity.
        save(folder,'result.json',result)
        return result


def failure_metrics(raw):
    values = {}
    for line in raw.decode().splitlines():
        if line.startswith('vllm:num_preemptions_total{') or (line.startswith('vllm:request_success_total{') and any('finished_reason="' + reason + '"' in line for reason in ['abort', 'error'])):
            key, value = line.rsplit(' ', 1)
            number = float(value)
            require(number >= 0 and number < float('inf'), 'Invalid native failure counter')
            values[key] = number
    require(any(k.startswith('vllm:num_preemptions_total{') for k in values)
            and all(any('finished_reason="' + reason + '"' in key for key in values) for reason in ['abort', 'error']),
            'Native failure counter evidence is incomplete')
    return values
