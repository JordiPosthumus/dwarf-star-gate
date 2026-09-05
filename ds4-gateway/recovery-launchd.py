#!/usr/bin/env python3
"""Fixed macOS launchd DS4 recovery adapter.

The gateway supplies only a versioned JSON action on stdin. Every path, label,
binary and port comes from an operator-owned mode-0600 config on the Mac. This
helper can inspect, start or restart exactly that enrolled launchd job. Separately
opted-in removed-job bootstrap uses pinned retained bytes and native provenance;
it cannot accept shell commands, model settings or service names from Gate Genie.
"""

import datetime
import ctypes
import fcntl
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import plistlib
import re
import selectors
import socket
import stat
import struct
import subprocess
import sys
import time


def digest(value):
    return hashlib.sha256(value).hexdigest()


def run(args, check=True):
    result = subprocess.run(args, capture_output=True, timeout=15, check=False)
    if len(result.stdout) > 1024 * 1024:
        raise ValueError("adapter_output_limit")
    if check and result.returncode:
        raise subprocess.CalledProcessError(result.returncode, args)
    return result.stdout.decode(errors="strict"), result.returncode


def private_regular(path):
    info = os.lstat(path)
    return stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)


def owned_private_regular(path):
    info = os.lstat(path)
    return (stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)
            and info.st_uid == os.getuid() and not info.st_mode & 0o077)


def owned_private_directory(path):
    info = os.lstat(path)
    return (stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
            and info.st_uid == os.getuid() and not info.st_mode & 0o022)


def file_digest(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        raise ValueError("profile_file_not_regular")
    value = hashlib.sha256()
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("profile_file_not_regular")
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            value.update(chunk)
    finally:
        os.close(fd)
    return value.hexdigest()


def target(config):
    return f"gui/{os.getuid()}/{config['label']}"


def machine_identity():
    output, _ = run(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
    match = re.search(r'"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{36})"', output)
    if not match:
        raise ValueError("machine_identity_unavailable")
    return digest(match.group(1).lower().encode())


def boot_identity():
    try:
        value, code = run(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], check=False)
        value = value.strip().lower()
        return value if code == 0 and re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value) else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def bounded_capture(command, timeout=30, max_bytes=2 * 1024 * 1024):
    """Fixed internal commands only; bound pipe bytes before storing them."""
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL)
    deadline, total, output = time.monotonic() + timeout, 0, []
    try:
        with selectors.DefaultSelector() as streams:
            streams.register(process.stdout, selectors.EVENT_READ)
            streams.register(process.stderr, selectors.EVENT_READ)
            while streams.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("capture_timeout")
                for key, _ in streams.select(remaining):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        streams.unregister(key.fileobj)
                        continue
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError("capture_output_limit")
                    if key.fileobj is process.stdout:
                        output.append(chunk)
            if process.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
                raise ValueError("capture_unavailable")
        return b"".join(output).decode("utf-8", errors="strict")
    except subprocess.TimeoutExpired:
        raise ValueError("capture_timeout") from None
    finally:
        if process.poll() is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=2)
        finally:
            process.stdout.close()
            process.stderr.close()


