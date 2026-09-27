"""Host identity and saved-artifact readers for fleet operations."""
import hashlib,json,os,re,stat,subprocess
from pathlib import Path

def peer_parameters(target):
    aliases=target.get('ssh',[])
    if not isinstance(aliases,list) or not aliases or not re.fullmatch(r'[A-Za-z0-9][\w.@-]{0,252}',aliases[0]):raise ValueError('Use an enrolled SSH peer')
    alias=aliases[0]
    resolved=subprocess.run(['ssh','-G',alias],text=True,capture_output=True,timeout=10,check=True)
    fields=dict(line.split(' ',1) for line in resolved.stdout.splitlines() if ' ' in line)
    host,user,port=fields.get('hostname',''),fields.get('user',''),fields.get('port','22')
    if not re.fullmatch(r'[A-Za-z0-9][\w.-]{0,252}',host) or not re.fullmatch(r'[A-Za-z0-9_][\w.-]{0,63}',user) or not port.isdigit() or not 1<=int(port)<=65535:raise ValueError('Direct peer destination unavailable')
    command="python3 -c 'import hashlib,pathlib; print(hashlib.sha256(pathlib.Path(\"/etc/machine-id\").read_bytes()).hexdigest()); print(pathlib.Path(\"/etc/ssh/ssh_host_ed25519_key.pub\").read_text().strip())'"
    result=subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ConnectTimeout=8',alias,command],text=True,capture_output=True,timeout=15,check=True)
    parts=result.stdout.strip().splitlines();fingerprint=parts[0] if parts else '';key=parts[1].split()[:2] if len(parts)==2 else []
    if not re.fullmatch(r'[a-f0-9]{64}',fingerprint) or len(key)!=2 or key[0]!='ssh-ed25519' or not re.fullmatch(r'[A-Za-z0-9+/=]{40,200}',key[1]):raise ValueError('Peer machine/host-key identity unavailable')
    known_host=host if int(port)==22 else '['+host+']:'+port
    return {'destination':user+'@'+host,'port':int(port),'machine_sha256':fingerprint,'known_hosts':known_host+' '+' '.join(key)+'\n'}

def read_json(file, expected_sha256=None):
    fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size>1024*1024:
            raise ValueError('Invalid record file')
        with os.fdopen(fd,'rb',closefd=False) as stream:data=stream.read(st.st_size)
        if expected_sha256 is not None and hashlib.sha256(data).hexdigest()!=expected_sha256:
            raise ValueError('Artifact no longer matches the recorded hash')
        return json.loads(data)
    finally:os.close(fd)

def read_artifact_reference(root, reference):
    raw=reference.get('path');expected=reference.get('sha256')
    if not isinstance(raw,str) or not isinstance(expected,str) or not re.fullmatch(r'[a-f0-9]{64}',expected):raise ValueError('Missing artifact reference/hash')
    root=root.absolute();file=Path(raw);file=file if file.is_absolute() else root/file
    relative=file.relative_to(root)
    if '..' in relative.parts or not relative.parts or relative.parts[0]!='artifacts':raise ValueError('Artifact outside library')
    cursor=root
    for part in relative.parts:
        cursor=cursor/part
        if cursor.is_symlink():raise ValueError('Symlink artifact')
    return read_json(file,expected)

def reference_at(document, pointer):
    """Select an existing JSON reference, never a caller-supplied file or hash."""
    if not isinstance(pointer,str) or not pointer.startswith('/') or re.search(r'~(?![01])',pointer):
        raise ValueError('Use a JSON pointer to a recorded artifact reference')
    value=document
    for part in pointer[1:].split('/'):
        key=part.replace('~1','/').replace('~0','~')
        if isinstance(value,list):
            if not re.fullmatch(r'0|[1-9][0-9]*',key):raise ValueError('Invalid reference index')
            value=value[int(key)]
        elif isinstance(value,dict):value=value[key]
        else:raise ValueError('Missing recorded reference')
    if not isinstance(value,dict):raise ValueError('A recorded path and SHA256 reference is required')
    return value
