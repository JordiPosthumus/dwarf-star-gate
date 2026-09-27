"""Private password transport. Input arrives over stdin; no terminal transcript is saved.

Run as an isolated, single-threaded Python process: pty.fork is not mixed with
the dashboard/Hermes networking runtime. See docs.python.org/3/library/pty.html.
"""
import errno
import ipaddress
import json
import os
import pty
import re
import select
import shlex
import signal
import stat
import sys
import termios
import time

MARKER = b'DSG_ACCESS_RESULT='


def run(payload, *, timeout=45, execute=os.execvp):
    if set(payload) != {'ssh', 'known_hosts', 'password', 'code'}:
        raise ValueError('Invalid private SSH request')
    user, separator, host = payload['ssh'].partition('@')
    if not separator or not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_-]{0,63}', user):
        raise ValueError('Invalid private SSH destination')
    address = ipaddress.ip_address(host)
    if address.version != 4 or not address.is_private or address.is_loopback:
        raise ValueError('Use the discovered private IPv4 destination')
    password = payload['password']
    if not isinstance(password, str) or not 1 <= len(password.encode()) <= 1024 or any(c in password for c in '\r\n\0'):
        raise ValueError('Unsupported password input')
    known = payload['known_hosts']
    info = os.lstat(known)
    if not os.path.isabs(known) or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('Pinned SSH trust is unavailable')
    code = payload['code']
    if not isinstance(code, str) or len(code) > 131072:
        raise ValueError('Invalid private SSH operation')
    options = ['BatchMode=no', 'ConnectTimeout=10', 'ConnectionAttempts=1', 'NumberOfPasswordPrompts=1',
               'PreferredAuthentications=password', 'PubkeyAuthentication=no', 'KbdInteractiveAuthentication=no',
               'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null', 'VerifyHostKeyDNS=no',
               'UpdateHostKeys=no', 'KnownHostsCommand=none', 'ControlMaster=no', 'ControlPath=none', 'ForwardAgent=no',
               'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'ProxyCommand=none', 'ProxyJump=none', 'UserKnownHostsFile=' + known]
    args = ['ssh', '-T'] + [piece for option in options for piece in ('-o', option)]
    args += ['--', payload['ssh'], 'python3 -I -B -c ' + shlex.quote(code)]
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.environ['LC_ALL'] = 'C'
            execute(args[0], args)
        finally:
            os._exit(127)
    output = bytearray()
    sent = False
    finished = False
    status = None
    failure = None
    deadline = time.monotonic() + timeout
    try:
        settings = termios.tcgetattr(master)
        settings[3] &= ~termios.ECHO
        termios.tcsetattr(master, termios.TCSANOW, settings)
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], min(.2, max(0, deadline - time.monotonic())))
            if ready:
                try:
                    chunk = os.read(master, 8192)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b''
                if not chunk:
                    while time.monotonic() < deadline:
                        done, child_status = os.waitpid(pid, os.WNOHANG)
                        if done:
                            finished, status = True, child_status
                            break
                        time.sleep(.01)
                    break
                output.extend(chunk)
                if len(output) > 262144:
                    failure = 'output_limit'
                    break
                if not sent and re.search(rb'password:\s*$', output[-1024:], re.IGNORECASE):
                    os.write(master, password.encode() + b'\n')
                    sent = True
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                finished, status = True, child_status
                # Read any remaining result bytes before interpreting the exit.
                while select.select([master], [], [], 0)[0]:
                    try:
                        chunk = os.read(master, 8192)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output.extend(chunk)
                    if len(output) > 262144:
                        failure = 'output_limit'
                        break
                break
        if not finished:
            done, status = os.waitpid(pid, os.WNOHANG)
            finished = bool(done)
        if not finished:
            failure = failure or 'observation_timeout'
        if failure or not finished or not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
            if b'HOST IDENTIFICATION HAS CHANGED' in output or b'Host key verification failed' in output:
                failure = 'host_key_unverified'
            return {'ok': False, 'reason': failure or 'ssh_access_unconfirmed'}
        matches = re.findall(re.escape(MARKER) + rb'([^\r\n]+)', bytes(output))
        if len(matches) != 1:
            return {'ok': False, 'reason': 'result_unconfirmed'}
        result = json.loads(matches[0])
        return {'ok': True, 'result': result}
    finally:
        os.close(master)
        if not finished:
            # Only the SSH child created above is terminated. Remote mutation may
            # have happened; the caller must verify key access before any retry.
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        output.clear()


def interrupted(_signal, _frame):
    # Unwind run() so its exact owned SSH child is reaped on outer cancellation.
    raise InterruptedError('Private transport interrupted')


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    try:
        raw = sys.stdin.buffer.read(262145)
        if len(raw) > 262144:
            raise ValueError('Request too large')
        response = run(json.loads(raw))
    except Exception:
        response = {'ok': False, 'reason': 'private_transport_unavailable'}
    print(json.dumps(response))
