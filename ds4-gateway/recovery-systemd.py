#!/usr/bin/env python3
"""Fixed systemd-user DS4 adapter. JSON stdin; no commands supplied by the model.

Install beside a private JSON config. The SSH account is trusted; this helper
does not claim to sandbox other software running as that account.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


def digest(value):
    return hashlib.sha256(value).hexdigest()


def run(args):
    result = subprocess.run(args, capture_output=True, timeout=15, check=True)
    if len(result.stdout) > 1024 * 1024:
        raise ValueError("adapter_output_limit")
    return result.stdout.decode()


def fault_evidence(lines, invocation):
    fault = None
    progress = 0
    for line in lines.splitlines():
        entry = json.loads(line)
        if entry.get("_SYSTEMD_INVOCATION_ID") != invocation:
            continue
        message = entry.get("MESSAGE", "")
        if not isinstance(message, str):
            continue
        at = int(entry["__REALTIME_TIMESTAMP"]) // 1000
        if re.match(r"^ds4: CUDA [^\n]{0,160}(?:an illegal memory access was encountered|device-side assert)", message):
            fault = {"at": at, "reason": "fatal_accelerator_error"}
        if re.search(r"ds4-server: chat ctx=.*decoding chunk=", message):
            progress = max(progress, at)
    return fault if fault and progress <= fault["at"] else None


def owns_listener(pid, port):
    inodes = set()
    for fd in Path(f"/proc/{pid}/fd").iterdir():
        try:
            link = os.readlink(fd)
            if link.startswith("socket:["):
                inodes.add(link[8:-1])
        except FileNotFoundError:
            pass
    for row in Path("/proc/net/tcp").read_text().splitlines()[1:]:
        fields = row.split()
        address, hexport = fields[1].split(":")
        if address == "0100007F" and int(hexport, 16) == port and fields[3] == "0A" and fields[9] in inodes:
            return True
    return False


def inspect(config):
    props = dict(line.split("=", 1) for line in run([
        "systemctl", "--user", "show", config["unit"], "--property=MainPID,InvocationID,ActiveState,FragmentPath,ExecMainStartTimestampMonotonic"
    ]).splitlines() if "=" in line)
    invocation = props.get("InvocationID", "")
    pid = int(props.get("MainPID", 0))
    machine = digest(Path("/etc/machine-id").read_bytes())
    base = {"version": 1, "machine": machine, "instance": invocation, "pid": pid, "active": props.get("ActiveState") == "active", "listener": False}
    if pid < 2 or not re.fullmatch(r"[a-f0-9]{32}", invocation):
        return base  # v1 does not start missing/stopped installs blindly.
    if str(Path(f"/proc/{pid}/exe").resolve()) != str(Path(config["binary"]).resolve()):
        raise ValueError("service_executable_mismatch")
    argv = Path(f"/proc/{pid}/cmdline").read_bytes()
    env = sorted(x for x in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0") if x.startswith(b"DS4_"))
    files = {str(p): digest(Path(p).read_bytes()) for p in config["profile_files"]}
    files[config["binary"]] = digest(Path(config["binary"]).read_bytes())
    definition = run(["systemctl", "--user", "cat", config["unit"]])
    profile = digest(json.dumps({"files": files, "argv": digest(argv), "env": digest(b"\0".join(env)), "unit": digest(definition.encode())}, sort_keys=True).encode())
    started = (time.time() - time.clock_gettime(time.CLOCK_BOOTTIME) + int(props["ExecMainStartTimestampMonotonic"]) / 1e6) * 1000
    logs = run(["journalctl", "--user", f"_SYSTEMD_INVOCATION_ID={invocation}", "--no-pager", "-n", "200", "-o", "json", "--output-fields=MESSAGE,__REALTIME_TIMESTAMP,_SYSTEMD_INVOCATION_ID"])
    return {**base, "profile": profile, "started_at": round(started), "listener": owns_listener(pid, config["port"]), "fault": fault_evidence(logs, invocation)}


def atomic_save(filename, value):
    temp = filename.with_suffix(".tmp")
    fd = os.open(temp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, filename)
    fd = os.open(filename.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def handle(config, request, state_path):
    if request == {"action": "inspect"}:
        return inspect(config)
    allowed = {"action", "action_id", "instance", "machine", "profile", "canary", "fault_after"}
    if set(request) != allowed or request["action"] != "restart" or not re.fullmatch(r"[a-f0-9-]{36}", request["action_id"]):
        raise ValueError("invalid_adapter_request")
    if type(request["canary"]) is not bool or not isinstance(request["fault_after"], (int, float)):
        raise ValueError("invalid_adapter_request")
    # Lock persists only across inspect + issue, never across the model load.
    with open(str(state_path) + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        history = json.loads(state_path.read_text()) if state_path.exists() else {}
        previous = history.get(request["action_id"])
        request_hash = digest(json.dumps(request, sort_keys=True).encode())
        if previous:
            if previous["request_hash"] != request_hash:
                raise ValueError("action_id_conflict")
            return previous  # Lost SSH acknowledgment must never repeat restart.
        if len(history) >= 10000:
            raise ValueError("adapter_journal_full_review_required")
        current = inspect(config)
        if not current["active"] or not current["listener"] or any(current.get(k) != request[k] for k in ["instance", "machine", "profile"]):
            raise ValueError("service_identity_changed")
        if not request["canary"] and (not current.get("fault") or current["fault"]["at"] < request["fault_after"]):
            raise ValueError("current_fatal_evidence_required")
        if any(item["instance"] == current["instance"] for item in history.values()):
            raise ValueError("instance_already_attempted")
        receipt = {"request_hash": request_hash, "instance": current["instance"], "issued_at": round(time.time() * 1000), "state": "intent"}
        history[request["action_id"]] = receipt
        atomic_save(state_path, history)  # Crash here means unknown, not permission to retry.
        run(["systemctl", "--user", "restart", "--no-block", config["unit"]])
        receipt["state"] = "issued"
        atomic_save(state_path, history)
        return receipt


def main():
    config_path = Path(sys.argv[1])
    config = json.loads(config_path.read_text())
    if not re.fullmatch(r"[A-Za-z0-9][\w@.-]*\.service", config["unit"]) or not 1 <= config["port"] <= 65535:
        raise ValueError("invalid_adapter_configuration")
    if config_path.stat().st_mode & 0o077:
        raise ValueError("adapter_configuration_must_be_private")
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise ValueError("adapter_input_limit")
    print(json.dumps(handle(config, json.loads(raw), config_path.with_suffix(".actions.json"))))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Paths, environment, journal lines and subprocess stderr stay private.
        print(json.dumps({"error": "adapter_check_or_operation_failed"}))
        sys.exit(1)
