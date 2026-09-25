"""Permanent, operator-enrolled deployment of a previously qualified Spark image.

The Genie supplies only a profile and operation UUID. This executor copies the
exact image, keeps the original containers, publishes the normal launcher, and
readmits only after an ordinary readiness generation. No benchmark is run.
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
from spark_recipe_trial import Executor, atomic
from genie_inspection import peer_parameters
from image_peer_transfer import transfer as peer_stream


def digest(data):return hashlib.sha256(data).hexdigest()


def replace_bytes(file, data):
    mode=file.stat().st_mode & 0o777
    temporary=file.with_name(file.name+'.'+str(uuid.uuid4())+'.tmp')
    try:
        with open(temporary,'xb',opener=lambda p,f:os.open(p,f,mode)) as stream:
            stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.chmod(temporary,mode);temporary.replace(file)
    finally:
        if temporary.exists():temporary.unlink()


class Rollout(Executor):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        p=self.plan
        if p['kind']!='glm53-spark-pair-rollout' or p.get('candidate_profile')!='baseline-cache-400k':raise ValueError('Use the enrolled capacity-preserving rollout')
        if not re.fullmatch(r'sha256:[a-f0-9]{64}',p.get('qualified_image','')):raise ValueError('Pin the qualified image')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,100}',p.get('image_source_ssh','')):raise ValueError('Use the enrolled source host')
        for key in ['qualified_result_file','qualified_prepare_file','launcher_file','inspection_config_file']:
            if not Path(p.get(key,'')).is_absolute() or '..' in Path(p[key]).parts:raise ValueError('Use an absolute enrolled publication/evidence path')
        for key in ['qualified_result_sha256','qualified_prepare_sha256','launcher_sha256']:
            if not re.fullmatch(r'[a-f0-9]{64}',p.get(key,'')):raise ValueError('Pin qualification and launcher bytes')

    def qualification(self):
        result_data=Path(self.plan['qualified_result_file']).read_bytes();prepared_data=Path(self.plan['qualified_prepare_file']).read_bytes()
        if digest(result_data)!=self.plan['qualified_result_sha256'] or digest(prepared_data)!=self.plan['qualified_prepare_sha256']:raise RuntimeError('Qualification evidence changed')
        result,prepared=json.loads(result_data),json.loads(prepared_data)
        if (result.get('state')!='complete' or result.get('error') or result.get('restoration',{}).get('state')!='verified'
                or result.get('preserved_serving_settings_verified') is not True
                or prepared.get('candidate_image')!=self.plan['qualified_image']
                or prepared.get('source_revision')!=self.plan['source_revision']):raise RuntimeError('This image/source lacks the enrolled completed qualification')
        rows={row['label']:row for row in result.get('phases',{}).get('B',[])}
        required={'arithmetic','tool_call_and_followup','cold-A','cold-B','append-A','append-B','edit-90-percent','branch-90-percent','context-boundary','concurrency-two'}
        if (set(rows)!=required or any(row.get('passed') is not True for row in rows.values() if row['label'] not in ['context-boundary','concurrency-two'])
                or rows.get('context-boundary',{}).get('accepted') is not True
                or rows.get('concurrency-two',{}).get('two_active_requests_observed') is not True):raise RuntimeError('Saved candidate qualification did not pass')
        if result.get('qualification_mode')=='candidate-only':
            if (any(rows.get('cold-'+key,{}).get('cold_cache_proved') is not True or
                    rows.get('append-'+key,{}).get('substantial_reuse_proved') is not True for key in ['A','B'])
                    or result['restoration'].get('readiness',{}).get('finish_reason')!='stop'
                    or result['restoration'].get('readiness',{}).get('answer','').strip()!='RESTORED_7319'):
                raise RuntimeError('Candidate-only acceptance lacks native cache or restoration proof')

    def publication_prepare(self):
        folder=self.folder/'publication';folder.mkdir(mode=0o700)
        launcher=Path(self.plan['launcher_file']);config=Path(self.plan['inspection_config_file'])
        if launcher.is_symlink() or config.is_symlink():raise RuntimeError('Publication files must not be symlinks')
        source=launcher.read_bytes()
        if digest(source)!=self.plan['launcher_sha256']:raise RuntimeError('The normal launcher changed before preparation')
        old=json.dumps(self.plan['recipe_root']).encode();new=json.dumps(self.remote+'/candidate').encode()
        if source.count(old)!=1:raise RuntimeError('Expected one exact target recipe binding in the normal launcher')
        config_bytes=config.read_bytes();value=json.loads(config_bytes)
        target=value.get('genie_chat',{}).get('inspection',{}).get('workers',{}).get(self.plan['worker'],{})
        if target.get('recipe_root')!=self.plan['recipe_root'] or self.plan['ssh'] not in target.get('ssh',[]):raise RuntimeError('Inspection publication binding differs')
        target['recipe_root']=self.remote+'/candidate'
        pair=value.get('media_jobs',{}).get('pairs',{}).get(self.plan['worker'])
        if pair is not None:
            members=[m for m in pair.get('members',[]) if m.get('ssh')==self.plan['ssh']]
            if len(members)!=1 or members[0].get('recipe_root')!=self.plan['recipe_root']:
                raise RuntimeError('Paired-media recipe binding differs; preserve the enrollment')
            members[0]['recipe_root']=self.remote+'/candidate'
        after_config=(json.dumps(value,indent=2)+'\n').encode()
        for name,data in [('launcher.before',source),('launcher.after',source.replace(old,new)),('config.before',config_bytes),('config.after',after_config)]:
            with open(folder/name,'xb',opener=lambda p,f:os.open(p,f,0o600)) as out:out.write(data)
        atomic(folder/'intent.json',{'worker':self.plan['worker'],'old_recipe':self.plan['recipe_root'],'new_recipe':self.remote+'/candidate','created_at':time.time(),'scope':'Change only the target normal-launcher recipe path, inspection binding and matching paired-media recipe binding. Physical media enrollment and other fleet settings are preserved.'})

    def publication_unchanged(self):
        for name,key in [('launcher','launcher_file'),('config','inspection_config_file')]:
            if Path(self.plan[key]).read_bytes()!=(self.folder/'publication'/(name+'.before')).read_bytes():raise RuntimeError('A publication file changed; preserve owner edits')

    def publish(self):
        self.publication_unchanged();result={}
        for name,key in [('launcher','launcher_file'),('config','inspection_config_file')]:
            before=(self.folder/'publication'/(name+'.before')).read_bytes();after=(self.folder/'publication'/(name+'.after')).read_bytes()
            replace_bytes(Path(self.plan[key]),after)
            if Path(self.plan[key]).read_bytes()!=after:raise RuntimeError('Published launcher/configuration bytes were not confirmed')
            result[name]={'before_sha256':digest(before),'after_sha256':digest(after)}
        result.update(state='published',recipe_root=self.remote+'/candidate',dashboard_reload_required=True)
        atomic(self.folder/'publication'/'result.json',result);return result

    def unpublish(self):
        for name,key in [('launcher','launcher_file'),('config','inspection_config_file')]:
            file=Path(self.plan[key]);before=(self.folder/'publication'/(name+'.before')).read_bytes();after=(self.folder/'publication'/(name+'.after')).read_bytes()
            current=file.read_bytes()
            if current==after:replace_bytes(file,before)
            elif current!=before:raise RuntimeError('Owner edited publication files; leave the maintenance hold for inspection')
        return {'state':'original_publication_restored'}

    def spare(self):
        return super().spare()

    def relay_image(self):
        with open(self.folder/'image-copy.log','ab',buffering=0) as log:
            sender=subprocess.Popen(['ssh','-C','-o','BatchMode=yes','-o','ConnectTimeout=15',self.plan['image_source_ssh'],shlex.join(['docker','save','--platform','linux/arm64',self.plan['qualified_image']])],stdout=subprocess.PIPE,stderr=log)
            receiver=None
            try:
                receiver=subprocess.Popen(['ssh','-C','-o','BatchMode=yes','-o','ConnectTimeout=15',self.plan['ssh'],'docker load'],stdin=sender.stdout,stdout=log,stderr=log)
                sender.stdout.close();received=receiver.wait(timeout=7200);sent=sender.wait(timeout=60)
                if received or sent:raise RuntimeError('Qualified image transfer did not complete; serving unchanged')
            finally:
                if receiver is not None and receiver.poll() is None:receiver.terminate();receiver.wait(timeout=30)
                if sender.poll() is None:sender.terminate();sender.wait(timeout=30)

    def target_has_image(self):
        code="import json,subprocess,sys; r=subprocess.run(['docker','image','inspect',sys.argv[1]],capture_output=True,text=True); print(json.dumps({'present':True,'image':json.loads(r.stdout)[0]['Id'],'architecture':json.loads(r.stdout)[0]['Architecture']} if r.returncode==0 else {'present':False} if 'No such image' in r.stderr else {'error':'Docker image inspection unavailable'}))"
        result=json.loads(self.ssh(shlex.join(['python3','-I','-c',code,self.plan['qualified_image']]),timeout=60))
        if 'error' in result:raise RuntimeError(result['error'])
        if result.get('present') and (result.get('image')!=self.plan['qualified_image'] or result.get('architecture')!='arm64'):raise RuntimeError('Existing target image differs')
        return result.get('present') is True

    def direct_image(self):
        # Obtain the machine identity and public host key through the enrolled
        # trusted connection. The source uses only a temporary known-hosts file.
        try:peer=peer_parameters({'ssh':[self.plan['ssh']]})
        except Exception:return False
        code="""import base64,json,pathlib,shlex,subprocess,sys,tempfile
