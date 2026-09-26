"""Independent fixed ACE preparation runner. No promotion or service lifecycle."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import types

sys.path.insert(0,str(Path(__file__).resolve().parent))
from media_candidate_remote import RemoteIO, MODULES
from docker_profile import UnixHTTP
from recovery_pair_native import private_read, private_save


def control(socket, route, body):
    connection=UnixHTTP(socket,30)
    try:
        connection.request('POST',route,json.dumps(body),{'Content-Type':'application/json','X-DSG-Control-Channel':'media_candidate'})
        response=connection.getresponse();raw=response.read(1024*1024+1)
        if response.status!=200 or len(raw)>1024*1024:raise ValueError('candidate_control_unconfirmed')
        return json.loads(raw)
    finally:connection.close()


def load(folder):
    folder=Path(folder);plan=private_read(folder/'plan.json');frozen=private_read(folder/'bundle.json')
    if folder.name!=plan['operation_id'] or hashlib.sha256((folder/'bundle.json').read_bytes()).hexdigest()!=plan['bundle_sha256']:raise ValueError('candidate_bundle_changed')
    if set(frozen['modules'])!=set(MODULES):raise ValueError('candidate_bundle_invalid')
    # Each operation executes its retained fixed implementation after a source
    # update; nothing from a model response is accepted as executable content.
    for name in MODULES:
        module=types.ModuleType(name);module.__file__=str(folder/'source'/f'{name}.py');sys.modules[name]=module
        exec(compile(frozen['modules'][name],module.__file__,'exec'),module.__dict__)
    m=sys.modules['media_ace_candidate'];m.root_directory(folder)
    return folder,plan,frozen,m


def main(directory,action):
    folder,plan,frozen,m=load(directory);journal=folder.parent/'native'
    if action=='status':
        request=private_read(folder/'request.json');io=RemoteIO(plan['host'],frozen['modules'],request)
        result=m.observe(journal,request,io)
        return {**result,'request_file_sha256':hashlib.sha256((folder/'request.json').read_bytes()).hexdigest()}
    if action!='run':raise ValueError('Unknown candidate runner action')
    fd=os.open(folder/'runner.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if (folder/'runner-intent.json').exists():return {'state':'requires_reconciliation','operation_id':plan['operation_id']}
        if hashlib.sha256(Path(__file__).read_bytes()).hexdigest()!=plan['runner_sha256']:raise ValueError('candidate_runner_changed')
        if hashlib.sha256(Path(__file__).with_name('media_candidate_remote.py').read_bytes()).hexdigest()!=plan['transport_sha256']:raise ValueError('candidate_transport_changed')
        private_save(folder/'runner-intent.json',{'operation_id':plan['operation_id'],'pid':os.getpid()})
        io=RemoteIO(plan['host'],frozen['modules'])
        original=io.inspect(plan['engine']['container'])
        if original['Id']!=plan['engine']['container'] or original['Image']!=plan['engine']['image']:raise ValueError('candidate_original_binding_changed')
        request={'version':1,'operation_id':plan['operation_id'],'machine':io.machine(),'before':m.signature(original),
                 'epoch':m.runtime(original),'source_sha256':plan['source_sha256']}
        m.validate(request);private_save(folder/'request.json',request);io.request=request
        file_hash=hashlib.sha256((folder/'request.json').read_bytes()).hexdigest()
        def permit(saved):
            if saved!=request or hashlib.sha256((folder/'request.json').read_bytes()).hexdigest()!=file_hash:return False
            return control(plan['control_socket'],'/media-candidate-permit',{'operation_id':plan['operation_id'],'request_file_sha256':file_hash}).get('allowed') is True
        source=folder/'patch';source.mkdir(mode=0o700)
        if set(frozen['patch'])!=set(m.SOURCES):raise ValueError('candidate_patch_changed')
        for name,value in frozen['patch'].items():
            raw=value.encode()
            if hashlib.sha256(raw).hexdigest()!=plan['source_sha256'][name]:raise ValueError('candidate_patch_changed')
            with (source/name).open('xb') as f:os.chmod(f.name,0o600);f.write(raw);f.flush();os.fsync(f.fileno())
        journal.mkdir(mode=0o700,exist_ok=True)
        result=m.prepare(journal,request,io,permit,source)
        private_save(folder/'result.json',{**result,'request_file_sha256':file_hash})
        if result['state']=='prepared_stopped':
            # Completion only releases preparation ownership. Enrollment and
            # native qualification are separate, unsupported stages here.
            control(plan['control_socket'],'/media-candidate-complete',{'operation_id':plan['operation_id']})
        return result
    finally:os.close(fd)


if __name__=='__main__':
    try:print(json.dumps(main(*sys.argv[1:])))
    except Exception as error:
        try:
            if len(sys.argv)>2 and sys.argv[2]=='run':private_save(Path(sys.argv[1])/'attention.json',{'state':'requires_reconciliation','reason':str(error) if str(error).startswith(('ace_candidate_','candidate_')) else 'candidate_runner_unconfirmed'})
        except Exception:pass
        print(json.dumps({'state':'requires_reconciliation','reason':'candidate_runner_unconfirmed'}));sys.exit(1)
