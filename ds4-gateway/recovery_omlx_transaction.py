"""Detached local oMLX transactions; no uncertain command is replayed."""
from contextlib import contextmanager
import fcntl
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import time

spec=importlib.util.spec_from_file_location('omlx_adapter',Path(__file__).with_name('recovery-omlx.py'))
omlx=importlib.util.module_from_spec(spec);spec.loader.exec_module(omlx)
UUID=re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
DIGEST=re.compile(r'[a-f0-9]{64}')
INSTANCE=re.compile(r'[a-f0-9]{32}')


def require(value,reason):
    if not value:raise ValueError(reason)


def starting(request):
    return request.get('action')=='start-transaction'


def identity_key(request):
    return 'stopped_epoch' if starting(request) else 'instance'


def validate_request(request):
    require(isinstance(request,dict),'omlx_transaction_request_invalid')
    fields={'action','action_id','machine','profile','gateway_socket'}
    fields.update(('stopped_epoch','demand_id') if starting(request) else ('instance','canary'))
    require(set(request)==fields,'omlx_transaction_request_invalid')
    require((starting(request) and isinstance(request['stopped_epoch'],str) and DIGEST.fullmatch(request['stopped_epoch'])
             and isinstance(request['demand_id'],str) and UUID.fullmatch(request['demand_id'])
             or request['action']=='transaction' and request['canary'] is True
             and isinstance(request['instance'],str) and INSTANCE.fullmatch(request['instance']))
            and isinstance(request['action_id'],str) and UUID.fullmatch(request['action_id'])
            and all(isinstance(request[k],str) and DIGEST.fullmatch(request[k]) for k in ('machine','profile'))
            and isinstance(request['gateway_socket'],str) and Path(request['gateway_socket']).is_absolute()
            and '\0' not in request['gateway_socket'],'omlx_transaction_request_invalid')


def private_directory(folder,*,create=True):
    if create:folder.mkdir(mode=0o700,exist_ok=True)
    info=folder.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o077,'omlx_transaction_directory_unverified')


def private_read(filename):
    fd=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd) as f:
        info=os.fstat(f.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o077 and info.st_size<=65536,'omlx_transaction_file_unverified')
        return json.load(f)


@contextmanager
def lease(filename,blocking=False):
    fd=os.open(filename,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    try:
        info=os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o077,'omlx_transaction_lock_unverified')
        try:fcntl.flock(fd,fcntl.LOCK_EX|(0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:raise ValueError('omlx_transaction_runner_active')
        yield
    finally:os.close(fd)


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self,path):super().__init__('localhost',timeout=5);self.path=path
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout);self.sock.connect(self.path)


def permitted(request):
    try:
        info=Path(request['gateway_socket']).lstat()
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o077,'omlx_transaction_socket_unverified')
        conn=UnixHTTP(request['gateway_socket'])
        try:
            body={k:v for k,v in request.items() if k!='gateway_socket'}
            conn.request('POST','/recovery-omlx-permit',json.dumps(body),{'Content-Type':'application/json'})
            response=conn.getresponse();raw=response.read(65537)
            if response.status!=200 or len(raw)>65536:return False
            value=json.loads(raw)
            keys=('action_id','stopped_epoch','profile','demand_id') if starting(request) else ('action_id','instance','profile')
            return value.get('allowed') is True and all(value.get(k)==request[k] for k in keys)
        finally:conn.close()
    except Exception:return False


def folder_for(filename,*,create=True):
    # macOS exposes /tmp and /var through symlinked parents. The dispatcher
    # resolves its config path; an interrupted runner must use the same journal
    # and backup identity when resumed through that canonical spelling.
    filename=Path(filename)
    root=(filename.parent.resolve()/filename.name).with_suffix('.transactions')
    private_directory(root,create=create);return root


