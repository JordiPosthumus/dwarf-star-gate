"""Trusted, operator-enrolled Spark recipe trial executor; no chat shell input.

Preparation leaves serving running. A run takes an owned maintenance hold,
waits for real native idleness, and returns the original only after the remote
transaction's restoration receipt and native verification. Receipts are private.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tarfile
import time
import uuid

from operation_maintenance import GatewayControl, Maintenance


def atomic(file, value):
    temporary=file.with_suffix('.tmp')
    with open(temporary, 'w', opener=lambda p,f: os.open(p,f,0o600)) as stream:
        json.dump(value,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    temporary.replace(file)


def validate(plan):
    if plan.get('schema')!=1 or plan.get('kind')!='glm53-spark-pair-long-coding':
        raise ValueError('Unsupported recipe trial')
    if plan.get('candidate_profile','long-coding') not in ['long-coding','baseline-cache-400k']:
        raise ValueError('Unsupported candidate profile')
    for key in ['worker','ssh','rank_ssh']:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,100}',plan.get(key,'')):
            raise ValueError('Invalid enrolled target')
    for key in ['source_revision','baseline_revision']:
        if not re.fullmatch(r'[a-f0-9]{40}',plan.get(key,'')):raise ValueError('Pin source and baseline commits')
    for key in ['source_sha256','baseline_env_sha256','baseline_start_sha256']:
        if not re.fullmatch(r'[a-f0-9]{64}',plan.get(key,'')):raise ValueError('Pin exact source and baseline bytes')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',plan.get('baseline_image','')):raise ValueError('Pin original image')
    for key in ['recipe_root','remote_root','source_archive']:
        if not Path(plan.get(key,'')).is_absolute() or '..' in Path(plan[key]).parts:raise ValueError('Use absolute enrolled paths')
    if plan['recipe_root']==plan['remote_root'] or plan['remote_root'].startswith(plan['recipe_root']+'/'):
        raise ValueError('Candidate must be separate from the production checkout')
    return plan


class Executor:
    def __init__(self,folder,control,*,run=subprocess.run):
        self.folder=Path(folder);self.plan=validate(json.loads((self.folder/'plan.json').read_text()))
        self.id=str(uuid.UUID(self.folder.name));self.run=run;self.control=control
        self.remote=self.plan['remote_root']+'/'+self.id
        self.receipt=None
    def status(self,phase,**fields):
        self.receipt.update(state='running',phase=phase,observed_at=time.time(),**fields)
        atomic(self.folder/(self.receipt['stage']+'.status.json'),self.receipt)
        print(json.dumps({'phase':phase,'at':time.time()}),flush=True)
    def ssh(self,command,*,input=None,timeout=7200):
        result=self.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15',self.plan['ssh'],command],input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
        if result.returncode:
            # Retain bounded private diagnostics, never present command/env secrets.
            with open(self.folder/'remote-errors.log','ab') as out:out.write(result.stderr[-12000:])
            raise RuntimeError('Remote recipe action failed; see private diagnostic log')
        return result.stdout
    def remote_action(self,action,timeout=7200):
        payload={**self.plan,'trial_id':self.id,'trial_root':self.remote}
        source=Path(self.plan['source_archive'])
        if hashlib.sha256(source.read_bytes()).hexdigest()!=self.plan['source_sha256']:raise RuntimeError('Source archive changed')
        with tarfile.open(source) as archive:
            payload['source_start_sha256']=hashlib.sha256(archive.extractfile('start.sh').read()).hexdigest()
        encoded=base64.b64encode(json.dumps(payload).encode()).decode()
        command=shlex.join(['python3','-',action,encoded])
        script=Path(__file__).with_name('spark_recipe_remote.py').read_bytes()
        raw=self.ssh(command,input=script,timeout=timeout)
        try:return json.loads(raw)
        except ValueError:raise RuntimeError('Remote action did not return a complete JSON receipt')
    def native_idle(self):
        try:return self.remote_action('idle',timeout=30).get('idle') is True
        except Exception:return False
    def prepare(self):
        source=Path(self.plan['source_archive'])
        if hashlib.sha256(source.read_bytes()).hexdigest()!=self.plan['source_sha256']:raise RuntimeError('Source archive changed')
        self.status('copying_pinned_source')
        self.ssh(shlex.join(['mkdir','-m','700','-p',self.plan['remote_root']]))
        self.ssh(shlex.join(['mkdir','-m','700',self.remote]))
        self.ssh(shlex.join(['mkdir','-m','700',self.remote+'/candidate']))
        self.ssh(shlex.join(['tar','-xf','-','-C',self.remote+'/candidate']),input=source.read_bytes())
        self.status('backing_up_and_building_candidate')
        result=self.remote_action('prepare')
        atomic(self.folder/'prepare.result.json',result)
        if result.get('state')!='prepared':raise RuntimeError('Candidate preparation was not verified')
        return {'state':'prepared','result':result}
    def measure(self):
        prepared=json.loads((self.folder/'prepare.result.json').read_text())
        if prepared.get('state')!='prepared':raise RuntimeError('Prepare this trial first')
        maintenance=Maintenance(self.folder,self.id,self.plan['worker'],control=self.control,purpose='trial',progress=lambda phase,detail:self.status(phase))
        self.status('acquiring_owned_hold');maintenance.acquire()
        maintenance.wait_idle(self.native_idle)
        self.status('measuring_and_restoring')
        # The remote transaction has its own finally-based restoration. If SSH
        # loses its answer, inspect it; never start the transaction a second time.
        result=self.remote_action('run',timeout=21600)
        atomic(self.folder/'run.result.json',result)
        if result.get('restoration',{}).get('state')!='verified':
            return {'state':'restoration_required','result':result}
        maintenance.wait_idle(self.native_idle)
        maintenance.release();resumed=maintenance.resume_if_unchanged()
        return {'state':'complete','result':result,'readmission':resumed}
    def execute(self,stage):
        file=self.folder/(stage+'.status.json');self.receipt=json.loads(file.read_text())
        try:
            result=self.prepare() if stage=='prepare' else self.measure()
            self.receipt.update(result,finished_at=time.time())
        except Exception as error:
            self.receipt.update(state='failed' if stage=='prepare' else 'restoration_required',error=str(error),finished_at=time.time())
        atomic(file,self.receipt)
        return self.receipt


if __name__=='__main__':
    stage,folder,socket=sys.argv[1:]
    if stage not in ('prepare','run'):raise SystemExit('Invalid stage')
    result=Executor(folder,GatewayControl(socket)).execute(stage)
    print(json.dumps({'state':result['state'],'phase':result.get('phase')}),flush=True)