def removal_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})", value):
        raise ValueError("capture_incomplete")
    return int(datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def audit_native_removal(text, label, pid, boot, since, until):
    lines = text.splitlines()
    if not text.endswith("\n") or not 1 <= len(lines) <= 10001 or len(text.encode()) > 2 * 1024 * 1024:
        raise ValueError("capture_incomplete")
    rows = [json.loads(line) for line in lines]
    if (not isinstance(rows[-1], dict) or rows[-1] != {"count": len(rows) - 1, "finished": 1} or set(rows[-1]) != {"count", "finished"}
            or type(rows[-1]["count"]) is not int or type(rows[-1]["finished"]) is not int):
        raise ValueError("capture_incomplete")
    observations = set()
    for row in rows[:-1]:
        if not isinstance(row, dict) or row.get("eventType") != "logEvent":
            raise ValueError("capture_incomplete")
        at = removal_timestamp(row.get("timestamp"))
        if (row.get("subsystem") != f"gui/{os.getuid()}/{label} [{pid}]" or type(row.get("processID")) is not int or row.get("processID") != 1
                or row.get("processImagePath") != "/sbin/launchd" or row.get("senderImagePath") != "/sbin/launchd"
                or str(row.get("bootUUID", "")).lower() != boot or not since <= at <= until):
            continue
        match = re.fullmatch(r"removing job: caller = ([A-Za-z0-9_.-]{1,128})", str(row.get("eventMessage", "")))
        if match:
            caller = match[1] if match[1] in {"loginwindow", "launchctl", "runningboardd"} else "other"
            observations.add((at, caller))
    callers = {caller for _, caller in observations}
    return {"status": "conflicting_callers" if len(callers) > 1 else "exact_removal_observed" if observations else "no_exact_removal_record",
            "source_complete": True, "records": len(rows) - 1,
            "observations": [{"at": at, "caller": caller} for at, caller in sorted(observations)[-16:]],
            "observations_omitted": max(0, len(observations) - 16),
            "native_stop_caller_observed": "launchctl" in callers}


def inspect_removal(config, prior):
    checked = round(time.time() * 1000)
    result = {"version": 1, "source": "native_launchd", "authority": "none", "checked_at": checked,
              "status": "prior_identity_unverified", "source_complete": False, "records": 0,
              "observations": [], "observations_omitted": 0, "native_stop_caller_observed": False}
    fields = {"instance", "machine", "profile", "service_profile", "pid", "started_at", "observed_at", "boot_uuid"}
    if (not isinstance(prior, dict) or set(prior) != fields
            or any(not isinstance(prior[k], str) or not re.fullmatch(r"[a-f0-9]{64}", prior[k]) for k in ("machine", "profile", "service_profile"))
            or not isinstance(prior["boot_uuid"], str) or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", prior["boot_uuid"])
            or type(prior["pid"]) is not int or not 2 <= prior["pid"] <= 2147483647
            or any(type(prior[k]) is not int for k in ("started_at", "observed_at"))
            or not 0 <= prior["started_at"] <= prior["observed_at"] <= checked):
        return result
    instance = digest(json.dumps({"label": config["label"], "machine": prior["machine"], "pid": prior["pid"], "started_at": prior["started_at"]}, sort_keys=True).encode())[:32]
    if prior["instance"] != instance:
        return result
    try:
        if machine_identity() != prior["machine"]:
            return {**result, "status": "machine_changed"}
        if boot_identity() != prior["boot_uuid"]:
            return {**result, "status": "boot_unverified_or_changed"}
        if service_profile(config) != prior["service_profile"]:
            return {**result, "status": "service_profile_changed"}
        if launch_state(config).get("registration") != "absent":
            return {**result, "status": "job_not_absent"}
        since = max(prior["observed_at"], checked - 4 * 3600000)
        dates = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S+0000")
        predicate = f'processID == 1 AND processImagePath == "/sbin/launchd" AND subsystem == "gui/{os.getuid()}/{config["label"]} [{prior["pid"]}]"'
        text = bounded_capture(["/usr/bin/log", "show", "--style", "ndjson", "--start", dates(since), "--end", dates(checked + 1000), "--predicate", predicate])
        evidence = audit_native_removal(text, config["label"], prior["pid"], prior["boot_uuid"], since, checked)
        if (boot_identity() != prior["boot_uuid"] or launch_state(config).get("registration") != "absent"
                or service_profile(config) != prior["service_profile"]):
            return {**result, "status": "identity_changed_during_capture"}
        return {**result, **evidence}
    except Exception as error:
        reason = str(error) if str(error) in {"capture_timeout", "capture_output_limit", "capture_unavailable"} else "capture_incomplete"
        return {**result, "status": reason}


def service_profile(config):
    files = {str(Path(p).resolve()): file_digest(p) for p in config["profile_files"]}
    files[str(Path(config["binary"]).resolve())] = file_digest(config["binary"])
    value = {
        "binary": str(Path(config["binary"]).resolve()),
        "files": files,
        "label": config["label"],
        "plist": {
            "path": str(Path(config["plist"]).resolve()),
            "sha256": file_digest(config["plist"]),
        },
        "port": config["port"],
    }
    return digest(json.dumps(value, sort_keys=True).encode())


class UniquePlistDict(dict):
    def __setitem__(self, key, value):
        if key in self:
            raise ValueError("retained_definition_ambiguous")
        super().__setitem__(key, value)


def retained_definition(config):
    """Return verified bytes, never rewritten launch settings or action authority."""
    expected = config.get("retained_definition_sha256")
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("retained_definition_not_enrolled")
    filename = Path(config["plist"])
    try:
        # Enrollment uses a canonical private copy, not a transient launchctl path.
        if not filename.is_absolute() or filename.resolve(strict=True) != filename or not owned_private_directory(filename.parent):
            raise ValueError("retained_definition_not_private")
        fd = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                    or before.st_mode & 0o077 or not 0 < before.st_size <= 1024 * 1024):
                raise ValueError("retained_definition_not_private_or_bounded")
            raw = os.read(fd, before.st_size + 1)
            after = os.fstat(fd)
            signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_uid, s.st_mode)
            if signature(before) != signature(after) or len(raw) != before.st_size:
                raise ValueError("retained_definition_changed_during_read")
        finally:
            os.close(fd)
    except OSError:
        raise ValueError("retained_definition_unavailable") from None
    if digest(raw) != expected:
        raise ValueError("retained_definition_digest_mismatch")
    try:
        if raw.startswith(b"bplist00"):
            # Bound counts before plistlib can allocate from attacker-sized fields.
            width, ref_width, count, top, table = struct.unpack(">6xBBQQQ", raw[-32:])
            if (not 1 <= width <= 8 or not 1 <= ref_width <= 8 or not 0 < count <= len(raw)
                    or not 0 <= top < count or not 8 <= table < len(raw) - 32
                    or table + count * width > len(raw) - 32):
                raise ValueError()
        definition = plistlib.loads(raw, dict_type=UniquePlistDict)
        if not isinstance(definition, dict) or definition.get("Label") != config["label"]:
            raise ValueError()
        program, args = definition.get("Program"), definition.get("ProgramArguments")
        valid_string = lambda s: isinstance(s, str) and bool(s) and "\0" not in s
        if program is not None and (not valid_string(program) or not program.startswith("/")):
            raise ValueError()
        if args is not None and (not isinstance(args, list) or not 1 <= len(args) <= 4096 or not all(isinstance(s, str) and "\0" not in s for s in args)):
            raise ValueError()
        if program is None and (args is None or not args[0].startswith("/")):
            raise ValueError()
        if "Disabled" in definition and type(definition["Disabled"]) is not bool:
            raise ValueError()
    except Exception:
        # plist parser failures must never echo private launch arguments or values.
        raise ValueError("retained_definition_invalid") from None
    if definition.get("Disabled") is True:
        raise ValueError("retained_definition_disabled")
    return raw