def check_row(row,config,request):
    require(isinstance(row,dict) and row.get('schema')==1 and row.get('action_id')==request['action_id']
            and row.get('request_hash')==omlx.fingerprint(request) and row.get('configuration')==omlx.fingerprint(config)
            and row.get('state') in ('pending','waiting_for_ownership','uncertain','completed')
            and row.get('phase') in ('prepared','stop_intent','stopped','launch_intent','launch_observed','completed'),
            'omlx_transaction_journal_unverified')
    before=row.get('before',{})
    if starting(request):
        require(stopped_matches(before,request) and row['phase']!='stop_intent','omlx_transaction_journal_unverified')
    else:require(isinstance(before,dict) and before.get('active') is True and before.get('listener') is True and before.get('fault') is None
            and type(before.get('pid')) is int and 2<=before['pid']<=2147483647
            and all(before.get(k)==request[k] for k in ('instance','machine','profile')),
            'omlx_transaction_journal_unverified')
    if row['phase'] in ('stopped','launch_intent','launch_observed','completed'):
        require(isinstance(row.get('stopped_epoch'),str) and DIGEST.fullmatch(row['stopped_epoch']),'omlx_transaction_journal_unverified')
        if starting(request):require(row['stopped_epoch']==request['stopped_epoch'],'omlx_transaction_journal_unverified')
    if row['phase'] in ('launch_observed','completed'):
        require(isinstance(row.get('new_instance'),str) and INSTANCE.fullmatch(row['new_instance'])
                and row['new_instance']!=request.get('instance'),'omlx_transaction_journal_unverified')
    require((row['state']=='completed')==(row['phase']=='completed'),'omlx_transaction_journal_unverified')
    require(row.get('reason') is None or (isinstance(row['reason'],str) and
            re.fullmatch(r'omlx_transaction_[a-z_]+',row['reason'])),'omlx_transaction_journal_unverified')
    if row['phase']!='prepared':require(isinstance(row.get('backup'),str),'omlx_transaction_journal_unverified')


def stopped_matches(current,request):
    return (isinstance(current,dict) and current.get('loaded') is True and current.get('stopped') is True
            and current.get('active') is False and current.get('listener') is False and current.get('fault') is None
            and current.get('pid')==0 and current.get('instance')==''
            and all(current.get(k)==request[k] for k in ('machine','profile','stopped_epoch'))
            and current.get('service_profile')==request['profile'])


def summary(row,request):
    if row is None:return {'state':'pending','action_id':request['action_id']}
    return {k:row[k] for k in ('state','phase','action_id','reason','updated_at','new_instance') if k in row}


def backup_files(config):
    base=Path(config['root'])
    return list(dict.fromkeys([base/'serve.sh',base/'state/settings.json',base/'state/model_settings.json',base/'server.pid',
           Path(config.get('launcher',base/'start.py')),*map(Path,config.get('profile_files',[]))]))


def regular_bytes(filename,private=False):
    fd=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as source:
        info=os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and (not private or
                (info.st_uid==os.getuid() and not info.st_mode&0o077)),'omlx_transaction_backup_unverified')
        return source.read()


def backup(config,root,request):
    destination=root/(request['action_id']+'.backup');private_directory(destination)
    manifest={}
    for index,file in enumerate(backup_files(config)):
        # Native profiles reject symlinks; retain those exact bytes privately.
        digest=omlx.mac.file_digest(file);data=regular_bytes(file)
        require(hashlib.sha256(data).hexdigest()==digest,'omlx_transaction_backup_changed')
        target=destination/str(index)
        if target.exists():require(hashlib.sha256(regular_bytes(target,private=True)).hexdigest()==digest,'omlx_transaction_backup_changed')
        else:
            fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
        manifest[str(file)]={'file':str(index),'sha256':digest}
    omlx.mac.atomic_save(destination/'manifest.json',manifest)
    return str(destination)


def verify_backup(config,root,request,row):
    destination=root/(request['action_id']+'.backup')
    require(row.get('backup')==str(destination),'omlx_transaction_backup_unverified')
    private_directory(destination,create=False)
    manifest=private_read(destination/'manifest.json');files=backup_files(config)
    require(isinstance(manifest,dict) and set(manifest)==set(map(str,files)),'omlx_transaction_backup_unverified')
    for index,file in enumerate(files):
        entry=manifest[str(file)]
        require(isinstance(entry,dict) and set(entry)=={'file','sha256'} and entry['file']==str(index)
                and hashlib.sha256(regular_bytes(destination/str(index),private=True)).hexdigest()==entry['sha256'],
                'omlx_transaction_backup_unverified')


def transaction_status(filename,config,input):
    """Read saved evidence only, even when current mutation permission is absent."""
    require(isinstance(input,dict) and set(input)=={'action','action_id'}
            and input['action']=='transaction-status' and isinstance(input['action_id'],str)
            and UUID.fullmatch(input['action_id']),'omlx_transaction_request_invalid')
    omlx.validate_config(config)
    missing={'state':'not_found','action_id':input['action_id']}
    try:root=folder_for(filename,create=False)
    except FileNotFoundError:return missing
    request_file=root/(input['action_id']+'.request');journal=root/(input['action_id']+'.json')
    try:saved=private_read(request_file)
    except FileNotFoundError:
        require(not journal.exists(),'omlx_transaction_journal_unverified')
        return missing
    request=saved.get('request');validate_request(request)
    require(request['action_id']==input['action_id'] and saved.get('configuration')==omlx.fingerprint(config),
            'omlx_transaction_configuration_changed')
    try:row=private_read(journal)
    except FileNotFoundError:row=None
    if row is not None:
        check_row(row,config,request)
        if row['phase']!='prepared':verify_backup(config,root,request,row)
    return {**summary(row,request),'request_hash':omlx.fingerprint(request),
            'scope':'Saved transaction evidence only; no process liveness, current health or new launch authority.'}


