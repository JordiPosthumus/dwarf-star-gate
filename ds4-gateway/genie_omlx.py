"""Read-only inspection of an operator-enrolled local oMLX installation."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
from datetime import datetime, timezone
import urllib.request
import urllib.parse
import urllib.error

SECRET = re.compile(r'api[_-]?key|access[_-]?token|secret|password|authorization|hf_token|hugging_face_hub_token|private[_-]?key|credential', re.I)


def scrub(value):
    if isinstance(value, dict):
        return {key: '<redacted>' if SECRET.search(key) else scrub(item) for key, item in value.items()}
    if isinstance(value, list):
        result, hide = [], False
        for item in value:
            result.append('<redacted>' if hide else scrub(item))
            hide = isinstance(item, str) and item.startswith('--') and '=' not in item and bool(SECRET.search(item))
        return result
    if isinstance(value, str) and '=' in value and SECRET.search(value.partition('=')[0]):
        return '<redacted>'
    return value


def read_file(file, limit=262144):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError('Expected a small regular file')
        return os.read(fd, limit + 1), info
    finally:
        os.close(fd)


def launcher_text(data):
    # Keep non-secret flags even when they share a line with the credential flag.
    lines = []
    for line in data.decode().splitlines():
        if not SECRET.search(line):
            lines.append(line)
        else:
            try:
                tokens = shlex.split(line)
                lines.append(shlex.join(scrub(tokens)) if any(t.startswith('--') and SECRET.search(t) for t in tokens) else '<credential-related line withheld>')
            except ValueError:
                lines.append('<credential-related line withheld>')
    return '\n'.join(lines)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def read_sources(source, paths, window=None):
    if (not isinstance(paths, list) or not 1 <= len(paths) <= 8
            or any(not isinstance(p, str) or not re.fullmatch(r'omlx/[a-zA-Z0-9_/-]+\.py', p)
                   or any(part in ['', '.', '..'] for part in p.split('/')) for p in paths)
            or len(set(paths)) != len(paths)):
        raise ValueError('Invalid source paths')
    if window is not None and (not isinstance(window,dict) or set(window)!={'offset','length'}
            or type(window['offset']) is not int or window['offset']<0
            or type(window['length']) is not int or not 1<=window['length']<=16000 or len(paths)!=1):
        raise ValueError('Source window requires one path and a valid range')
    package = source / 'omlx'
    if source.is_symlink() or package.is_symlink() or not package.is_dir():
        raise ValueError('Enrolled source checkout unavailable')
    root = package.resolve()
    files, remaining = [], 524288
    for name in paths:
        file = (source / name).resolve()
        if not file.is_relative_to(root):raise ValueError('Source outside enrolled package')
        if not file.exists():
            files.append({'path':name, 'status':'not_found'})
            continue
        data, _ = read_file(file, remaining)
        if len(data) > remaining:raise ValueError('Source request exceeds 512KiB; split the requested files across calls')
        remaining -= len(data)
        content=data.decode('utf-8')
        row={'path':name, 'status':'read', 'bytes':len(data), 'sha256':hashlib.sha256(data).hexdigest(), 'text':content}
        if window is not None:
            start=window['offset'];end=min(len(content),start+window['length'])
            if start>len(content):raise ValueError('Source offset outside file')
            row.update(text=content[start:end],window={'offset':start,'end_offset':end,'total_characters':len(content),'next_offset':end if end<len(content) else None,'complete_file':start==0 and end==len(content),'scope':'Text section by Unicode character offset; sha256 and bytes describe the full file. Request next_offset to continue.'})
        files.append(row)
    return {'status':'read', 'files':files, 'scope':'Enrolled oMLX checkout bytes on disk. No source imported or executed. Not proof of loaded code, upstream ancestry or performance. Missing means this exact path was not found.'}


def inspect_omlx(target, source_files=None, source_window=None):
    if set(target) - {'kind', 'root', 'url', 'api_key_file'} or target.get('kind') != 'omlx-local':
        raise ValueError('Invalid local inspection enrollment')
    root = Path(target['root'])
    url = urllib.parse.urlsplit(target['url'])
    if (not root.is_absolute() or root.is_symlink() or url.scheme != 'http'
            or url.hostname not in ['127.0.0.1', '::1'] or not url.port
            or url.username or url.password or url.query or url.fragment):
        raise ValueError('Use an explicit local installation and loopback endpoint')
    result = {'observed_at': datetime.now(timezone.utc).isoformat(), 'runtime': 'omlx', 'files': {}}
    for relative in ['serve.sh', 'start.py', 'state/settings.json', 'state/model_settings.json']:
        try:
            data, _ = read_file(root / relative)
            content = scrub(json.loads(data)) if relative.endswith('.json') else launcher_text(data)
            result['files'][relative] = {'sha256': hashlib.sha256(data).hexdigest(), 'content': content}
        except (OSError, ValueError):
            result['files'][relative] = {'state': 'unavailable'}
    headers = {}
    if target.get('api_key_file'):
        token, info = read_file(target['api_key_file'], 8192)
        if info.st_mode & 0o077 or not token.strip() or re.search(rb'[\x00-\x20\x7f]', token.strip()):
            raise ValueError('Invalid private endpoint credential')
        headers['Authorization'] = 'Bearer ' + token.decode().strip()
    request = urllib.request.Request(target['url'].rstrip('/') + '/models', headers=headers)
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=5) as response:
            data = response.read(262145)
            if len(data) > 262144:
                raise ValueError('Model metadata too large')
            result['models'] = scrub(json.loads(data))
            result['endpoint'] = {'state': 'connected'}
    except urllib.error.HTTPError:
        raise
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        result['models'] = None
        result['endpoint'] = {'state': 'unavailable', 'scope': 'Model discovery failed; local files below remain inspectable. This does not prove the model process stopped.'}
    try:
        raw = subprocess.check_output(['/usr/sbin/lsof', '-nP', '-iTCP:' + str(url.port), '-sTCP:LISTEN', '-Fp'], text=True, timeout=5)
        pids = sorted({int(line[1:]) for line in raw.splitlines() if re.fullmatch(r'p[0-9]+', line)})
        recorded, _ = read_file(root / 'server.pid', 32)
        result['process'] = {'listener_pids': pids, 'recorded_pid_matches_listener': int(recorded) in pids}
    except (OSError, ValueError, subprocess.SubprocessError):
        result['process'] = {'state': 'unavailable'}
    source = root / 'omlx-src'
    result['source_on_disk'] = {'revision': None, 'loaded_revision': 'not established'}
    if (source / '.git').exists():
        try:
            revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True, timeout=5).strip()
            if re.fullmatch(r'[a-f0-9]{40,64}', revision):
                dirty = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain', '--untracked-files=no'], text=True, timeout=5)
                changed = subprocess.check_output(['git', '-C', str(source), 'diff', '--name-only', '-z', 'HEAD', '--', 'omlx'], text=True, timeout=5)
                paths = [p for p in changed.split('\0') if re.fullmatch(r'omlx/[a-zA-Z0-9_/-]+\.py', p)]
                untracked = subprocess.check_output(['git', '-C', str(source), 'ls-files', '--others', '--exclude-standard', '-z', '--', 'omlx'], text=True, timeout=5)
                untracked_paths = [p for p in untracked.split('\0') if re.fullmatch(r'omlx/[a-zA-Z0-9_/-]+\.py', p)]
                result['source_on_disk'].update(revision=revision, tracked_changes=bool(dirty), changed_python_files=paths, untracked_python_files=untracked_paths)
        except (OSError, subprocess.SubprocessError):
            pass
    if source_files is not None:
        try:result['sources'] = read_sources(source, source_files, source_window)
        except (OSError, ValueError, UnicodeError):
            result['sources'] = {'status':'unavailable', 'reason':'source_read_failed', 'scope':'Request up to eight enrolled oMLX Python paths, at most 512KiB combined; split larger requests. No source conclusion available.'}
    result['scope'] = 'Endpoint discovery and listener observation where available; credential-redacted launcher/settings and source revision on disk. Unavailable endpoint evidence is explicit. These files do not prove the running process loaded their current bytes. No inference, restart, recovery, benchmark or file modification.'
    return result