p=json.loads(base64.b64decode(sys.argv[1]))
with tempfile.TemporaryDirectory(prefix='dsg-image-peer-') as temp:
 key=pathlib.Path(temp)/'known_hosts';key.write_text(p['peer']['known_hosts']);key.chmod(0o600)
 peer=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','UserKnownHostsFile='+str(key),'-o','ConnectTimeout=8','-p',str(p['peer']['port']),p['peer']['destination']]
 probe='import hashlib,pathlib; print(hashlib.sha256(pathlib.Path("/etc/machine-id").read_bytes()).hexdigest())'
 r=subprocess.run(peer+[shlex.join(['python3','-I','-c',probe])],capture_output=True,text=True,timeout=20,check=True)
 if r.stdout.strip()!=p['peer']['machine_sha256']:raise RuntimeError('Direct target identity changed')
 if p['mode']=='probe':print(r.stdout.strip());sys.exit(0)
 sender=subprocess.Popen(['docker','save','--platform','linux/arm64',p['image']],stdout=subprocess.PIPE)
 receiver=None
 try:
  receiver=subprocess.Popen(peer+['docker load'],stdin=sender.stdout);sender.stdout.close()
  received=receiver.wait(timeout=7200);sent=sender.wait(timeout=60)
  if received or sent:raise RuntimeError('Direct image copy failed')
 finally:
  if receiver is not None and receiver.poll() is None:receiver.terminate();receiver.wait(timeout=30)
  if sender.poll() is None:sender.terminate();sender.wait(timeout=30)