def run_transaction(filename,config,request,*,inspect=omlx.inspect,idle=omlx.idle,owns=permitted,
                    stop=lambda pid:os.kill(pid,signal.SIGTERM),start=omlx.start,save=omlx.mac.atomic_save,
                    checkpoint=lambda phase:None,budget=30,now=time.monotonic,sleep=time.sleep):
    validate_request(request);omlx.validate_config(config)
    require(not starting(request) or config['start_stopped'] is True,'omlx_transaction_stopped_start_not_enrolled')
    root=folder_for(filename)
    journal=root/(request['action_id']+'.json')
    # Share the established adapter's operation lock as well. An older helper
    # still observing a stop must finish before this runner can inspect/mutate.
    with lease(root/'runner.lock'),lease(Path(filename).with_suffix('.actions.json.lock')):
        row=private_read(journal) if journal.exists() else None
        if row is not None:
            check_row(row,config,request)
            if row['phase']!='prepared':verify_backup(config,root,request,row)
        if row and row['state'] in ('completed','uncertain'):return summary(row,request)
        if row is None:
            legacy=omlx.mac.load_history(Path(filename).with_suffix('.actions.json'))
            require(isinstance(legacy,dict) and all(isinstance(item,dict) and
                    item.get('identity')!=request[identity_key(request)] for item in legacy.values()),
                    'omlx_transaction_instance_already_attempted')
            current=inspect(config)
            require(stopped_matches(current,request) if starting(request) else
                    current['active'] and current['listener'] and current['fault'] is None
                    and all(current[k]==request[k] for k in ('instance','machine','profile')),'omlx_transaction_identity_changed')
            row={'schema':1,'action_id':request['action_id'],'request_hash':omlx.fingerprint(request),
                 'configuration':omlx.fingerprint(config),'before':current,'phase':'prepared','state':'pending'}
        def update(**fields):
            row.update(fields,updated_at=round(time.time()*1000));check_row(row,config,request);save(journal,row);checkpoint(row['phase'])
        def waiting(reason):
            update(state='waiting_for_ownership' if reason=='omlx_transaction_ownership_unavailable' else 'pending',reason=reason)
            return summary(row,request)
        deadline=now()+budget
        while True:
            current=inspect(config)
            require(current['machine']==request['machine'] and current['profile']==request['profile'],'omlx_transaction_identity_changed')
            if row['phase']=='prepared':
                require(current==row['before'],'omlx_transaction_identity_changed')
                if not owns(request):return waiting('omlx_transaction_ownership_unavailable')
                if not starting(request) and not idle(config):return waiting('omlx_transaction_native_busy')
                retained=backup(config,root,request)
                require(inspect(config)==current,'omlx_transaction_identity_changed')
                if not owns(request):return waiting('omlx_transaction_ownership_unavailable')
                if starting(request):
                    # A stopped endpoint cannot report native idle. Its exact
                    # stopped epoch and empty port replace that pre-launch check.
                    # Demand and physical ownership must still be live at the
                    # final launch permit, including after a controller restart.
                    update(phase='stopped',state='pending',reason=None,backup=retained,stopped_epoch=request['stopped_epoch'])
                    continue
                if not idle(config):return waiting('omlx_transaction_native_busy')
                update(phase='stop_intent',state='pending',reason=None,backup=retained)
                # Intent is durable before mutation. Changes while writing it
                # must never turn a stale PID into authority to signal.
                if not owns(request) or not idle(config) or inspect(config)!=current:
                    update(state='uncertain',reason='omlx_transaction_stop_guard_changed');return summary(row,request)
                stop(current['pid']) # Exactly one signal; the intent is never reissued.
                checkpoint('stop_issued')
            elif row['phase']=='stop_intent':
                if current['stopped'] and not current['active'] and not current['listener']:
                    update(phase='stopped',state='pending',reason=None,stopped_epoch=current['stopped_epoch'])
                elif current['active'] and current['instance']!=request['instance']:
                    update(state='uncertain',reason='omlx_transaction_external_replacement');return summary(row,request)
                elif now()>=deadline:return waiting('omlx_transaction_stop_observation_pending')
                else:sleep(.2)
            elif row['phase']=='stopped':
                require(current['stopped'] and not current['active'] and not current['listener']
                        and current['stopped_epoch']==row['stopped_epoch'],'omlx_transaction_stopped_identity_changed')
                if starting(request):require(stopped_matches(current,request),'omlx_transaction_stopped_identity_changed')
                if not owns(request):return waiting('omlx_transaction_ownership_unavailable')
                update(phase='launch_intent',state='pending',reason=None)
                if not owns(request) or inspect(config)!=current:
                    update(state='uncertain',reason='omlx_transaction_launch_guard_changed');return summary(row,request)
                launcher=start(config,journal,request['action_id']) # Existing guard and settings, unchanged.
                checkpoint('launch_issued')
                update(launcher_pid=launcher)
            elif row['phase'] in ('launch_intent','launch_observed'):
                if current['active'] and current['instance']!=request.get('instance'):
                    if row['phase']=='launch_intent':update(phase='launch_observed',state='pending',reason=None,new_instance=current['instance'])
                    require(current['instance']==row['new_instance'],'omlx_transaction_replacement_changed')
                    if current['listener'] and current['fault'] is None and idle(config):
                        update(phase='completed',state='completed',reason=None);return summary(row,request)
                elif row['phase']=='launch_observed':
                    update(state='uncertain',reason='omlx_transaction_replacement_lost');return summary(row,request)
                if now()>=deadline:return waiting('omlx_transaction_launch_observation_pending')
                sleep(.2)


