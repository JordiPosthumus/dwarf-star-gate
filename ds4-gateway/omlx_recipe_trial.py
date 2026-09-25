"""One pinned local MTP-depth A/B/A2 trial, invoked by the enrolled Genie tool.

Only the single integer's bytes change. The engine is reloaded only while idle
under an owned gateway hold. The original bytes are restored before readmission.
"""
import copy
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import uuid

from operation_maintenance import GatewayControl, Maintenance
from spark_recipe_trial import atomic


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def candidate_bytes(raw, model, depth):
    before = json.loads(raw)
    if set(before.get('models', {})) != {model}:
        raise ValueError('Trial requires exactly the enrolled model settings')
    settings = before['models'][model]
    if settings.get('mtp_enabled') is not True or settings.get('mtp_num_draft_tokens') != 3 or depth != 5:
        raise ValueError('Only the approved MTP depth 3 to 5 comparison is supported')
    result, count = re.subn(rb'("mtp_num_draft_tokens"\s*:\s*)3\b', rb'\g<1>5', raw)
    expected = copy.deepcopy(before)
    expected['models'][model]['mtp_num_draft_tokens'] = 5
    if count != 1 or json.loads(result) != expected:
        raise ValueError('Could not isolate the single approved setting')
    return result


def summarize_mtp(raw):
    rows=[];depths={}
    for line in raw.splitlines():
        if 'MTP[' not in line or 'finish=' not in line:continue
        match=re.search(r'depth\[([^]]+)\]',line)
        if not match:continue
        row={}
        for depth,accepted,attempted in re.findall(r'd([1-9][0-9]*)=(\d+)/(\d+)',match.group(1)):
            depth=int(depth);accepted=int(accepted);attempted=int(attempted)
            if accepted>attempted:continue
            row[str(depth)]={'accepted':accepted,'attempted':attempted}
            aggregate=depths.setdefault(str(depth),{'accepted':0,'attempted':0})
            aggregate['accepted']+=accepted;aggregate['attempted']+=attempted
        if row:rows.append(row)
    return {'requests_with_depth_logs':len(rows),'depths':depths,
            'highest_attempted_depth':max((int(k) for k,v in depths.items() if v['attempted']>0),default=None),
            'scope':'Adaptive MTP depth counts from bounded native finish logs during this phase. This shows attempted depths, not a forced depth on every token; uncoordinated direct requests remain a limitation.'}