def inspect_definition(config):
    if "retained_definition_sha256" not in config:
        return {"version": 1, "enrolled": False, "verified": False, "authority": "none", "reason": "retained_definition_not_enrolled"}
    try:
        raw = retained_definition(config)
    except ValueError as error:
        allowed = {"retained_definition_not_enrolled", "retained_definition_not_private", "retained_definition_not_private_or_bounded",
                   "retained_definition_changed_during_read", "retained_definition_unavailable", "retained_definition_digest_mismatch",
                   "retained_definition_invalid", "retained_definition_disabled"}
        reason = str(error) if str(error) in allowed else "retained_definition_unverified"
        return {"version": 1, "enrolled": True, "verified": False, "authority": "none", "reason": reason}
    return {"version": 1, "enrolled": True, "verified": True, "authority": "none",
            "scope": "pinned_definition_only", "definition_bytes": len(raw)}


def bootstrap_definition(config):
    raw = retained_definition(config)
    definition = plistlib.loads(raw, dict_type=UniquePlistDict)
    # A standalone preserved plist must start when registered. Do not rewrite
    # demand-only/bundle-relative definitions to make them fit this action.
    if ("BundleProgram" in definition or "RootDirectory" in definition
            or not (definition.get("RunAtLoad") is True or definition.get("KeepAlive") is True)):
        raise ValueError("bootstrap_definition_requires_review")
    return raw