def dispatch(filename,config,request,*,owns=permitted,popen=subprocess.Popen):
    validate_request(request);omlx.validate_config(config)
    require(not starting(request) or config['start_stopped'] is True,'omlx_transaction_stopped_start_not_enrolled')
    require(owns(request),'omlx_transaction_ownership_unavailable')
    root=folder_for(filename)
    with lease(root/'dispatch.lock',blocking=True):
        expected={'request':request,'configuration':omlx.fingerprint(config)}
        request_file=root/(request['action_id']+'.request')
        if request_file.exists():require(private_read(request_file)==expected,'omlx_transaction_action_conflict')
        else:
            for other in root.glob('*.request'):
                saved=private_read(other);previous=saved.get('request',{})
                validate_request(previous)
                require(other.stem==previous['action_id'] and saved.get('configuration')==omlx.fingerprint(config),'omlx_transaction_journal_unverified')
                require(previous.get(identity_key(request))!=request[identity_key(request)],'omlx_transaction_instance_already_attempted')
                result=other.with_suffix('.json')
                require(result.exists(),'omlx_transaction_other_action_unresolved')
                prior=private_read(result);check_row(prior,config,previous)
                require(prior['state']=='completed','omlx_transaction_other_action_unresolved')
                verify_backup(config,root,previous,prior)
            omlx.mac.atomic_save(request_file,expected)
        journal=root/(request['action_id']+'.json');row=private_read(journal) if journal.exists() else None
        if row is not None:
            check_row(row,config,request)
            if row['phase']!='prepared':verify_backup(config,root,request,row)
        if row and row['state'] in ('completed','uncertain'):return summary(row,request)
        try:
            with lease(root/'runner.lock'):pass
        except ValueError as error:
            if str(error)=='omlx_transaction_runner_active':return {'state':'running','action_id':request['action_id']}
            raise
        fd=os.open(root/(request['action_id']+'.log'),os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            info=os.fstat(fd);require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o077,'omlx_transaction_log_unverified')
            child=popen([sys.executable,'-I',str(Path(__file__).resolve()),str(Path(filename).resolve()),request['action_id']],
                        stdin=subprocess.DEVNULL,stdout=fd,stderr=fd,start_new_session=True,close_fds=True)
        finally:os.close(fd)
        return {'state':'running','action_id':request['action_id'],'runner_pid':child.pid}


def main():
    try:
        require(sys.platform=='darwin' and len(sys.argv)==3 and UUID.fullmatch(sys.argv[2]),'omlx_transaction_invocation_invalid')
        filename=Path(sys.argv[1]);config=omlx.mac.read_private_config(filename);omlx.validate_config(config)
        saved=private_read(folder_for(filename)/(sys.argv[2]+'.request'))
        require(saved.get('configuration')==omlx.fingerprint(config) and saved.get('request',{}).get('action_id')==sys.argv[2],'omlx_transaction_configuration_changed')
        run_transaction(filename,config,saved['request'])
        return 0
    except Exception as error:
        # The private log still receives only a reason class, never process argv.
        reason=str(error) if re.fullmatch(r'omlx_transaction_[a-z_]+',str(error)) else 'omlx_transaction_unverified'
        print(json.dumps({'error':reason}));return 1


if __name__=='__main__':sys.exit(main())
