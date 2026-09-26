"""Fixed remote half of a privately enrolled Spark pair recipe trial.

Runs on the head. Plan is operator-enrolled; no values come from chat. Original
checkout, weight cache, kernel caches and image tags are never overwritten.
"""
import base64
import concurrent.futures
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import errno
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


def write(file,value):
    temp=file.with_suffix('.tmp')
    with open(temp,'w',opener=lambda p,f:os.open(p,f,0o600)) as stream:
        json.dump(value,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    temp.replace(file)


def sha(file):return hashlib.sha256(file.read_bytes()).hexdigest()
def envmap(container):return dict(item.split('=',1) for item in container['Config']['Env'] if '=' in item)


def recipe_manifest(root):
    result={};total=0
    for file in sorted(root.rglob('*')):
        if file.is_symlink():raise RuntimeError('Published recipe contains a symlink; inspect before upgrading')
        if not file.is_file():continue
        data=file.read_bytes();total+=len(data)
        if total>512*1024**2:raise RuntimeError('Published recipe snapshot exceeds its bounded source allowance')
        result[file.relative_to(root).as_posix()]=hashlib.sha256(data).hexdigest()
    return result


def baseline_cache_settings(original):
    """Freeze the current serving knobs; vary only checkpoint/draft retention."""
    required={'MAX_MODEL_LEN':'400000','MAX_NUM_SEQS':'2','MAX_NUM_BATCHED_TOKENS':'7168',
              'GPU_MEM_UTIL':'0.85','GLM53_DENSE_FP8':'off','GLM53_KDA_BF16_LARGE_M':'0',
              'GLM53_EXL3_MOE_FAST':'0','DFLASH_TOKENS':'7'}
    if any(original.get(key)!=value for key,value in required.items()):
        raise ValueError('Capacity-preserving cache trial requires the pinned original settings')
    keys={'TP','NNODES','QUANTIZATION','ENFORCE_EAGER','MAX_MODEL_LEN','MAX_NUM_SEQS',
          'MAX_NUM_BATCHED_TOKENS','LONG_PREFILL_TOKEN_THRESHOLD','GPU_MEM_UTIL','KV_CACHE_DTYPE',
          'LANGUAGE_MODEL_ONLY','SKIP_MM_PROFILING','LIMIT_MM','MM_IMAGE_TOKENS','VIDEO_NUM_FRAMES',
          'MM_PROCESSOR_CACHE_GB','DFLASH_TOKENS','DFLASH_DRAFT_TP','MTP_TOKENS',
          'DEFAULT_MAX_NEW_TOKENS','LOAD_FORMAT','SPEC_METHOD'}
    values={key:value for key,value in original.items() if key in keys or key.startswith(('GLM53_','EXL3_'))}
    # The precision, capacity, scheduler and decoder settings above stay frozen.
    values.update(GLM53_DRAFT_KV_COMPACT='1',GLM53_APC_RETENTION_INTERVAL='14336',
                  GLM53_APC_RETENTION_INTERVAL_SWA='0')
    return values


def isolated_rank_launcher(text, destination):
    """Move candidate host-side staging only; preserve container paths/flags."""
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+',destination) or '..' in Path(destination).parts:
        raise ValueError('Use the enrolled isolated staging path')
    lines=[];count=0
    for line in text.splitlines(keepends=True):
        if not line.lstrip().startswith('#') and '/tmp/' in line:
            valid=len(re.findall(r'/tmp/(?=\$\{CONTAINER_WORKER\}|glm53|patch_)',line))
            if valid!=line.count('/tmp/'):
                raise ValueError('Unexpected upstream temporary path; inspect before launching')
            count+=valid;line=line.replace('/tmp/',destination.rstrip('/')+'/')
        lines.append(line)
    if count<20:raise ValueError('Expected candidate worker staging paths were not found')
    return ''.join(lines),count


class Remote:
    def __init__(self,plan):
        self.plan=plan;self.root=Path(plan['trial_root']);self.recipe=Path(plan['recipe_root'])
        self.candidate=self.root/'candidate';self.backup=self.root/'baseline'
        self.tag=('dsg-glm53-rollout:' if plan.get('kind')=='glm53-spark-pair-rollout' else 'dsg-glm53-trial:')+plan['trial_id'];self.original_tag='dsg-glm53-original:'+plan['trial_id']
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs):return None
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def command(self,args,*,input=None,timeout=7200,log=None,env=None,guard_build=False):
        if log:
            with open(self.root/log,'ab') as out:
                if guard_build:
                    process=subprocess.Popen(args,stdout=out,stderr=subprocess.STDOUT,env=env);deadline=time.monotonic()+timeout
                    while process.poll() is None:
                        memory=dict((key.rstrip(':'),int(value)*1024) for key,value,*_ in (line.split() for line in Path('/proc/meminfo').read_text().splitlines()))
                        reason='Build time budget exceeded' if time.monotonic()>deadline else 'Build stopped to preserve host headroom' if memory['MemAvailable']<2*1024**3 or shutil.disk_usage(self.root).free<12*1024**3 else None
                        if reason:
                            process.terminate()
                            try:process.wait(timeout=30)
                            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=10)
                            raise RuntimeError(reason+'; original serving was not stopped')
                        time.sleep(1)
                    code=process.returncode
                else:code=subprocess.run(args,input=input,stdout=out,stderr=subprocess.STDOUT,timeout=timeout,env=env).returncode
            if code:raise RuntimeError('Command failed; preserved log: '+log)
            return b''
        result=subprocess.run(args,input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,env=env)
        if result.returncode:
            with open(self.root/'commands.stderr','ab') as out:out.write(result.stderr[-16000:])
            raise RuntimeError('Command failed; private diagnostics retained')
        return result.stdout
    def rank(self,args,**kw):return self.command(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15',self.plan['rank_ssh'],shlex.join(args)],**kw)
    def inspect(self,rank=False):
        call=self.rank if rank else self.command
        return json.loads(call(['docker','inspect','glm53-exl3-worker' if rank else 'glm53-exl3-head'],timeout=30))[0]
    def images(self,tag,rank=False):
        return json.loads((self.rank if rank else self.command)(['docker','image','inspect',tag],timeout=30))[0]
    def baseline_unchanged(self):
        p=self.plan
        if p.get('baseline_kind')=='published-rollout':
            receipt=self.recipe.parent/'deploy-result.json'
            if sha(receipt)!=p['baseline_deployment_sha256']:raise RuntimeError('Pinned previous deployment receipt changed')
            deployed=json.loads(receipt.read_text());prepared=json.loads((self.recipe.parent/'prepared.json').read_text())
            if (deployed.get('state')!='deployed' or deployed.get('recipe_root')!=str(self.recipe)
                    or deployed.get('candidate_image')!=p['baseline_image'] or prepared.get('source_revision')!=p['baseline_revision']):
                raise RuntimeError('Published recipe does not match the enrolled baseline')
            manifest=self.backup/'recipe-manifest.json'
            if manifest.exists() and recipe_manifest(self.recipe)!=json.loads(manifest.read_text()):
                raise RuntimeError('Published baseline source changed; preserve owner edits')
        else:
            revision=self.command(['git','-C',str(self.recipe),'rev-parse','HEAD']).decode().strip()
            if revision!=p['baseline_revision'] or self.command(['git','-C',str(self.recipe),'status','--porcelain','--untracked-files=no']).strip():
                raise RuntimeError('Original tracked recipe changed; leave owner changes untouched')
        if sha(self.recipe/'.env')!=p['baseline_env_sha256'] or sha(self.recipe/'start.sh')!=p['baseline_start_sha256']:
            raise RuntimeError('Original recipe bytes changed; leave owner changes untouched')
        peers=re.findall(r'^WORKER_SSH=(.*)$',(self.recipe/'.env').read_text(),re.M)
        if len(peers)!=1 or shlex.split(peers[0])!=[p['rank_ssh']]:raise RuntimeError('Rank SSH binding does not match the pinned original recipe')
    def headers(self):
        key=envmap(self.inspect()).get('VLLM_API_KEY','')
        return {'Content-Type':'application/json',**({'Authorization':'Bearer '+key} if key else {})}
    def request(self,path,body=None,timeout=2400):
        request=urllib.request.Request('http://127.0.0.1:8888'+path,headers=self.headers(),data=None if body is None else json.dumps(body).encode())
        with self.opener.open(request,timeout=timeout) as response:return response.read()
    def idle(self):
        try:
            metrics=self.request('/metrics',timeout=10).decode()
            values={}
            for name in ['num_requests_running','num_requests_waiting']:
                lines=re.findall(r'^vllm:'+name+r'(?:\{[^\n]*\})?\s+([0-9.eE+-]+)\s*$',metrics,re.M)
                if not lines:return False
                values[name]=sum(float(x) for x in lines)
            return all(x==0 for x in values.values())
        except Exception:return False
    def wait_idle(self,timeout=3600):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            if self.idle():
                time.sleep(3)
                if self.idle():return
            time.sleep(2)
        raise RuntimeError('Native work did not become verifiably idle; no stop was issued')
    def prepare(self):
        self.baseline_unchanged()
        head,rank=self.inspect(),self.inspect(True)
        if any(x['Image']!=self.plan['baseline_image'] or not x['State']['Running'] for x in [head,rank]):
            raise RuntimeError('The running original pair differs from the approved baseline')
        # Building isolated overlay layers needs scratch space but never prunes.
        if shutil.disk_usage(self.root).free<50*1024**3:raise RuntimeError('Less than 50 GiB free; preserve existing images and stop preparation')
        worker_free=int(self.rank(['python3','-c','import shutil; print(shutil.disk_usage("/home").free)']).strip())
        if worker_free<40*1024**3:raise RuntimeError('Worker has less than 40 GiB free; preserve existing images')
        self.backup.mkdir(mode=0o700)
        write(self.backup/'head.json',head);write(self.backup/'rank.json',rank)
        shutil.copy2(self.recipe/'.env',self.backup/'.env');os.chmod(self.backup/'.env',0o600)
        if self.plan.get('baseline_kind')=='published-rollout':
            write(self.backup/'recipe-manifest.json',recipe_manifest(self.recipe))
            self.command(['tar','-cf',str(self.backup/'tracked-recipe.tar'),'-C',str(self.recipe),'.'])
            shutil.copy2(self.recipe.parent/'deploy-result.json',self.backup/'previous-deployment.json')
        else:self.command(['git','-C',str(self.recipe),'archive','--output='+str(self.backup/'tracked-recipe.tar'),'HEAD'])
        for source in [self.recipe/'.glm53-exl3-head.inner.sh']:
            if source.is_file():shutil.copy2(source,self.backup/source.name)
        worker_paths=[m['Source'] for m in rank['Mounts'] if m['Type']=='bind' and m['Destination']=='/start.sh']
        if len(worker_paths)!=1:raise RuntimeError('Expected exactly one original rank launcher bind')
        write(self.backup/'worker-launcher-path.json',worker_paths[0])
        worker_script=self.rank(['cat',worker_paths[0]])
        (self.backup/'worker-inner.sh').write_bytes(worker_script);os.chmod(self.backup/'worker-inner.sh',0o600)
        self.command(['docker','tag',head['Image'],self.original_tag]);self.rank(['docker','tag',rank['Image'],self.original_tag])
        original=envmap(head);profile=self.candidate/'examples/tp2-long-coding.env'
        # Keep all existing extra flags; this profile's assignment would erase them.
        variant=self.plan.get('candidate_profile','long-coding')
        if variant=='baseline-cache-400k':
            overrides='\n'.join(key+'='+shlex.quote(value) for key,value in baseline_cache_settings(original).items())
        elif variant=='long-coding':
            overrides='\n'.join(line for line in profile.read_text().splitlines() if not line.startswith('EXTRA_ARGS='))
        else:raise ValueError('Unsupported candidate profile')
        extras=original.get('EXTRA_ARGS','')
        if '--enable-prompt-tokens-details' not in extras:extras+=' --enable-prompt-tokens-details'
        candidate_env=(self.backup/'.env').read_text()+'\n'+overrides+'\n'+ '\n'.join([
            'IMAGE='+shlex.quote(self.tag),'EXTRA_ARGS='+shlex.quote(extras.strip()),
            'CACHE_ROOT='+shlex.quote(str(self.root/'head-cache')),
            'WORKER_VLLM_CACHE='+shlex.quote(self.plan['remote_root']+'/'+self.plan['trial_id']+'/rank-cache'),
        ])+'\n'
        if self.plan.get('kind')=='glm53-spark-pair-rollout':
            # Future normal starts use the same already-qualified image. These
            # match launch()'s transport controls, not diagnostic model limits.
            candidate_env+='SKIP_PULL=1\nSKIP_BUILD=1\nSKIP_DOWNLOAD=1\nSKIP_SYNC=1\nSKIP_SHIP=1\n'
        (self.candidate/'.env').write_text(candidate_env);os.chmod(self.candidate/'.env',0o600)
        # Bound compilation parallelism in the isolated build only; no serving
        # setting is changed. Preserve the upstream Dockerfile and record delta.
        dockerfile=self.candidate/'Dockerfile'
        original_dockerfile=dockerfile.read_text()
        compile_assignment='TORCH_CUDA_ARCH_LIST=12.1a MAX_JOBS=8'
        if original_dockerfile.count(compile_assignment)!=1:raise RuntimeError('Unexpected upstream build parallelism; inspect before building')
        (self.root/'upstream-Dockerfile').write_text(original_dockerfile)
        dockerfile.write_text(original_dockerfile.replace(compile_assignment,'TORCH_CUDA_ARCH_LIST=12.1a MAX_JOBS=1'))
        files=[dockerfile]
        for folder in ['overlay','files','tests','ablit']:
            for file in (self.candidate/folder).rglob('*'):
                relative=file.relative_to(self.candidate).as_posix()
                if file.is_file() and '__pycache__' not in file.parts and '.pytest_cache' not in file.parts and not relative.startswith(('ablit/transplant/','files/nfs-server/')) and relative!='files/nfs-share.sh' and file.suffix!='.pyc':files.append(file)
        stamp=hashlib.sha256(''.join(sha(f)+'  '+str(f)+'\n' for f in sorted(files)).encode()).hexdigest()
        if self.plan.get('kind')=='glm53-spark-pair-rollout':
            image=self.images(self.plan['qualified_image'])
            if image['Id']!=self.plan['qualified_image']:raise RuntimeError('Transferred image differs from the qualified image')
            self.command(['docker','tag',image['Id'],self.tag])
        else:
            self.command(['docker','build','--build-arg','GLM53_RECIPE_STAMP='+stamp,'-t',self.tag,str(self.candidate)],log='candidate-build.log',guard_build=True)
        image=self.images(self.tag)
        if image['Architecture']!='arm64':raise RuntimeError('Candidate architecture mismatch')
        # Pipe immutable candidate layers to rank 1; no original tags are changed.
        with open(self.root/'candidate-ship.log','ab') as log:
            sender=subprocess.Popen(['docker','save','--platform','linux/arm64',self.tag],stdout=subprocess.PIPE,stderr=log)
            receiver=subprocess.Popen(['ssh','-o','BatchMode=yes',self.plan['rank_ssh'],'docker load'],stdin=sender.stdout,stdout=log,stderr=log)
            sender.stdout.close();received=receiver.wait(timeout=7200);sent=sender.wait(timeout=60)
        if sent or received:raise RuntimeError('Candidate image transfer did not complete')
        other=self.images(self.tag,True)
        if image['RootFS']['Layers']!=other['RootFS']['Layers']:raise RuntimeError('Candidate image layers differ across ranks')
        self.baseline_unchanged()
        if self.inspect()['Id']!=head['Id'] or self.inspect(True)['Id']!=rank['Id']:raise RuntimeError('Serving identity changed during preparation')
        result={'state':'prepared','source_revision':self.plan['source_revision'],'candidate_image':image['Id'],'rank_candidate_image':other['Id'],'recipe_stamp':stamp,'build_only_delta':{'MAX_JOBS':{'from':8,'to':1},'scope':'Isolated CUDA compilation concurrency only; no runtime flags changed.'},'candidate_env_sha256':sha(self.candidate/'.env'),'original_image':head['Image'],'original_container':head['Id'],'original_rank_container':rank['Id'],'scope':'Original recipe and both images backed up. Candidate built and shipped separately; no model stopped, settings changed or weights/cache removed.'}
        if self.plan.get('kind')=='glm53-spark-pair-rollout':
            result.update(reused_qualified_image=True,recipe_stamp=image.get('Config',{}).get('Labels',{}).get('glm53.recipe.stamp'),scope='Original recipe and both containers/images backed up. The exact qualified image was copied without rebuilding; serving remains unchanged.')
            result.pop('build_only_delta',None)
        write(self.root/'prepared.json',result);return result
    def metrics(self):
        raw=self.request('/metrics',timeout=15).decode();values={}
        for name in ['prefix_cache_queries_total','prefix_cache_hits_total','request_success_total','num_requests_running','num_requests_waiting']:
            lines=re.findall(r'^vllm:'+name+r'(?:\{[^\n]*\})?\s+([0-9.eE+-]+)\s*$',raw,re.M)
            values[name]=sum(float(x) for x in lines) if lines else None
        return values
    def chat(self,messages,*,max_tokens=4096,**extra):
        before=self.metrics();started=time.monotonic();first=None;content='';reasoning='';calls={};usage={};finish=None
        body={'model':'GLM-5.3-Flash-EXL3','messages':messages,'max_tokens':max_tokens,'temperature':0,'stream':True,'stream_options':{'include_usage':True},**extra}
        request=urllib.request.Request('http://127.0.0.1:8888/v1/chat/completions',data=json.dumps(body).encode(),headers=self.headers())
        with self.opener.open(request,timeout=2400) as response:
            for line in response:
                if not line.startswith(b'data:'):continue
                text=line[5:].strip()
                if text==b'[DONE]':break
                chunk=json.loads(text)
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
        elapsed=time.monotonic()-started;after=self.metrics()
        sample={'elapsed_s':elapsed,'first_token_s':first,'finish_reason':finish,'usage':usage,'answer':content[:2000],'reasoning_tokens_reported':usage.get('completion_tokens_details',{}).get('reasoning_tokens'),'metrics_before':before,'metrics_after':after}
        cached=usage.get('prompt_tokens_details',{}).get('cached_tokens')
        if isinstance(cached,int):sample.update(cached_tokens=cached,cache_evidence='native response usage')
        elif all(before.get(k) is not None and after.get(k) is not None for k in ['request_success_total','prefix_cache_hits_total']) and after['request_success_total']-before['request_success_total']==1 and all(before.get(k)==after.get(k)==0 for k in ['num_requests_running','num_requests_waiting']):
            sample.update(cached_tokens=after['prefix_cache_hits_total']-before['prefix_cache_hits_total'],cache_evidence='Native aggregate hit-token delta with exactly one completed request and idle before/after, within the owned gateway hold; uncoordinated direct traffic remains a limitation.')
        else:sample.update(cached_tokens=None,cache_evidence='unavailable or concurrent native traffic; no reuse claim')
        message={'role':'assistant','content':content}
        if reasoning:message['reasoning_content']=reasoning
        if calls:message['tool_calls']=list(calls.values())
        return sample,message
    def tokens(self,messages):
        value=json.loads(self.request('/tokenize',{'model':'GLM-5.3-Flash-EXL3','messages':messages,'add_generation_prompt':True},timeout=90))
        count=value.get('count')
        if not isinstance(count,int):raise RuntimeError('Native tokenizer did not report a token count')
        return count
    def prompt(self,target,nonce):
        # Calibrate with this installed tokenizer, never character-count tokens.
        head='Synthetic verification '+nonce+'. The stored verification value is 7319.\n'
        line='Record: cedar maple oak pine birch willow ash elm.\n'
        tail='\nReply with the stored verification value from the beginning of these records only.'
        def messages(n):return [{'role':'user','content':head+line*n+tail}]
        unit=self.tokens(messages(100))-self.tokens(messages(0));n=max(1,(target-self.tokens(messages(0)))*100//unit)
        value=messages(n);count=self.tokens(value)
        while count>target:
            n-=max(1,(count-target)*100//unit);value=messages(n);count=self.tokens(value)
        # A small repeated suffix is tokenized again to prove the final count.
        while count<target-4:
            value[0]['content']+=' x'*(target-count-2);count=self.tokens(value)
            if count>target:raise RuntimeError('Tokenizer calibration overshot; no long inference was sent')
        return value,count
    def checks(self,phase,context_limit):
        folder=self.root/phase;folder.mkdir(mode=0o700);results=[]
        def save(label,callback):
            try:
                value=callback();row={'label':label,'state':'measured',**value}
            except Exception as error:row={'label':label,'state':'failed','error':str(error)}
            results.append(row);write(folder/'results.json',results);return row
        def simple():
            sample,message=self.chat([{'role':'user','content':'Compute 137 * 23. Reply with the decimal integer only.'}])
            return {'sample':sample,'passed':message['content'].strip()=='3151' and sample['finish_reason']=='stop'}
        save('arithmetic',simple)
        def toolcheck():
            tools=[{'type':'function','function':{'name':'report_value','description':'Return the supplied integer.','parameters':{'type':'object','properties':{'value':{'type':'integer'}},'required':['value'],'additionalProperties':False}}}]
            messages=[{'role':'user','content':'Call report_value exactly once with integer value 7319.'}]
            sample,message=self.chat(messages,tools=tools,tool_choice='auto');calls=message.get('tool_calls',[])
            passed=len(calls)==1 and calls[0]['function']['name']=='report_value' and json.loads(calls[0]['function']['arguments'])=={'value':7319} and sample['finish_reason']=='tool_calls'
            if not passed:return {'samples':[sample],'passed':False}
            follow,answer=self.chat(messages+[message,{'role':'tool','tool_call_id':calls[0]['id'],'content':'{"value":7319}'},{'role':'user','content':'Reply with the returned integer, no further tool call.'}],tools=tools,tool_choice='auto')
            return {'samples':[sample,follow],'passed':follow['finish_reason']=='stop' and '7319' in answer['content']}
        save('tool_call_and_followup',toolcheck)
        histories={}
        for key in ['A','B']:
            messages,count=self.prompt(131072,str(uuid.uuid4())+'-'+key)
            def cold(messages=messages,count=count,key=key):
                sample,answer=self.chat(messages);histories[key]=(messages,answer)
                return {'input_tokens_measured':count,'sample':sample,'passed':sample['finish_reason']=='stop' and '7319' in answer['content'],'cold_cache_proved':sample.get('cached_tokens')==0}
            save('cold-'+key,cold)
        for key in ['A','B']:
            if key not in histories:continue
            messages,answer=histories[key]
            def warm(messages=messages,answer=answer):
                sample,reply=self.chat(messages+[answer,{'role':'user','content':'Repeat the verification value only.'}])
                return {'sample':sample,'passed':sample['finish_reason']=='stop' and '7319' in reply['content'],'substantial_reuse_proved':sample.get('cached_tokens') is not None and sample['cached_tokens']>=100000}
            save('append-'+key,warm)
        if 'A' in histories:
            original=histories['A'][0][0]['content'];at=int(len(original)*0.9)
            for label,content in [('edit-90-percent',original[:at]+' Revised record.'+original[at:]),('branch-90-percent',original[:at]+'\nNew branch: verification value is 7319. Reply with the value only.')]:
                def branch(content=content):
                    sample,reply=self.chat([{'role':'user','content':content}]);return {'sample':sample,'passed':sample['finish_reason']=='stop' and '7319' in reply['content']}
                save(label,branch)
        def boundary():
            messages,count=self.prompt(context_limit-65,str(uuid.uuid4())+'-boundary')
            sample,reply=self.chat(messages,max_tokens=64)
            return {'sample':sample,'requested_output_budget':64,'input_tokens_measured':count,'requested_total':count+64,'configured_context':context_limit,'accepted':sample['usage'].get('prompt_tokens')==count,'scope':'Near-limit input acceptance only. A 64-token diagnostic output budget does not test long output quality or change the production output setting.'}
        save('context-boundary',boundary)
        def concurrency_check():
            messages,_=self.prompt(8192,str(uuid.uuid4())+'-concurrency');peak=0
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures=[pool.submit(self.chat,[{'role':'user','content':messages[0]['content']+'\nExplain why the verification value is consistent; give five sentences.'}],max_tokens=512) for _ in range(2)]
                while not all(f.done() for f in futures):
                    metric=self.metrics().get('num_requests_running');peak=max(peak,metric or 0);time.sleep(.2)
                samples=[future.result()[0] for future in futures]
            return {'samples':samples,'peak_native_running':peak,'two_active_requests_observed':peak>=2,'scope':'Two simultaneous diagnostic requests; not a maximum-throughput benchmark.'}
        save('concurrency-two',concurrency_check)
        return results
    def launch(self,recipe,tag,phase):
        environment={**os.environ,'SKIP_PULL':'1','SKIP_BUILD':'1','SKIP_DOWNLOAD':'1','SKIP_SYNC':'1','SKIP_SHIP':'1','IMAGE':tag,'READY_TIMEOUT':'1800'}
        self.command(['bash',str(recipe/'start.sh')],env=environment,log=phase+'-start.log',timeout=2400)
    def stop(self,recipe,phase):
        self.wait_idle()
        self.command(['bash',str(recipe/'start.sh'),'stop'],log=phase+'-stop.log',timeout=120)
    def rank_staging_snapshot(self):
        """Private bytes/hash proof for original launcher and code bind files."""
        original=json.loads((self.backup/'rank.json').read_text())
        paths=sorted({m['Source'] for m in original['Mounts'] if m['Type']=='bind' and
                      (m.get('Source','').startswith('/tmp/') or m.get('Destination')=='/start.sh' or
                       m.get('Destination','').startswith('/opt/glm53/'))})
        script="""import base64,hashlib,json,os,stat,sys
from pathlib import Path
result={};total=0
for source in json.loads(sys.argv[1]):
 p=Path(source)
 if p.is_symlink():raise RuntimeError('Unrecognized symlink staging source')
 files=sorted(p.rglob('*')) if p.is_dir() else [p]
 for file in files:
  if file.is_symlink():raise RuntimeError('Unrecognized symlink staging content')
  if file.is_dir():continue
  if not file.is_file():raise RuntimeError('Staging source is not a regular file')
  data=file.read_bytes();total+=len(data)
  if total>32*1024**2:raise RuntimeError('Staging backup exceeds 32MiB; inspect before changes')
  result[str(file)]={'sha256':hashlib.sha256(data).hexdigest(),'mode':stat.S_IMODE(file.stat().st_mode),'bytes_b64':base64.b64encode(data).decode()}
print(json.dumps(result))
"""
        return json.loads(self.rank(['python3','-c',script,json.dumps(paths)],timeout=60))
    def isolate_candidate_staging(self,prepared):
        if sha(self.candidate/'.env')!=prepared['candidate_env_sha256']:
            raise RuntimeError('Prepared candidate environment changed before trial')
        file=self.candidate/'start.sh';original=file.read_text()
        if sha(file)!=self.plan['source_start_sha256']:
            raise RuntimeError('Candidate launcher differs from the pinned source archive')
        staging=self.plan['remote_root']+'/'+self.plan['trial_id']+'/rank-launch'
        changed,count=isolated_rank_launcher(original,staging)
        # Do this before stopping anything. The upstream Docker build does not
        # include start.sh; only its external transport paths change here.
        (self.root/'upstream-start.sh').write_text(original)
        file.write_text(changed)
        self.rank(['mkdir','-m','700','-p',staging])
        snapshot=self.rank_staging_snapshot();write(self.backup/'rank-staging-files.json',snapshot)
        write(self.root/'staging-isolation.json',{'original_launcher_sha256':hashlib.sha256(original.encode()).hexdigest(),'isolated_launcher_sha256':sha(file),'rewritten_host_path_occurrences':count,'original_rank_files':len(snapshot),'scope':'Only candidate worker staging paths moved out of shared /tmp; model flags and container-side paths unchanged.'})
    def suspend_original(self,prepared):
        # Keep the exact containers, writable layers, mounts and original image.
        # The candidate takes their conventional names only while under our hold.
        self.wait_idle()
        for rank,name,key in [(False,'glm53-exl3-head','original_container'),(True,'glm53-exl3-worker','original_rank_container')]:
            call=self.rank if rank else self.command
            current=self.inspect(rank)
            if current['Id']!=prepared[key]:raise RuntimeError('Original identity changed before suspension')
            call(['docker','stop','--time','60',current['Id']],timeout=90)
            preserved=('dsg-preserved-'+name if self.plan.get('kind')=='glm53-spark-pair-rollout' else name)+'-original-'+self.plan['trial_id']
            call(['docker','rename',current['Id'],preserved])
    def restore(self,prepared):
        self.baseline_unchanged()
        before=json.loads((self.backup/'head.json').read_text());before_rank=json.loads((self.backup/'rank.json').read_text())
        # Do not stop someone else's process; candidate IDs/images must match.
        for rank,original,name,image_key in [(False,before,'glm53-exl3-head','candidate_image'),(True,before_rank,'glm53-exl3-worker','rank_candidate_image')]:
            call=self.rank if rank else self.command
            try:current=self.inspect(rank)
            except Exception:current=None
            if current and current['Id']!=original['Id']:
                if current['Image']!=prepared[image_key]:raise RuntimeError('Another model/image now owns a container name; no further changes issued')
                if current['State']['Running']:
                    if not rank:
                        # A failed owned startup can have no API at all. Only an
                        # explicit local refusal permits cleanup without metrics.
                        try:
                            connection=socket.create_connection(('127.0.0.1',8888),timeout=3);connection.close();refused=False
                        except OSError as error:refused=error.errno==errno.ECONNREFUSED
                        if not refused:self.wait_idle()
                    call(['docker','stop','--time','60',current['Id']],timeout=90)
                call(['docker','rename',current['Id'],name+'-candidate-'+self.plan['trial_id']])
            # Exact IDs survive stop/rename; never recreate the old configuration.
            saved=json.loads(call(['docker','inspect',original['Id']]))[0]
            if saved['Image']!=original['Image']:raise RuntimeError('Preserved original container identity differs')
            if saved['Name']!='/'+name:call(['docker','rename',original['Id'],name])
        saved_head=self.backup/'.glm53-exl3-head.inner.sh'
        if saved_head.is_file():
            current_head=self.recipe/'.glm53-exl3-head.inner.sh'
            if current_head.is_symlink() or current_head.read_bytes()!=saved_head.read_bytes():
                raise RuntimeError('Original head launcher changed; preserve owner edits')
        current_script=self.rank(['cat',self.original_rank_launcher()])
        if current_script!=(self.backup/'worker-inner.sh').read_bytes():raise RuntimeError('Original rank launcher changed; preserve owner edits')
        snapshot_file=self.backup/'rank-staging-files.json'
        if snapshot_file.is_file() and self.rank_staging_snapshot()!=json.loads(snapshot_file.read_text()):
            raise RuntimeError('Original rank staging files changed; preserve them and keep the hold')
        self.rank(['docker','start',before_rank['Id']]);self.command(['docker','start',before['Id']])
        self.wait_idle(timeout=2400)
        head,rank=self.inspect(),self.inspect(True)
        for name,original,restored in [('head',before,head),('rank',before_rank,rank)]:
            if original['Id']!=restored['Id'] or original['Image']!=restored['Image']:raise RuntimeError('Exact original container was not restored')
            old,new=envmap(original),envmap(restored)
            changed={key for key in old.keys()|new.keys() if old.get(key)!=new.get(key)}
            if changed:raise RuntimeError('Original '+name+' environment differs: '+','.join(sorted(changed)))
            old_mounts={m['Destination']:(m['Type'],m.get('Source'),m['RW']) for m in original['Mounts']}
            new_mounts={m['Destination']:(m['Type'],m.get('Source'),m['RW']) for m in restored['Mounts']}
            if old_mounts!=new_mounts:raise RuntimeError('Original '+name+' mounts differ; keep the hold for inspection')
        self.baseline_unchanged()
        return {'state':'verified','head_image':head['Image'],'rank_image':rank['Image'],'head_container':head['Id'],'rank_container':rank['Id'],'environment_and_mounts_match':True,'original_env_sha256':sha(self.recipe/'.env'),'scope':'Exact original containers, writable layers, images, environment, mounts and recipe bytes restored. Native qualification is recorded separately.'}
    def original_rank_launcher(self):
        file=self.backup/'worker-launcher-path.json'
        return json.loads(file.read_text()) if file.exists() else '/tmp/glm53-exl3-worker.sh'

    def run(self):
        prepared=json.loads((self.root/'prepared.json').read_text());self.baseline_unchanged()
        if (self.root/'run-intent.json').exists():raise RuntimeError('Trial already started; inspect its existing receipt rather than running it again')
        if self.inspect()['Id']!=prepared['original_container'] or self.inspect(True)['Id']!=prepared['original_rank_container']:raise RuntimeError('Original pair identity changed since preparation')
        if self.rank(['cat',self.original_rank_launcher()])!=(self.backup/'worker-inner.sh').read_bytes():raise RuntimeError('Original rank launcher changed since preparation')
        self.isolate_candidate_staging(prepared)
        self.wait_idle();write(self.root/'run-intent.json',{'started_at':time.time(),'trial_id':self.plan['trial_id']})
        acceptance=self.plan.get('qualification_mode')=='candidate-only'
        result={'state':'running','phases':{},'qualification_mode':'candidate-only' if acceptance else 'comparison',
                'scope':'Candidate native correctness, cache and capacity acceptance, followed by exact restoration. No comparative performance benchmark or permanent adoption.' if acceptance else 'A/B/A2 on the owner-approved temporary profile. No candidate is adopted as a default.'}
        changed=False
        try:
            if not acceptance:result['phases']['A']=self.checks('A',400000)
            self.baseline_unchanged();self.wait_idle();changed=True
            self.suspend_original(prepared)
            self.launch(self.candidate,self.tag,'candidate')
            current=self.inspect();current_rank=self.inspect(True)
            if current['Image']!=prepared['candidate_image'] or current_rank['Image']!=prepared['rank_candidate_image']:raise RuntimeError('Candidate image identity differs')
            write(self.root/'candidate-head.json',current);write(self.root/'candidate-rank.json',current_rank)
            result['candidate_settings']={k:v for k,v in envmap(current).items() if k.startswith('GLM53_') or k in ['MAX_MODEL_LEN','MAX_NUM_SEQS','MAX_NUM_BATCHED_TOKENS','GPU_MEM_UTIL','DFLASH_TOKENS','LOAD_FORMAT','EXTRA_ARGS']}
            context=262144
            if self.plan.get('candidate_profile')=='baseline-cache-400k':
                expected=baseline_cache_settings(envmap(json.loads((self.backup/'head.json').read_text())))
                # Container variables map the two launcher retention knobs to vLLM.
                mapped={'GLM53_APC_RETENTION_INTERVAL':'VLLM_PREFIX_CACHE_RETENTION_INTERVAL','GLM53_APC_RETENTION_INTERVAL_SWA':'VLLM_PREFIX_CACHE_RETENTION_INTERVAL_SWA'}
                for container in [current,current_rank]:
                    actual=envmap(container)
                    if any(actual.get(mapped.get(key,key))!=value for key,value in expected.items()):
                        raise RuntimeError('Cache candidate changed a preserved serving setting')
                context=400000
                result['preserved_serving_settings_verified']=True
            result['candidate_profile']=self.plan.get('candidate_profile','long-coding')
            result['phases']['B']=self.checks('B',context)
        except Exception as error:result['error']=str(error)
        finally:
            if changed:
                try:
                    result['restoration']=self.restore(prepared)
                    if acceptance:
                        sample,reply=self.chat([{'role':'user','content':'Restoration readiness check. Reply with exactly RESTORED_7319.'}])
                        result['restoration']['readiness']=sample
                        if sample['finish_reason']!='stop' or reply['content'].strip()!='RESTORED_7319':
                            raise RuntimeError('Restored original failed native readiness')
                    else:result['phases']['A2']=self.checks('A2',400000)
                    rows={x['label']:x for x in result['phases'].get('A2',[])}
                    quality=['arithmetic','tool_call_and_followup','cold-A','cold-B','append-A','append-B','edit-90-percent','branch-90-percent']
                    if not acceptance and (not all(rows.get(label,{}).get('passed') is True for label in quality)
                        or rows.get('context-boundary',{}).get('accepted') is not True
                        or rows.get('concurrency-two',{}).get('two_active_requests_observed') is not True):
                        result['restoration'].update(state='unverified',error='Original quality, context or concurrency checks did not pass')
                except Exception as error:result['restoration']={'state':'unverified','error':str(error)}
            else:result['restoration']={'state':'verified','scope':'Serving was never changed; original remains running.'}
            result['state']='complete' if result['restoration']['state']=='verified' else 'restoration_required'
            result['finished_at']=time.time();write(self.root/'run-result.json',result)
        return result

    def rollout_preflight(self):
        self.baseline_unchanged()
        head,rank=self.inspect(),self.inspect(True)
        if any(x['Image']!=self.plan['baseline_image'] or not x['State']['Running'] for x in [head,rank]):
            raise RuntimeError('The running target pair differs from its enrolled baseline')
        baseline_cache_settings(envmap(head))
        if shutil.disk_usage(self.root).free<50*1024**3:raise RuntimeError('Insufficient target scratch space; serving unchanged')
        return {'state':'verified','original_container':head['Id'],'original_rank_container':rank['Id'],'scope':'Read-only baseline and capacity preflight; no model stopped.'}

    def deploy(self):
        if self.plan.get('kind')!='glm53-spark-pair-rollout' or self.plan.get('candidate_profile')!='baseline-cache-400k':raise RuntimeError('Only an explicitly enrolled capacity-preserving permanent rollout can deploy')
        prepared=json.loads((self.root/'prepared.json').read_text());self.baseline_unchanged()
        if (self.root/'deploy-intent.json').exists():raise RuntimeError('Deployment already submitted; inspect its existing receipt')
        if prepared['candidate_image']!=self.plan['qualified_image']:raise RuntimeError('Prepared image is not the qualified image')
        if self.inspect()['Id']!=prepared['original_container'] or self.inspect(True)['Id']!=prepared['original_rank_container']:
            raise RuntimeError('Original pair identity changed during preparation')
        self.isolate_candidate_staging(prepared)
        self.wait_idle();write(self.root/'deploy-intent.json',{'started_at':time.time(),'operation_id':self.plan['trial_id']})
        result={'state':'deploying','scope':'Owner-authorized permanent rollout. Readiness canary only; no performance benchmark or capacity test.'}
        changed=False
        try:
            changed=True;self.suspend_original(prepared)
            self.launch(self.candidate,self.tag,'deployment')
            head,rank=self.inspect(),self.inspect(True)
            expected=baseline_cache_settings(envmap(json.loads((self.backup/'head.json').read_text())))
            mapped={'GLM53_APC_RETENTION_INTERVAL':'VLLM_PREFIX_CACHE_RETENTION_INTERVAL','GLM53_APC_RETENTION_INTERVAL_SWA':'VLLM_PREFIX_CACHE_RETENTION_INTERVAL_SWA'}
            for current,key in [(head,'candidate_image'),(rank,'rank_candidate_image')]:
                if current['Image']!=prepared[key] or not current['State']['Running']:raise RuntimeError('Deployed image identity or running state differs')
                actual=envmap(current)
                if any(actual.get(mapped.get(key,key))!=value for key,value in expected.items()):raise RuntimeError('A preserved serving setting differs')
            models=json.loads(self.request('/v1/models',timeout=15))
            if not any(m.get('id')=='GLM-5.3-Flash-EXL3' for m in models.get('data',[])):raise RuntimeError('Expected served model unavailable')
            sample,reply=self.chat([{'role':'user','content':'Deployment readiness check. Reply with exactly DEPLOYED_7319.'}])
            if sample['finish_reason']!='stop' or reply['content'].strip()!='DEPLOYED_7319':raise RuntimeError('Deployment readiness generation did not return the expected answer')
            write(self.root/'candidate-head.json',head);write(self.root/'candidate-rank.json',rank)
            result.update(state='deployed',candidate_image=head['Image'],rank_candidate_image=rank['Image'],head_container=head['Id'],rank_container=rank['Id'],preserved_serving_settings_verified=True,
                          serving_settings={k:v for k,v in envmap(head).items() if k in expected or k in mapped.values()},readiness=sample,
                          original_containers={'head':prepared['original_container'],'rank':prepared['original_rank_container']},recipe_root=str(self.candidate))
        except Exception as error:
            result['error']=str(error)
            if changed:
                try:result.update(state='restored',restoration=self.restore(prepared))
                except Exception as failure:result.update(state='restoration_required',restoration_error=str(failure))
            else:result['state']='failed_unchanged'
        result['finished_at']=time.time();write(self.root/'deploy-result.json',result);return result


if __name__=='__main__':
    # Losing the SSH session must not terminate the restoration transaction.
    signal.signal(signal.SIGHUP,signal.SIG_IGN)
    action,encoded=sys.argv[1:];plan=json.loads(base64.b64decode(encoded));runner=Remote(plan)
    if action=='idle':result={'idle':runner.idle()}
    elif action in ['prepare','run','deploy','rollout_preflight','rollback']:
        with open(runner.root/'operation.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            result=runner.restore(json.loads((runner.root/'prepared.json').read_text())) if action=='rollback' else getattr(runner,action)()
    else:raise SystemExit('Unknown action')
    print(json.dumps(result),flush=True)