def require_bootstrap_identity(config, prior):
    if (machine_identity() != prior["machine"] or boot_identity() != prior["boot_uuid"]
            or service_profile(config) != prior["service_profile"]
            or launch_state(config).get("registration") != "absent"):
        raise ValueError("removed_service_identity_changed")
    require_native_enabled(config)
    if port_occupied(config["port"]):
        raise ValueError("bootstrap_port_occupied")


def stage_bootstrap_definition(state_path, action_id, raw):
    # Fixed private sibling, never a request-supplied path. Preserve bytes rather
    # than reserialize. Keep the file after issuance: launchd may retain its path.
    filename = state_path.parent / f"bootstrap-{action_id}.plist"
    if not owned_private_directory(filename.parent):
        raise ValueError("adapter_directory_must_be_private")
    fd = os.open(filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o400)
    with os.fdopen(fd, "wb") as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
    fd = os.open(filename.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return filename


def bootstrap_removed(config, request, state_path, history, request_hash):
    if config.get("bootstrap_removed") is not True:
        raise ValueError("bootstrap_not_enrolled")
    if request["definition_sha256"] != config.get("retained_definition_sha256"):
        raise ValueError("bootstrap_definition_enrollment_changed")
    prior = request["prior"]
    # This independently validates the complete prior identity and queries the
    # native OS. A caller name is evidence, not proof that removal was accidental.
    removal = inspect_removal(config, prior)
    observations = removal["observations"]
    if (removal["status"] != "exact_removal_observed" or removal["source_complete"] is not True
            or removal["observations_omitted"] != 0 or len(observations) != 1):
        raise ValueError("bootstrap_exact_removal_required")
    caller = observations[0]["caller"]
    allowed = config.get("bootstrap_callers", [])
    if not (caller in allowed or (request["canary"] is True and caller == "launchctl")):
        raise ValueError("bootstrap_removal_caller_not_enrolled")
    if any(item.get("operation") == "bootstrap" and item.get("instance") == prior["instance"] for item in history.values()):
        raise ValueError("removed_instance_already_attempted")
    raw = bootstrap_definition(config)
    require_bootstrap_identity(config, prior)
    staged = stage_bootstrap_definition(state_path, request["action_id"], raw)
    receipt = {"request_hash": request_hash, "operation": "bootstrap", "instance": prior["instance"],
               "definition_sha256": request["definition_sha256"], "issued_at": round(time.time() * 1000), "state": "intent"}
    history[request["action_id"]] = receipt
    atomic_save(state_path, history)
    # Both original and staged bytes are checked again after durable intent.
    # Unknown acknowledgement or a final veto leaves intent, never blind retry.
    if bootstrap_definition(config) != raw or retained_definition({**config, "plist": str(staged)}) != raw:
        raise ValueError("bootstrap_definition_changed_before_issue")
    require_bootstrap_identity(config, prior)
    run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(staged)])
    receipt["state"] = "issued"
    atomic_save(state_path, history)
    return receipt


def parse_launchctl(output):
    def value(name):
        match = re.search(rf"^\s*{re.escape(name)}\s*=\s*([^\n]+)\s*$", output, re.MULTILINE)
        return match.group(1).strip() if match else None
    state_value = value("state")
    pid_value = value("pid")
    runs_value = value("runs")
    exit_value = value("last exit code")
    if pid_value is not None and (not pid_value.isascii() or not pid_value.isdigit() or len(pid_value) > 10
                                  or int(pid_value) == 1 or not 0 <= int(pid_value) <= 2147483647):
        raise ValueError("service_pid_unverified")
    pid = int(pid_value) if pid_value and pid_value.isdigit() else 0
    return {
        "state": state_value,
        "pid": pid,
        "runs": int(runs_value) if runs_value and runs_value.isdigit() else None,
        "last_exit": int(exit_value) if exit_value and re.fullmatch(r"-?\d+", exit_value) else None,
    }


