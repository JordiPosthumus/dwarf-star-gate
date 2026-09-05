"""Exercise stopped-service inspection against real unrelated TCP listeners."""
import importlib.util
import errno
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import MagicMock, patch


def load(kind):
    spec = importlib.util.spec_from_file_location(kind, Path(__file__).with_name(f"recovery-{kind}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecoveryPortTests(unittest.TestCase):
    def test_ipv4_ipv6_wildcard_and_bound_not_listening_collisions(self):
        for kind in ("launchd", "systemd"):
            adapter = load(kind)
            for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET, "0.0.0.0"), (socket.AF_INET6, "::1"), (socket.AF_INET6, "::")):
                for listening in (False, True):
                    with self.subTest(adapter=kind, address=address, listening=listening):
                        try:
                            listener = socket.socket(family, socket.SOCK_STREAM)
                        except OSError as error:
                            if family == socket.AF_INET6 and error.errno == errno.EAFNOSUPPORT:
                                continue
                            raise
                        with listener:
                            if family == socket.AF_INET6:
                                listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                            listener.bind((address, 0))
                            if listening:
                                listener.listen()
                            self.assertTrue(adapter.port_occupied(listener.getsockname()[1]))

    def test_clear_port_releases_every_probe_and_never_listens(self):
        for kind in ("launchd", "systemd"):
            adapter = load(kind)
            probes = [MagicMock(), MagicMock()]
            with self.subTest(adapter=kind), patch.object(adapter.socket, "socket", side_effect=probes):
                self.assertFalse(adapter.port_occupied(8001))
            for probe in probes:
                probe.close.assert_called_once()
                probe.listen.assert_not_called()
                probe.connect.assert_not_called()
            probes[0].bind.assert_called_once_with(("127.0.0.1", 8001))
            probes[1].bind.assert_called_once_with(("::1", 8001))
            probes[0].setsockopt.assert_not_called()
            probes[1].setsockopt.assert_called_once_with(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            # Real released ephemeral port: no connection/TIME_WAIT is created.
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            self.assertFalse(adapter.port_occupied(port))
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", port))

    def test_unknown_errors_fail_inspection_and_release_probes(self):
        for kind in ("launchd", "systemd"):
            adapter = load(kind)
            for number in (errno.EACCES, errno.EMFILE, errno.EADDRNOTAVAIL):
                probes = [MagicMock(), MagicMock()]
                probes[1].bind.side_effect = OSError(number, "private diagnostic")
                with self.subTest(adapter=kind, error=number), patch.object(adapter.socket, "socket", side_effect=probes):
                    with self.assertRaises(OSError):
                        adapter.port_occupied(8001)
                for probe in probes:
                    probe.close.assert_called_once()
            probe = MagicMock()
            with patch.object(adapter.socket, "socket", side_effect=[probe, OSError(errno.EAFNOSUPPORT, "IPv6 disabled")]):
                self.assertFalse(adapter.port_occupied(8001))
            probe.close.assert_called_once()

    def test_inactive_service_cannot_start_over_an_unrelated_listener(self):
        for kind in ("launchd", "systemd"):
            adapter = load(kind)
            with self.subTest(adapter=kind), socket.socket() as listener, tempfile.TemporaryDirectory() as temp:
                listener.bind(("127.0.0.1", 0))
                listener.listen()
                config = {"port": listener.getsockname()[1], "label": "com.example.ds4", "unit": "ds4.service"}
                with patch.object(adapter, "service_profile", return_value="b" * 64):
                    if kind == "launchd":
                        with patch.object(adapter, "native_disabled", return_value=False), patch.object(adapter, "machine_identity", return_value="a" * 64), patch.object(adapter, "launch_state", return_value={"loaded": True, "stopped": True, "active": False, "pid": 0}), patch.object(adapter, "run") as command:
                            self.assert_blocked(adapter, config, temp)
                            command.assert_not_called()
                    else:
                        props = "MainPID=0\nLoadState=loaded\nActiveState=inactive\n"
                        with patch.object(adapter, "run", side_effect=lambda args: props if "show" in args else "definition" ) as command, patch.object(adapter.Path, "read_bytes", return_value=b"machine-id"):
                            self.assert_blocked(adapter, config, temp)
                            self.assertTrue(all(call.args[0][2] in {"show", "cat"} for call in command.call_args_list))

    def assert_blocked(self, adapter, config, temp):
        current = adapter.inspect(config)
        self.assertTrue(current["listener"], "Inactive service does not prove its port is empty")
        request = {"action": "start", "action_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                   **{key: current[key] for key in ("machine", "service_profile", "stopped_epoch")}}
        state = Path(temp) / "actions.json"
        with self.assertRaisesRegex(ValueError, "stopped_service_identity_changed"):
            adapter.handle(config, request, state)
        self.assertFalse(state.exists(), "Rejected collision must not issue an action receipt")


if __name__ == "__main__":
    unittest.main()
