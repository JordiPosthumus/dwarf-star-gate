#!/usr/bin/env python3
"""Opt-in native launchd lifecycle fixture, NOT a DS4 recovery certificate.

Creates one random-label loopback-only test job; never accepts a worker, label,
port, launch command or existing config as input. Retains private evidence and
unregisters its own job in finally. Normal test suites do not run this script.
"""
import importlib.util
import http.client
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import socket
import sys
import tempfile
import time
import uuid

SERVER = """import http from 'node:http';
const [port,nonce]=process.argv.slice(2);
const server=http.createServer((req,res)=>{const body=JSON.stringify({fixture:nonce});res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(body)});res.end(body);});
server.listen(Number(port),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
// Fixture-only failsafe if the test runner is killed before cleanup.
setTimeout(()=>process.exit(0),300000).unref();
"""


def helper_module():
    filename = Path(__file__).resolve().parents[1] / "ds4-gateway" / "recovery-launchd.py"
    spec = importlib.util.spec_from_file_location("native_smoke_helper", filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture(root, node, port, nonce, label):
    program = root / "fixture.mjs"
    program.write_text(SERVER)
    program.chmod(0o600)
    for name in ["fixture.stdout", "fixture.stderr"]:
        (root / name).touch(mode=0o600, exist_ok=False)
    definition = {"Label": label, "ProgramArguments": [str(node), str(program), str(port), nonce],
                  "WorkingDirectory": str(root), "RunAtLoad": True, "KeepAlive": False,
                  "ExitTimeOut": 5, "StandardOutPath": str(root / "fixture.stdout"), "StandardErrorPath": str(root / "fixture.stderr")}
    filename = root / "retained.plist"
    filename.write_bytes(plistlib.dumps(definition)); filename.chmod(0o600)
    return {"label": label, "plist": str(filename), "binary": str(node), "port": port,
            "profile_files": [str(program)], "bootstrap_removed": True, "bootstrap_callers": []}


def wait_for(check, seconds=15):
    deadline = time.monotonic() + seconds
    while True:
        value = check()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise ValueError("fixture_observation_deadline")
        time.sleep(0.25)


def run_smoke():
    if sys.platform != "darwin" or os.getuid() == 0:
        raise ValueError("non_root_macos_session_required")
    found = shutil.which("node")
    if not found:
        raise ValueError("node_required")
    node = Path(found).resolve(strict=True)
    adapter = helper_module()
    domain = f"gui/{os.getuid()}"
    text, code = adapter.run(["/bin/launchctl", "print", domain], check=False)
    if code or not text.startswith(domain + " = {\n"):
        raise ValueError("readable_gui_domain_required")
    root = Path(tempfile.mkdtemp(prefix="dsg-launchd-smoke-")).resolve()
    nonce = uuid.uuid4().hex
    label = "com.dsg.fixture." + nonce
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0)); port = reservation.getsockname()[1]
    config = fixture(root, node, port, nonce, label)
    config["retained_definition_sha256"] = adapter.file_digest(config["plist"])
    config_file = root / "helper.json"
    config_file.write_text(json.dumps(config)); config_file.chmod(0o600)
    adapter.validate_config(config_file, config)
    state_path = root / "helper.actions.json"
    target = domain + "/" + label
    result = {"schema": 1, "scope": "disposable_native_lifecycle_only", "ds4_certified": False,
              "started_at": round(time.time() * 1000), "checks": {}, "cleanup": "not_needed"}
    attempted = False
    phase = "preflight"
    print(json.dumps({"fixture_directory": str(root), "scope": result["scope"]}), flush=True)
    try:
        if adapter.launch_state(config).get("registration") != "absent" or adapter.port_occupied(port):
            raise ValueError("fixture_target_not_available")
        result["checks"]["definition_verified"] = adapter.handle(config, {"action": "inspect_definition"}, state_path)["verified"]
        if not result["checks"]["definition_verified"]:
            raise ValueError("fixture_definition_unverified")
        phase = "initial_registration"
        attempted = True  # A lost acknowledgement may still have registered it.
        adapter.run(["/bin/launchctl", "bootstrap", domain, config["plist"]])

        def running():
            value = adapter.inspect(config)
            return value if value["active"] and value["listener"] else None

        phase = "initial_identity"
        before = wait_for(running)
        if not before.get("boot_uuid"):
            raise ValueError("fixture_boot_unverified")
        prior = {key: before[key] for key in ["instance", "machine", "profile", "service_profile", "pid", "started_at", "boot_uuid"]}
        prior["observed_at"] = round(time.time() * 1000)
        adapter.atomic_save(root / "prior.json", prior)
        result["checks"]["initial_identity"] = True
        phase = "native_removal"
        adapter.run(["/bin/launchctl", "bootout", target])
        wait_for(lambda: adapter.launch_state(config).get("registration") == "absent" and not adapter.port_occupied(port))
        phase = "native_provenance"
        def observed_removal():
            evidence = adapter.inspect_removal(config, prior)
            adapter.atomic_save(root / "native-evidence.json", evidence)
            result["native_evidence_status"] = evidence["status"]
            return evidence if evidence["status"] in {"exact_removal_observed", "exact_stop_request_observed"} else None

        evidence = wait_for(observed_removal, seconds=20)
        if len(evidence["observations"]) != 1 or evidence["observations"][0]["caller"] != "launchctl" or evidence["observations_omitted"]:
            raise ValueError("fixture_removal_ambiguous")
        result["checks"]["native_removal_caller"] = "launchctl"
        request = {"action": "bootstrap", "action_id": str(uuid.uuid4()), "prior": prior,
                   "definition_sha256": config["retained_definition_sha256"], "canary": False}
        phase = "ordinary_stop_veto"
        try:
            adapter.handle(config, request, state_path)
        except ValueError as error:
            if str(error) != "bootstrap_removal_caller_not_enrolled":
                raise
        else:
            raise ValueError("fixture_native_stop_was_not_vetoed")
        result["checks"]["ordinary_stop_veto"] = True
        phase = "helper_bootstrap"
        request.update(action_id=str(uuid.uuid4()), canary=True)
        receipt = adapter.handle(config, request, state_path)
        if receipt["state"] != "issued":
            raise ValueError("fixture_bootstrap_unacknowledged")
        phase = "restored_identity"
        after = wait_for(running)
        if after["instance"] == before["instance"] or any(after[k] != before[k] for k in ["machine", "profile", "service_profile", "boot_uuid"]):
            raise ValueError("fixture_restored_identity_mismatch")
        result["checks"]["new_process_same_profile"] = True
        # This is only a fixture nonce, not fabricated model usage or cache proof.
        phase = "loopback_fixture_response"
        # Client closes first so the server's port need not wait out TIME_WAIT.
        # The adapter's conservative non-reusing bind probe is not weakened.
        client = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        try:
            client.request("GET", "/health")
            response = client.getresponse()
            if response.status != 200 or json.loads(response.read(1024)) != {"fixture": nonce}:
                raise ValueError("fixture_response_mismatch")
        finally:
            client.close()
        result["checks"]["loopback_fixture_response"] = True
        phase = "duplicate_suppression"
        if adapter.handle(config, request, state_path) != receipt or adapter.inspect(config)["instance"] != after["instance"]:
            raise ValueError("fixture_duplicate_changed_process")
        history = adapter.load_history(state_path)
        if len(history) != 1 or history[request["action_id"]]["state"] != "issued":
            raise ValueError("fixture_journal_mismatch")
        staged = root / f"bootstrap-{request['action_id']}.plist"
        if adapter.file_digest(staged) != config["retained_definition_sha256"] or adapter.file_digest(config["plist"]) != config["retained_definition_sha256"]:
            raise ValueError("fixture_definition_bytes_changed")
        result["checks"].update(duplicate_suppressed=True, exact_bytes_retained=True)
        result["outcome"] = "passed"
    except (Exception, KeyboardInterrupt) as error:
        result.update(outcome="failed", phase=phase, error_type=type(error).__name__,
                      reason=str(error) if re.fullmatch(r"[a-z_]{1,100}", str(error)) else "native_fixture_check_failed")
    finally:
        if attempted:
            try:
                # Only the unpredictable fixture label this invocation created.
                # Never kill a PID, enable a job, or accept an operator target.
                adapter.run(["/bin/launchctl", "bootout", target], check=False)
                wait_for(lambda: adapter.launch_state(config).get("registration") == "absent" and not adapter.port_occupied(port))
                result["cleanup"] = "fixture_job_absent_and_port_free"
            except Exception:
                result["cleanup"] = "review_required"
                result["outcome"] = "failed"
        result["finished_at"] = round(time.time() * 1000)
        filename = root / "receipt.json"
        filename.write_text(json.dumps(result, indent=2)); filename.chmod(0o600)
        print(json.dumps(result), flush=True)
    return 0 if result.get("outcome") == "passed" else 1


def main(args):
    if args != ["--run"]:
        print("Opt-in only: python3 scripts/launchd-recovery-smoke.py --run\nCreates and removes one temporary native test LaunchAgent; does not certify DS4.")
        return 0 if args in ([], ["--help"]) else 2
    previous = signal.getsignal(signal.SIGTERM)
    def interrupted(_signum, _frame):
        raise ValueError("fixture_interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        return run_smoke()
    except Exception as error:
        print(json.dumps({"outcome": "failed", "phase": "environment", "error_type": type(error).__name__,
                          "reason": str(error) if re.fullmatch(r"[a-z_]{1,100}", str(error)) else "fixture_environment_unavailable"}))
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