def launch_state(config):
    unknown = {"loaded": None, "active": False, "stopped": False, "pid": 0,
               "state": None, "runs": None, "last_exit": None, "registration": "unverified"}
    output, code = run(["/bin/launchctl", "print", target(config)], check=False)
    # Observed launchctl codes distinguish missing service (113) from missing
    # GUI domain (112). They are diagnostic evidence, never bootstrap authority.
    # print is not a stable API: unfamiliar output/codes must remain unknown.
    if code == 113:
        domain = f"gui/{os.getuid()}"
        domain_output, domain_code = run(["/bin/launchctl", "print", domain], check=False)
        if domain_code == 112:
            return {**unknown, "registration": "gui_domain_unavailable"}
        if domain_code or not domain_output.startswith(domain + " = {\n") or not domain_output.rstrip().endswith("}"):
            return unknown
        # A job may have appeared while the domain was being inspected.
        output, code = run(["/bin/launchctl", "print", target(config)], check=False)
        if code == 113:
            return {**unknown, "loaded": False, "registration": "absent"}
    if code == 112:
        return {**unknown, "registration": "gui_domain_unavailable"}
    if code:
        return unknown
    try:
        parsed = parse_launchctl(output)
    except ValueError:
        return unknown
    if parsed["state"] is None:
        return unknown
    active = parsed["state"] == "running" and parsed["pid"] >= 2
    stopped = parsed["pid"] == 0 and parsed["state"] in {"not running", "exited"}
    return {**parsed, "loaded": True, "active": active, "stopped": stopped, "registration": "loaded"}


def stopped_epoch(state, config):
    value = {key: state.get(key) for key in ("state", "runs", "last_exit")}
    value["label"] = config["label"]
    return digest(json.dumps(value, sort_keys=True).encode())


def parse_disabled(output, label):
    """Read only the exact native override; absence is not general start consent."""
    lines = output.strip().splitlines()
    if len(lines) < 2 or lines[0].strip() != "disabled services = {" or lines[-1].strip() != "}":
        return None
    entries = {}
    for line in lines[1:-1]:
        match = re.fullmatch(r'\s*("(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*") => (enabled|disabled)\s*', line)
        if not match:
            return None
        name = json.loads(match.group(1))
        if name in entries:
            return None
        entries[name] = match.group(2) == "disabled"
    return entries.get(label, False)


def native_disabled(config):
    try:
        output, code = run(["/bin/launchctl", "print-disabled", f"gui/{os.getuid()}"], check=False)
        return parse_disabled(output, config["label"]) if code == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def require_native_enabled(config):
    disabled = native_disabled(config)
    if disabled is not False:
        raise ValueError("launchd_native_disabled" if disabled is True else "launchd_disable_state_unverified")


def process_executable(pid):
    # lsof's txt mappings include shared libraries, not just the executable.
    # Ask the kernel directly using libproc's fixed-size proc_pidpath API.
    if type(pid) is not int or not 2 <= pid <= 2147483647:
        raise ValueError("service_executable_unverified")
    try:
        query = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidpath
        query.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        query.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer(4096)
        size = query(pid, buffer, len(buffer))
        if not 0 < size < len(buffer) or len(buffer.value) != size:
            raise ValueError("service_executable_unverified")
        value = buffer.value.decode("utf-8", errors="strict")
        if not value.startswith("/"):
            raise ValueError("service_executable_unverified")
        return value
    except (OSError, AttributeError, UnicodeError):
        raise ValueError("service_executable_unverified")


def process_info(pid):
    executable = process_executable(pid)
    started_text, _ = run(["/bin/ps", "-p", str(pid), "-o", "lstart="])
    command, _ = run(["/bin/ps", "-ww", "-p", str(pid), "-o", "command="])
    try:
        started_at = round(time.mktime(time.strptime(started_text.strip(), "%a %b %d %H:%M:%S %Y")) * 1000)
    except (ValueError, OverflowError):
        raise ValueError("service_start_time_unverified")
    if not command.strip():
        raise ValueError("service_command_unverified")
    checked_start, _ = run(["/bin/ps", "-p", str(pid), "-o", "lstart="])
    if checked_start.strip() != started_text.strip():
        raise ValueError("service_start_time_changed")
    if process_executable(pid) != executable:
        raise ValueError("service_executable_changed")
    return {"executable": executable, "started_at": started_at, "command": command.rstrip("\n")}


