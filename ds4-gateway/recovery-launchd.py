#!/usr/bin/env python3
"""Fixed macOS launchd DS4 recovery adapter.

The gateway supplies only a versioned JSON action on stdin. Every path, label,
binary and port comes from an operator-owned mode-0600 config on the Mac. This
helper can inspect, start or restart exactly that enrolled launchd job; it cannot
accept shell commands, model settings or service names from Gate Genie.
"""

import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
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


def parse_launchctl(output):
    def value(name):
        match = re.search(rf"^\s*{re.escape(name)}\s*=\s*([^\n]+)\s*$", output, re.MULTILINE)
        return match.group(1).strip() if match else None
    state_value = value("state")
    pid_value = value("pid")
    runs_value = value("runs")
    exit_value = value("last exit code")
    pid = int(pid_value) if pid_value and pid_value.isdigit() else 0
    return {
        "state": state_value,
        "pid": pid,
        "runs": int(runs_value) if runs_value and runs_value.isdigit() else None,
        "last_exit": int(exit_value) if exit_value and re.fullmatch(r"-?\d+", exit_value) else None,
    }


def launch_state(config):
    output, code = run(["/bin/launchctl", "print", target(config)], check=False)
    if code:
        return {"loaded": False, "active": False, "stopped": False, "pid": 0, "state": None, "runs": None, "last_exit": None}
    parsed = parse_launchctl(output)
    active = parsed["state"] == "running" and parsed["pid"] >= 2
    stopped = parsed["pid"] == 0 and parsed["state"] in {"not running", "exited"}
    return {**parsed, "loaded": True, "active": active, "stopped": stopped}


def stopped_epoch(state, config):
    value = {key: state.get(key) for key in ("state", "runs", "last_exit")}
    value["label"] = config["label"]
    return digest(json.dumps(value, sort_keys=True).encode())


def process_info(pid):
    executable, _ = run(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "txt", "-Fn"])
    paths = [line[1:] for line in executable.splitlines() if line.startswith("n/")]
    if len(paths) != 1:
        raise ValueError("service_executable_unverified")
    started_text, _ = run(["/bin/ps", "-p", str(pid), "-o", "lstart="])
    command, _ = run(["/bin/ps", "-ww", "-p", str(pid), "-o", "command="])
    try:
        started_at = round(time.mktime(time.strptime(started_text.strip(), "%a %b %d %H:%M:%S %Y")) * 1000)
    except (ValueError, OverflowError):
        raise ValueError("service_start_time_unverified")
    if not command.strip():
        raise ValueError("service_command_unverified")
    return {"executable": paths[0], "started_at": started_at, "command": command.rstrip("\n")}


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
        "stopped": state["stopped"],
        "stopped_epoch": stopped_epoch(state, config) if state["loaded"] and state["stopped"] else None,
        "instance": "",
        "pid": state["pid"],
        "active": state["active"],
        "listener": False,
    }
    if not state["active"]:
        return base
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
    restart_fields = {"action", "action_id", "instance", "machine", "profile", "canary", "fault_after"}
    start_fields = {"action", "action_id", "stopped_epoch", "machine", "service_profile"}
    action = request.get("action")
    expected = restart_fields if action == "restart" else start_fields if action == "start" else set()
    action_id = request.get("action_id", "")
    if (set(request) != expected
            or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", action_id)):
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
        command = ["/bin/launchctl", "kickstart"] + (["-k"] if action == "restart" else []) + [target(config)]
        run(command)
        receipt["state"] = "issued"
        atomic_save(state_path, history)
        return receipt


def validate_config(config_path, config):
    required = {"label", "plist", "port", "binary", "profile_files"}
    if (not isinstance(config, dict) or not required.issubset(config) or set(config) - (required | {"log_file"})
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", config.get("label", ""))
            or type(config.get("port")) is not int or not 1 <= config["port"] <= 65535
            or any(not isinstance(config.get(field), str) or not config[field].startswith("/") or "\0" in config[field] for field in ("plist", "binary"))
            or not isinstance(config.get("profile_files"), list) or not 1 <= len(config["profile_files"]) <= 32
            or len(set(config["profile_files"])) != len(config["profile_files"])
            or any(not isinstance(value, str) or not value.startswith("/") or "\0" in value for value in config["profile_files"])
            or (config.get("log_file") is not None and (not isinstance(config["log_file"], str) or not config["log_file"].startswith("/") or "\0" in config["log_file"]))):
        raise ValueError("invalid_adapter_configuration")
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
