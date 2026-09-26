"""Fixed SSH transport for the retained ACE candidate preparer, not a CLI."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import zlib

MODULES = ('docker_profile', 'recovery_pair', 'recovery_pair_native', 'recovery_media_command',
           'media_recipe_contract', 'media_ace_candidate')
MACHINE = r'''
import hashlib,json,re,subprocess
from pathlib import Path

def native_machine():
    gpus=sorted(subprocess.check_output(['nvidia-smi','--query-gpu=uuid','--format=csv,noheader'],timeout=20).decode().strip().splitlines())
    if not 1<=len(gpus)<=16 or len(gpus)!=len(set(gpus)) or any(not re.fullmatch(r'GPU-[a-fA-F0-9-]{16,80}',v) for v in gpus):raise ValueError('GPU identity unavailable')
    identity={'scheme':'linux-machine-id-and-gpu-uuid-v1','os_machine_id_sha256':hashlib.sha256(Path('/etc/machine-id').read_bytes()).hexdigest(),'gpu_uuids':gpus}
    return hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(',',':')).encode()).hexdigest()
'''
DISPATCH = r'''
import base64,json,os,sys
from pathlib import Path
import media_ace_candidate as m

def run(payload):
    action=payload['action'];io=m.NativeIO(native_machine)
    if action=='machine':return io.machine()
    if action=='inspect':
        value=payload['value'];m.require(isinstance(value,str) and (m.HEX.fullmatch(value) or value.startswith('stargate-ace-candidate-') and m.UUID.fullmatch(value.removeprefix('stargate-ace-candidate-'))),'inspect_identity')
        return io.inspect(value)
    if action=='image':
        value=payload['value'];m.require(isinstance(value,str) and (m.IMAGE.fullmatch(value) or any(value.startswith(p) and m.UUID.fullmatch(value.removeprefix(p)) for p in ('stargate-ace-snapshot:','stargate-ace-candidate:'))),'image_identity')
        return io.image(value)
    if action=='recipe':
        m.require(m.HEX.fullmatch(payload['container']) and m.IMAGE.fullmatch(payload['image']),'recipe_identity')
        return io.recipe_fields(payload['container'],payload['image'])
    request=m.validate(payload['request']);m.check_original(request,io)
    operation=request['operation_id'];snapshot='stargate-ace-snapshot:'+operation;tag='stargate-ace-candidate:'+operation
    if action=='snapshot':
        m.require(io.image(snapshot) is None,'snapshot_name_used')
        return io.snapshot(request['before']['Id'],snapshot)
    if action=='build':
        entries=payload['files'];m.require(set(entries)==set(m.SOURCES)|{'Dockerfile'},'build_files')
        data={k:base64.b64decode(v,validate=True) for k,v in entries.items()}
        m.require(all(len(v)<1024*1024 for v in data.values()),'build_file_size')
        m.require(all(m.hashlib.sha256(data[k]).hexdigest()==request['source_sha256'][k] for k in m.SOURCES),'build_sources')
        expected=(f'FROM {snapshot}\nCOPY apply-recipe-fields.py verify-api-fields.py /opt/stargate/\n'
                  'RUN ["python", "/opt/stargate/apply-recipe-fields.py"]\n'
                  'RUN ["/bin/sh", "-c", "python /opt/stargate/verify-api-fields.py > /opt/stargate/recipe-fields-verification.json"]\n').encode()
        m.require(data['Dockerfile']==expected and io.image(tag) is None and io.image(snapshot) is not None,'build_recipe')
        parent=Path.home()/'.local/share/star-gate/ace-candidates';parent.mkdir(parents=True,exist_ok=True,mode=0o700);m.root_directory(parent)
        folder=parent/operation;folder.mkdir(mode=0o700);m.sync_directory(parent)
        m.private_save(folder/'request.json',request)
        context=folder/'context';context.mkdir(mode=0o700)
        for name,value in data.items():
            with (context/name).open('xb') as f:os.chmod(f.name,0o600);f.write(value);f.flush();os.fsync(f.fileno())
        m.sync_directory(context);m.sync_directory(folder)
        return io.build(context,tag)
    if action=='create':
        image=payload['image'];m.require(isinstance(image,str) and m.IMAGE.fullmatch(image) and io.image(tag)['Id']==image,'create_image')
        body=m.copy.deepcopy(request['before']['Config']);body.update(Image=image,HostConfig=m.copy.deepcopy(request['before']['HostConfig']))
        name='stargate-ace-candidate-'+operation;m.require(io.inspect(name) is None,'create_name_used')
        return io.create(name,body)
    raise ValueError('Unknown fixed candidate action')
try:
    raw=sys.stdin.buffer.read(4*1024*1024+1)
    if len(raw)>4*1024*1024:raise ValueError('Request too large')
    print(json.dumps({'result':run(json.loads(raw))}))
except Exception:
    print(json.dumps({'error':'candidate_native_action_unconfirmed'}));sys.exit(1)
'''


def bundle(directory):
    directory = Path(directory)
    return {name: (directory/(name+'.py')).read_text() for name in MODULES}


def program(frozen):
    if set(frozen) != set(MODULES) or any(not isinstance(v,str) for v in frozen.values()):
        raise ValueError('Fixed candidate source bundle required')
    data=base64.b64encode(zlib.compress(json.dumps(frozen).encode())).decode()
    return ("import base64,json,sys,types,zlib\n"
            "sources=json.loads(zlib.decompress(base64.b64decode("+repr(data)+")))\n"
            "for name in "+repr(MODULES)+":\n"
            " module=types.ModuleType(name);module.__file__='/stargate-bundle/'+name+'.py';sys.modules[name]=module\n"
            " exec(compile(sources[name],module.__file__,'exec'),module.__dict__)\n"+MACHINE+DISPATCH)


class RemoteIO:
    def __init__(self,host,frozen,request=None,execute=subprocess.run):
        if not isinstance(host,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*',host):raise ValueError('Fixed enrolled SSH host required')
        self.host=host;self.request=request;self.execute=execute;self.code=program(frozen)

    def call(self,action,**values):
        payload={'action':action,**values}
        if action in ('snapshot','build','create'):payload['request']=self.request
        result=self.execute(['ssh','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',
            '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','--',self.host,
            'python3 -I -B -c '+shlex.quote(self.code)],input=json.dumps(payload).encode(),capture_output=True,
            timeout=None if action in ('snapshot','build','create') else 300)
        if result.returncode or len(result.stdout)>8*1024*1024:raise RuntimeError('candidate_native_action_unconfirmed')
        out=json.loads(result.stdout)
        if set(out)!={'result'}:raise RuntimeError('candidate_native_action_unconfirmed')
        return out['result']

    def machine(self):return self.call('machine')
    def inspect(self,value):return self.call('inspect',value=value)
    def image(self,value):return self.call('image',value=value)
    def recipe_fields(self,cid,image):return self.call('recipe',container=cid,image=image)
    def snapshot(self,cid,tag):
        if cid!=self.request['before']['Id'] or tag!='stargate-ace-snapshot:'+self.request['operation_id']:raise ValueError('Snapshot binding changed')
        return self.call('snapshot')
    def build(self,context,tag):
        if tag!='stargate-ace-candidate:'+self.request['operation_id']:raise ValueError('Build binding changed')
        files={p.name:base64.b64encode(p.read_bytes()).decode() for p in Path(context).iterdir()}
        return self.call('build',files=files)
    def create(self,name,body):
        expected=dict(self.request['before']['Config'],Image=body['Image'],HostConfig=self.request['before']['HostConfig'])
        if name!='stargate-ace-candidate-'+self.request['operation_id'] or body!=expected:raise ValueError('Create binding changed')
        return self.call('create',image=body['Image'])