def port_occupied(port):
    """Conservative stopped-service check, without connecting or listening.

    A non-reusing bind detects wildcard/loopback listeners and bound sockets
    regardless of process ownership. Unknown socket errors fail inspection.
    This is sampled evidence, not an atomic reservation through service launch.
    """
    probes = []
    try:
        for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
            try:
                probe = socket.socket(family, socket.SOCK_STREAM)
            except OSError as error:
                if family == socket.AF_INET6 and error.errno == errno.EAFNOSUPPORT:
                    continue
                raise
            probes.append(probe)
            if family == socket.AF_INET6:
                probe.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            try:
                probe.bind((address, port))
            except OSError as error:
                if error.errno == errno.EADDRINUSE:
                    return True
                raise
        return False
    finally:
        for probe in probes:
            probe.close()


def owns_listener(pid, port):
    output, code = run(["/usr/sbin/lsof", "-nP", "-a", "-p", str(pid), f"-iTCP:{port}", "-sTCP:LISTEN", "-Fn"], check=False)
    if code:
        return False
    names = [line[1:] for line in output.splitlines() if line.startswith("n")]
    return any(name in {f"127.0.0.1:{port}", f"[::1]:{port}"} for name in names)


def local_log_time(line, now_ms):
    match = re.match(r"^(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2}) ds4-server: ", line)
    if not match:
        return None
    month, day, hour, minute, second = map(int, match.groups())
    current = datetime.datetime.fromtimestamp(now_ms / 1000)
    candidates = []
    for year in (current.year - 1, current.year, current.year + 1):
        try:
            value = datetime.datetime(year, month, day, hour, minute, second)
        except ValueError:
            continue
        candidates.append(round(value.timestamp() * 1000))
    return min(candidates, key=lambda value: abs(value - now_ms)) if candidates else None


def fault_evidence(lines, started_at, now_ms=None):
    now_ms = round(time.time() * 1000) if now_ms is None else now_ms
    fault = None
    progress = 0
    for line in lines.splitlines():
        if len(line) > 65536:
            continue
        at = local_log_time(line, now_ms)
        if at is None or at < started_at - 5000 or at > now_ms + 5000:
            continue
        message = re.sub(r"^\d{4} \d{2}:\d{2}:\d{2} ds4-server: ", "", line, count=1)
        if re.match(r"^ds4: CUDA [^\n]{0,160}(?:an illegal memory access was encountered|device-side assert)", message):
            fault = {"at": at, "reason": "fatal_accelerator_error"}
        if re.search(r"chat ctx=.*decoding chunk=", message):
            progress = max(progress, at)
    return fault if fault and progress <= fault["at"] else None


def read_log_tail(path):
    if path is None:
        return ""
    if not private_regular(path):
        raise ValueError("engine_log_not_regular")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("engine_log_not_regular")
        size = info.st_size
        start = max(0, size - 1024 * 1024)
        os.lseek(fd, start, os.SEEK_SET)
        data = os.read(fd, 1024 * 1024)
    finally:
        os.close(fd)
    text = data.decode(errors="replace")
    return text.split("\n", 1)[1] if start and "\n" in text else "" if start else text


def runtime_profile(static_profile, command):
    return digest(json.dumps({"service_profile": static_profile, "command": digest(command.encode())}, sort_keys=True).encode())