class Executor:
    def __init__(self, folder, control):
        self.folder = Path(folder)
        self.plan = json.loads((self.folder/'plan.json').read_text())
        p = self.plan
        if (p.get('schema') != 1 or p.get('kind') != 'omlx-glm53-mtp-depth'
                or p.get('worker') != 'glm53f-m3' or p.get('candidate_depth') != 5
                or p.get('url') != 'http://127.0.0.1:8013/v1'):
            raise ValueError('Unsupported local MTP profile')
        for name in ['root', 'api_key_file']:
            if not Path(p[name]).is_absolute():
                raise ValueError('Use an enrolled absolute path')
        self.root = Path(p['root'])
        self.model = p['model']
        self.id = str(uuid.UUID(self.folder.name))
        self.control = control
        self.file = self.root/'state/model_settings.json'
        self.base = p['url'].removesuffix('/v1')
        self.key = Path(p['api_key_file']).read_text().strip()
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                      urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, route, body=None, timeout=1200):
        request = urllib.request.Request(self.base+route,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type':'application/json','Authorization':'Bearer '+self.key})
        with self.opener.open(request, timeout=timeout) as response:
            return json.load(response)

    def status(self, phase, **fields):
        self.receipt.update(state='running', phase=phase, observed_at=time.time(), **fields)
        atomic(self.folder/(self.receipt['stage']+'.status.json'), self.receipt)

    def unchanged(self, expected):
        if self.file.is_symlink():
            raise RuntimeError('Model settings must remain the enrolled regular file')
        if self.file.read_bytes() != expected:
            raise RuntimeError('Model settings changed outside this trial; preserve owner edits')
        for relative, digest in self.plan['preserved_files'].items():
            file = self.root/relative
            if file.is_symlink() or sha(file.read_bytes()) != digest:
                raise RuntimeError('A preserved launcher or global setting changed')
        revision = subprocess.check_output(['git','-C',str(self.root/'omlx-src'),'rev-parse','HEAD'], text=True).strip()
        if revision != self.plan['source_revision']:
            raise RuntimeError('Installed source revision changed')

    def native_idle(self):
        try:
            value = self.request('/api/status', timeout=10)
            return (value.get('loaded_models') == [self.model] and value.get('models_loading') == 0
                    and value.get('active_requests') == 0 and value.get('waiting_requests') == 0)
        except Exception:
            return False

    def live(self, depth):
        models = self.request('/admin/api/models', timeout=30)['models']
        if len(models) != 1 or models[0]['id'] != self.model or not models[0]['loaded']:
            raise RuntimeError('Exactly the enrolled model must be loaded')
        expected = json.loads(self.original)['models'][self.model]
        expected['mtp_num_draft_tokens'] = depth
        settings = models[0]['settings']
        if any(settings.get(key) != value for key, value in expected.items()):
            raise RuntimeError('Live model settings differ from the pinned intended settings')
        return {'loaded':True, 'settings':{key:settings[key] for key in expected},
                'scope':'Admin engine-pool settings and loaded status; reload and inference, when performed, are separate phase results. No kernel-level trace.'}

    def replace(self, expected, replacement):
        self.unchanged(expected)
        temporary = self.file.with_name('.model_settings.'+self.id+'.tmp')
        mode = self.file.stat().st_mode & 0o777
        with open(temporary,'xb',opener=lambda p,f:os.open(p,f,mode)) as stream:
            stream.write(replacement);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,self.file)

    def reload(self, depth):
        result = self.request('/admin/api/reload', {})
        if result.get('status') != 'ok':
            raise RuntimeError('Model reload was not confirmed')
        return self.live(depth)

    def chat(self, label, messages, **extra):
        body = {'model':self.model,'messages':messages,'temperature':0,'max_tokens':4096,
                'stream':True,'stream_options':{'include_usage':True},**extra}
        request = urllib.request.Request(self.base+'/v1/chat/completions',data=json.dumps(body).encode(),
            headers={'Content-Type':'application/json','Authorization':'Bearer '+self.key})
        started=time.monotonic();first=None;content='';reasoning='';calls={};usage={};finish=None
        with self.opener.open(request,timeout=1200) as response:
            for line in response:
                if not line.startswith(b'data:'):continue
                raw=line[5:].strip()
                if raw==b'[DONE]':break
                chunk=json.loads(raw)
                if chunk.get('error'):raise RuntimeError('Native stream returned an error')
                if chunk.get('usage'):usage=chunk['usage']
                for choice in chunk.get('choices',[]):
                    delta=choice.get('delta',{})
                    if first is None and any(delta.get(k) for k in ['content','reasoning_content','tool_calls']):first=time.monotonic()-started
                    content+=delta.get('content') or '';reasoning+=delta.get('reasoning_content') or ''
                    for call in delta.get('tool_calls',[]):
                        entry=calls.setdefault(call['index'],{'id':'','type':'function','function':{'name':'','arguments':''}})
                        if call.get('id'):entry['id']=call['id']
                        for key in ['name','arguments']:entry['function'][key]+=call.get('function',{}).get(key) or ''
                    if choice.get('finish_reason'):finish=choice['finish_reason']
        sample={'label':label,'elapsed_s':time.monotonic()-started,'first_token_s':first,
                'usage':usage,'finish_reason':finish,'answer':content[:2000]}
        message={'role':'assistant','content':content}
        if reasoning:message['reasoning_content']=reasoning
        if calls:message['tool_calls']=list(calls.values())
        return sample,message

    def checks(self, phase):
        log=self.root/'logs/server.log';log_start=None
        if not log.is_symlink():
            try:info=log.stat();log_start=(info.st_ino,info.st_size)
            except OSError:pass
        results=[];folder=self.folder/phase;folder.mkdir(mode=0o700)
        def save(label, value, passed):
            row={**value,'passed':bool(passed)};results.append(row);atomic(folder/(label+'.json'),row)
        for i in range(2):
            messages=[{'role':'user','content':f'Trial {self.id} {phase} {i}. Write Python merge_intervals(intervals) that sorts and merges touching intervals. Return only code, followed by the result for [(1,3),(2,4),(8,10),(10,12)].'}]
            sample,answer=self.chat('coding-'+str(i),messages)
            # Retain the code for review, never execute generated code.
            save(sample['label'],sample,sample['finish_reason']=='stop' and 'def merge_intervals' in answer['content'])
        messages=[{'role':'user','content':f'Trial {self.id} {phase}. Call trial_value with key alpha. After the tool result, return only its value.'}]
        tool={'type':'function','function':{'name':'trial_value','description':'Read a synthetic value','parameters':{'type':'object','properties':{'key':{'type':'string'}},'required':['key']}}}
        sample,answer=self.chat('tool-call',messages,tools=[tool],tool_choice={'type':'function','function':{'name':'trial_value'}})
        calls=answer.get('tool_calls',[])
        valid=len(calls)==1 and calls[0]['function']['name']=='trial_value' and json.loads(calls[0]['function']['arguments'])=={'key':'alpha'}
        save('tool-call',sample,valid)
        if valid:
            sample,answer=self.chat('tool-followup',messages+[answer,{'role':'tool','tool_call_id':calls[0]['id'],'content':'{"value":7319}'}],tools=[tool])
            save('tool-followup',sample,sample['finish_reason']=='stop' and answer['content'].strip()=='7319')
        histories={}
        for label in ['A','B']:
            prompt=f'Unique {self.id} {phase} {label}.\n'+''.join(f'Record {i}: cedar maple oak pine birch willow ash elm.\n' for i in range(500))+'Reply with 7319 only.'
            messages=[{'role':'user','content':prompt}]
            sample,answer=self.chat('cold-'+label,messages)
            cached=sample['usage'].get('prompt_tokens_details',{}).get('cached_tokens')
            save('cold-'+label,sample,sample['finish_reason']=='stop' and answer['content'].strip()=='7319' and cached==0)
            histories[label]=messages+[answer,{'role':'user','content':'Again, return only 7319.'}]
        for label in ['A','B']:
            sample,answer=self.chat('warm-'+label,histories[label])
            cached=sample['usage'].get('prompt_tokens_details',{}).get('cached_tokens')
            save('warm-'+label,sample,sample['finish_reason']=='stop' and answer['content'].strip()=='7319' and isinstance(cached,int) and cached>=2000)
        native_mtp={'state':'unavailable'}
        try:
            if log_start and not log.is_symlink():
                with log.open('rb') as stream:
                    info=os.fstat(stream.fileno())
                    if info.st_ino==log_start[0] and 0<=info.st_size-log_start[1]<=2*1024**2:
                        stream.seek(log_start[1]);native_mtp={'state':'observed',**summarize_mtp(stream.read(2*1024**2).decode('utf-8',errors='replace'))}
        except OSError:pass
        return {'state':'passed' if all(x['passed'] for x in results) else 'failed','samples':results,'native_mtp':native_mtp,
                'scope':'Synthetic coding structure, real tool exchange, and interleaved native cache reuse. Code is retained for review, not executed; no general quality or capacity-boundary claim. Request-only max_tokens=4096 is not a production setting.'}

    def prepare(self):
        self.original=self.file.read_bytes()
        if sha(self.original)!=self.plan['model_settings_sha256']:raise RuntimeError('Pinned model settings changed')
        self.candidate=candidate_bytes(self.original,self.model,5)
        self.unchanged(self.original)
        for relative in ['state/model_settings.json',*self.plan['preserved_files']]:
            target=self.folder/'backup'/relative;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            with open(target,'xb',opener=lambda p,f:os.open(p,f,0o600)) as stream:stream.write((self.root/relative).read_bytes())
        self.request('/admin/api/login',{'api_key':self.key},timeout=30)
        current=self.live(3)
        return {'state':'prepared','settings':current,'delta':{'mtp_num_draft_tokens':{'from':3,'trial':5,'restore':3}}}

    def measure(self):
        self.original=(self.folder/'backup/state/model_settings.json').read_bytes()
        self.candidate=candidate_bytes(self.original,self.model,5)
        self.unchanged(self.original)
        self.request('/admin/api/login',{'api_key':self.key},timeout=30);self.live(3)
        maintenance=Maintenance(self.folder,self.id,self.plan['worker'],control=self.control,purpose='trial',progress=lambda phase,detail:self.status(phase))
        maintenance.acquire();maintenance.wait_idle(self.native_idle)
        result={};changed=False
        try:
            self.status('measuring_original');result['A']=self.checks('A')
            maintenance.wait_idle(self.native_idle)
            self.status('loading_candidate');self.replace(self.original,self.candidate);changed=True
            result['candidate_live']=self.reload(5)
            self.status('measuring_candidate');result['B']=self.checks('B')
        except Exception as error:
            result['error']=str(error)
        finally:
            if changed:
                # A failed reload may have no loaded engine, so native status
                # must prove no active/loading work without requiring loaded=true.
                self.status('restoring_original')
                status=self.request('/api/status',timeout=30)
                if any(status.get(k)!=0 for k in ['active_requests','waiting_requests','models_loading']):
                    raise RuntimeError('Native work prevents safe restoration; owned hold retained')
                self.replace(self.candidate,self.original)
                result['restored_live']=self.reload(3)
            self.unchanged(self.original)
            maintenance.wait_idle(self.native_idle)
            self.status('verifying_restoration');result['A2']=self.checks('A2')
            atomic(self.folder/'run.result.json',result)
            if result['A2']['state']!='passed':raise RuntimeError('Original restored but its checks need review; hold retained')
            maintenance.wait_idle(self.native_idle);maintenance.release()
            result['readmission']=maintenance.resume_if_unchanged()
        return {'state':'complete','result':result,'restoration':{'state':'verified','original_bytes':True}}

    def execute(self,stage):
        self.receipt=json.loads((self.folder/(stage+'.status.json')).read_text())
        try:self.receipt.update(self.prepare() if stage=='prepare' else self.measure())
        except Exception as error:self.receipt.update(state='failed' if stage=='prepare' else 'restoration_required',error=str(error))
        self.receipt['finished_at']=time.time();atomic(self.folder/(stage+'.status.json'),self.receipt)
        return self.receipt


if __name__=='__main__':
    stage,folder,socket=sys.argv[1:]
    if stage not in ('prepare','run'):raise SystemExit('Invalid stage')
    result=Executor(folder,GatewayControl(socket)).execute(stage)
    print(json.dumps({'state':result['state']}),flush=True)