"""
        def command(mode):
            payload=base64.b64encode(json.dumps({'peer':peer,'image':self.plan['qualified_image'],'mode':mode}).encode()).decode()
            return ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15',self.plan['image_source_ssh'],shlex.join(['python3','-I','-c',code,payload])]
        probe=self.run(command('probe'),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=45)
        if probe.returncode:return peer_stream(self,peer)
        if probe.stdout.decode().strip()!=peer['machine_sha256']:return False
        atomic(self.folder/'direct-copy-peer.json',{'state':'verified','peer':peer,'source':self.plan['image_source_ssh'],'image':self.plan['qualified_image'],'at':time.time()})
        self.status('copying_qualified_image',transport='direct_spark_peer')
        with open(self.folder/'image-copy.log','ab',buffering=0) as log:
            result=self.run(command('copy'),stdout=log,stderr=log,timeout=7300)
        if result.returncode:raise RuntimeError('Direct image transfer failed; inspect this same operation before resuming')
        return True

    def verify_retained_source(self):
        expected={}
        with tarfile.open(self.plan['source_archive']) as archive:
            for member in archive.getmembers():
                if member.isfile():expected[member.name]=digest(archive.extractfile(member).read())
        payload=base64.b64encode(json.dumps(expected).encode()).decode()
        code="import base64,hashlib,json,pathlib,sys; root=pathlib.Path(sys.argv[1]); files=json.loads(base64.b64decode(sys.argv[2])); assert all((root/name).is_file() and not (root/name).is_symlink() and hashlib.sha256((root/name).read_bytes()).hexdigest()==value for name,value in files.items()), 'Retained source differs'; assert not (root.parent/'baseline').exists() and not (root.parent/'deploy-intent.json').exists(), 'Preparation advanced'; print('verified')"
        self.ssh(shlex.join(['python3','-I','-c',code,self.remote+'/candidate',payload]),timeout=60)

    def prepare(self):
        self.qualification()
        source=Path(self.plan['source_archive'])
        if digest(source.read_bytes())!=self.plan['source_sha256']:raise RuntimeError('Source archive changed')
        if self.receipt.get('resume_copy'):
            self.publication_unchanged();self.verify_retained_source()
        else:
            self.publication_prepare();self.status('copying_pinned_source')
            self.ssh(shlex.join(['mkdir','-m','700','-p',self.plan['remote_root']]))
            self.ssh(shlex.join(['mkdir','-m','700',self.remote]))
            self.ssh(shlex.join(['mkdir','-m','700',self.remote+'/candidate']))
            self.ssh(shlex.join(['tar','-xf','-','-C',self.remote+'/candidate']),input=source.read_bytes())
        self.remote_action('rollout_preflight',timeout=90)
        self.status('copying_qualified_image')
        if self.target_has_image():atomic(self.folder/'image-reused.json',{'image':self.plan['qualified_image'],'state':'present','at':time.time()})
        elif not self.direct_image():
            self.status('copying_qualified_image',transport='local_relay');self.relay_image()
        self.status('backing_up_target_and_preparing_launcher')
        result=self.remote_action('prepare');atomic(self.folder/'prepare.result.json',result)
        if result.get('state')!='prepared' or result.get('candidate_image')!=self.plan['qualified_image']:raise RuntimeError('Exact-image preparation was not verified')
        return result

    def execute(self,stage):
        if stage!='rollout':raise ValueError('Permanent rollout has one independent execution stage')
        file=self.folder/'rollout.status.json';self.receipt=json.loads(file.read_text());maintenance=None
        try:
            prepared=self.prepare();self.publication_unchanged();self.spare()
            maintenance=Maintenance(self.folder,self.id,self.plan['worker'],control=self.control,purpose='serving',progress=lambda phase,detail:self.status(phase))
            self.status('acquiring_owned_hold');maintenance.acquire();maintenance.wait_idle(self.native_idle);self.spare()
            self.publication_unchanged();self.status('deploying_qualified_image')
            result=self.remote_action('deploy',timeout=7200);atomic(self.folder/'rollout.result.json',result)
            if result.get('state')=='deployed':
                try:
                    maintenance.owned();self.status('publishing_normal_launcher');publication=self.publish()
                except Exception:
                    self.status('restoring_original_after_publication_failure')
                    self.unpublish();restoration=self.remote_action('rollback',timeout=3600)
                    self.receipt.update(restoration=restoration)
                    raise
                maintenance.wait_idle(self.native_idle);maintenance.release();resumed=maintenance.resume_if_unchanged()
                self.receipt.update(state='complete',result=result,publication=publication,readmission=resumed)
            elif result.get('state') in ['restored','failed_unchanged']:
                maintenance.wait_idle(self.native_idle);maintenance.release();resumed=maintenance.resume_if_unchanged()
                self.receipt.update(state='restored',result=result,readmission=resumed)
            else:self.receipt.update(state='restoration_required',result=result)
        except Exception as error:
            self.receipt.update(state='restoration_required' if maintenance else 'failed',error=str(error))
            # Release after a verified rollback only. Uncertain remote changes
            # or publication conflicts retain their owned hold for inspection.
            if maintenance and self.receipt.get('restoration',{}).get('state')=='verified':
                try:
                    maintenance.wait_idle(self.native_idle);maintenance.release();self.receipt.update(state='restored',readmission=maintenance.resume_if_unchanged())
                except Exception as failure:self.receipt['readmission_error']=str(failure)
        self.receipt['finished_at']=time.time();atomic(file,self.receipt)
        return self.receipt


if __name__=='__main__':
    stage,folder,socket=sys.argv[1:]
    result=Rollout(folder,GatewayControl(socket)).execute(stage)
    print(json.dumps({'state':result['state'],'phase':result.get('phase')}),flush=True)