def inspect(config):
    machine = machine_identity()
    static_profile = service_profile(config)
    state = launch_state(config)
    base = {
        "version": 1,
        "machine": machine,
        "service_profile": static_profile,
        "loaded": state["loaded"],
        "registration": state.get("registration"),
        "stopped": state["stopped"],
        "stopped_epoch": stopped_epoch(state, config) if state["loaded"] and state["stopped"] else None,
        "instance": "",
        "pid": state["pid"],
        "active": state["active"],
        "listener": False,
        "native_disabled": native_disabled(config),
        "boot_uuid": boot_identity(),
        "removal_capture_version": 1,
        **({"bootstrap": {"version": 1, "definition_sha256": config["retained_definition_sha256"],
                          "callers": config.get("bootstrap_callers", [])}} if config.get("bootstrap_removed") is True else {}),
    }
    if not state["active"]:
        if state["loaded"] is None:
            return {**base, "listener": None}
        return {**base, "listener": port_occupied(config["port"])}
    process = process_info(state["pid"])
    if str(Path(process["executable"]).resolve()) != str(Path(config["binary"]).resolve()):
        raise ValueError("service_executable_mismatch")
    listener = owns_listener(state["pid"], config["port"])
    instance = digest(json.dumps({"label": config["label"], "machine": machine, "pid": state["pid"], "started_at": process["started_at"]}, sort_keys=True).encode())[:32]
    return {
        **base,
        "profile": runtime_profile(static_profile, process["command"]),
        "instance": instance,
        "started_at": process["started_at"],
        "listener": listener,
        "fault": fault_evidence(read_log_tail(config.get("log_file")), process["started_at"]),
    }


def atomic_save(filename, value):
    if not owned_private_directory(filename.parent):
        raise ValueError("adapter_directory_must_be_private")
    temp = Path(str(filename) + f".{os.getpid()}.{os.urandom(6).hex()}.tmp")
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temp, flags, 0o600)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, filename)
    finally:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass
    fd = os.open(filename.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def load_history(state_path):
    if not state_path.exists():
        return {}
    if not owned_private_directory(state_path.parent) or not owned_private_regular(state_path):
        raise ValueError("adapter_journal_must_be_private")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(state_path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 8 * 1024 * 1024:
            raise ValueError("adapter_journal_invalid")
        raw = os.read(fd, info.st_size + 1)
    finally:
        os.close(fd)
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("adapter_journal_invalid")
    return value


def handle(config, request, state_path):
    if request == {"action": "inspect"}:
        return inspect(config)
    if request == {"action": "inspect_definition"}:
        return inspect_definition(config)
    if isinstance(request, dict) and set(request) == {"action", "prior"} and request["action"] == "inspect_removal":
        return inspect_removal(config, request["prior"])
    restart_fields = {"action", "action_id", "instance", "machine", "profile", "canary", "fault_after"}
    start_fields = {"action", "action_id", "stopped_epoch", "machine", "service_profile"}
    bootstrap_fields = {"action", "action_id", "prior", "definition_sha256", "canary"}
    action = request.get("action")
    expected = restart_fields if action == "restart" else start_fields if action == "start" else bootstrap_fields if action == "bootstrap" else set()
    action_id = request.get("action_id", "")
    if (set(request) != expected
            or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", action_id)):
        raise ValueError("invalid_adapter_request")
    if action == "bootstrap" and (type(request["canary"]) is not bool or not isinstance(request["prior"], dict)
            or not isinstance(request["definition_sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", request["definition_sha256"])):
        raise ValueError("invalid_adapter_request")
    if action == "restart" and (type(request["canary"]) is not bool
            or type(request["fault_after"]) not in (int, float)
            or not math.isfinite(request["fault_after"]) or request["fault_after"] < 0):
        raise ValueError("invalid_adapter_request")
    lock_flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    lock_fd = os.open(str(state_path) + ".lock", lock_flags, 0o600)
    lock_info = os.fstat(lock_fd)
    if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_mode & 0o077:
        os.close(lock_fd)
        raise ValueError("adapter_lock_must_be_private")
    with os.fdopen(lock_fd, "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        history = load_history(state_path)
        previous = history.get(request["action_id"])
        request_hash = digest(json.dumps(request, sort_keys=True).encode())
        if previous:
            if previous["request_hash"] != request_hash:
                raise ValueError("action_id_conflict")
            return previous
        if len(history) >= 10000:
            raise ValueError("adapter_journal_full_review_required")
        if action == "bootstrap":
            return bootstrap_removed(config, request, state_path, history, request_hash)
        current = inspect(config)
        if action == "restart":
            if not current["active"] or not current["listener"] or any(current.get(key) != request[key] for key in ("instance", "machine", "profile")):
                raise ValueError("service_identity_changed")
            if not request["canary"] and (not current.get("fault") or current["fault"]["at"] < request["fault_after"]):
                raise ValueError("current_fatal_evidence_required")
            if any(item.get("instance") == current["instance"] for item in history.values()):
                raise ValueError("instance_already_attempted")
        else:
            if (current.get("active") or current.get("listener") or not current.get("loaded") or not current.get("stopped")
                    or any(current.get(key) != request[key] for key in ("stopped_epoch", "machine", "service_profile"))):
                raise ValueError("stopped_service_identity_changed")
            if any(item.get("operation") == "start" and item.get("stopped_epoch") == current["stopped_epoch"] for item in history.values()):
                raise ValueError("stopped_epoch_already_attempted")
        require_native_enabled(config)
        receipt = {
            "request_hash": request_hash,
            "operation": action,
            "instance": current.get("instance"),
            "stopped_epoch": current.get("stopped_epoch"),
            "issued_at": round(time.time() * 1000),
            "state": "intent",
        }
        history[request["action_id"]] = receipt
        atomic_save(state_path, history)
        # Recheck after the durable write. A changed native stop instruction
        # vetoes issuance; the intent receipt still prevents blind reissue.
        require_native_enabled(config)
        command = ["/bin/launchctl", "kickstart"] + (["-k"] if action == "restart" else []) + [target(config)]
        run(command)
        receipt["state"] = "issued"
        atomic_save(state_path, history)
        return receipt


def validate_config(config_path, config):
    required = {"label", "plist", "port", "binary", "profile_files"}
    if (not isinstance(config, dict) or not required.issubset(config) or set(config) - (required | {"log_file", "retained_definition_sha256", "bootstrap_removed", "bootstrap_callers"})
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", config.get("label", ""))
            or type(config.get("port")) is not int or not 1 <= config["port"] <= 65535
            or any(not isinstance(config.get(field), str) or not config[field].startswith("/") or "\0" in config[field] for field in ("plist", "binary"))
            or not isinstance(config.get("profile_files"), list) or not 1 <= len(config["profile_files"]) <= 32
            or len(set(config["profile_files"])) != len(config["profile_files"])
            or any(not isinstance(value, str) or not value.startswith("/") or "\0" in value for value in config["profile_files"])
            or ("retained_definition_sha256" in config and (not isinstance(config["retained_definition_sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", config["retained_definition_sha256"])))
            or (config.get("log_file") is not None and (not isinstance(config["log_file"], str) or not config["log_file"].startswith("/") or "\0" in config["log_file"]))):
        raise ValueError("invalid_adapter_configuration")
    if ("bootstrap_removed" in config and type(config["bootstrap_removed"]) is not bool
            or "bootstrap_callers" in config and (not isinstance(config["bootstrap_callers"], list)
                or any(c not in ("loginwindow", "runningboardd") for c in config["bootstrap_callers"])
                or len(config["bootstrap_callers"]) != len(set(config["bootstrap_callers"])))
            or config.get("bootstrap_removed") is True and "retained_definition_sha256" not in config
            or config.get("bootstrap_callers") and config.get("bootstrap_removed") is not True):
        raise ValueError("invalid_bootstrap_configuration")
    if not owned_private_directory(config_path.parent) or not owned_private_regular(config_path):
        raise ValueError("adapter_configuration_must_be_private")


def read_private_config(config_path):
    if not owned_private_directory(config_path.parent) or not owned_private_regular(config_path):
        raise ValueError("adapter_configuration_must_be_private")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(config_path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 65536:
            raise ValueError("invalid_adapter_configuration")
        raw = os.read(fd, info.st_size + 1)
    finally:
        os.close(fd)
    return json.loads(raw)


def main():
    config_path = Path(sys.argv[1])
    config = read_private_config(config_path)
    validate_config(config_path, config)
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise ValueError("adapter_input_limit")
    print(json.dumps(handle(config, json.loads(raw), config_path.with_suffix(".actions.json"))))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Private paths, launchd output, commands and engine log lines stay local.
        print(json.dumps({"error": "adapter_check_or_operation_failed"}))
        sys.exit(1)
