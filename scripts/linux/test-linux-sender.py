#!/usr/bin/env python3
"""Isolated synthetic integration checks; never claim Android/Xorg acceptance."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import selectors
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import time


def read_exact(stream, count: int) -> bytes:
    data = bytearray()
    while len(data) < count:
        chunk = stream.recv(count - len(data))
        if not chunk:
            raise EOFError("test connection closed")
        data.extend(chunk)
    return bytes(data)


def send_frame(stream, message: bytes) -> None:
    stream.sendall(struct.pack("!I", len(message)) + message)


def read_frame(stream) -> bytes:
    length = struct.unpack("!I", read_exact(stream, 4))[0]
    if not 1 <= length <= 65536:
        raise AssertionError("invalid frame length")
    return read_exact(stream, length)


class Fixture:
    def __init__(self, executable: Path, *, expiry: bool = False):
        self.output = tempfile.TemporaryFile()
        read_fd, write_fd = os.pipe()
        environment = dict(os.environ, REMOTE_DESKTOP_CREDENTIAL_FD=str(write_fd))
        if expiry:
            environment["REMOTE_DESKTOP_FIXTURE_EXPIRY"] = "1"
        self.process = subprocess.Popen([str(executable)], env=environment,
                                        pass_fds=(write_fd,), stdout=self.output, stderr=self.output)
        os.close(write_fd)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(read_fd, selectors.EVENT_READ)
                if not selector.select(5):
                    raise AssertionError("fixture startup deadline")
                self.code = os.read(read_fd, 64)
            if len(self.code) != 64:
                raise AssertionError("fixture startup failed")
            self.fingerprint = base64.urlsafe_b64decode(self.code)[:32]
        except BaseException:
            self.close()
            raise
        finally:
            os.close(read_fd)

    def connect(self, fingerprint: bytes | None = None):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_2
        stream = context.wrap_socket(socket.create_connection(("127.0.0.1", 18443), timeout=6),
                                     server_hostname="remote-desktop")
        expected = self.fingerprint if fingerprint is None else fingerprint
        if hashlib.sha256(stream.getpeercert(binary_form=True)).digest() != expected:
            stream.close()
            raise ValueError("fixture certificate pin rejected")
        return stream

    def wait(self, reason: bytes | None = None, timeout: float = 6):
        if self.process.wait(timeout=timeout) != 0:
            raise AssertionError("fixture exited unsuccessfully")
        self.output.seek(0)
        output = self.output.read()
        if self.code in output:
            raise AssertionError("credential leaked in fixture log")
        if reason is not None and reason not in output:
            raise AssertionError("missing expected termination reason")
        return output

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        self.output.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def pairing_checks(executable: Path) -> list[str]:
    checks = []
    with Fixture(executable) as fixture:
        try:
            fixture.connect(bytes(32))
        except ValueError:
            checks.append("wrong_certificate_pin_rejected_before_auth")
        else:
            raise AssertionError("wrong pin accepted")
        with fixture.connect() as stream:
            wrong = fixture.code[:-1] + (b"A" if fixture.code[-1:] != b"A" else b"B")
            send_frame(stream, b"auth\n" + wrong)
            if read_frame(stream) != b"denied":
                raise AssertionError("wrong code accepted")
            checks.append("wrong_code_denied")
        for length in (0, 65537):
            with fixture.connect() as stream:
                stream.sendall(struct.pack("!I", length))
                if read_frame(stream) != b"denied":
                    raise AssertionError("bad length accepted")
        checks.append("invalid_frame_lengths_denied")
        with fixture.connect() as stream:
            # Fragment the real framed auth, preserving one overall read deadline.
            auth = b"auth\n" + fixture.code
            packet = struct.pack("!I", len(auth)) + auth
            stream.sendall(packet[:2])
            stream.sendall(packet[2:7])
            stream.sendall(packet[7:])
            if read_frame(stream) != b"accepted":
                raise AssertionError("valid auth rejected")
            checks.append("fragmented_valid_auth_accepted")
            with fixture.connect() as second:
                if read_frame(second) != b"busy":
                    raise AssertionError("second connection not busy")
            checks.append("second_connection_busy")
            send_frame(stream, b"ping")
            if read_frame(stream) != b"pong":
                raise AssertionError("heartbeat failed")
            send_frame(stream, b"fixture:echo")
            if read_frame(stream) != b"fixture:echo":
                raise AssertionError("authenticated_queue_failed")
            checks.append("heartbeat_and_authenticated_queue")
        fixture.wait()
        first_fingerprint = fixture.fingerprint
        first_code = fixture.code
        checks.append("transport_close_ends_session")
    with Fixture(executable) as fixture:
        if fixture.code == first_code or fixture.fingerprint == first_fingerprint:
            raise AssertionError("reused credential/identity")
        with fixture.connect() as stream:
            send_frame(stream, b"auth\n" + first_code)
            if read_frame(stream) != b"denied":
                raise AssertionError("old credential accepted")
        for _ in range(9):
            with fixture.connect() as stream:
                send_frame(stream, b"auth\n" + b"A" * 64)
                if read_frame(stream) != b"denied":
                    raise AssertionError("failure accepted")
        fixture.wait(b"pairing_failure_limit=true")
        checks.extend(["new_identity_rejects_previous_code", "ten_failure_limit"])
    with Fixture(executable, expiry=True) as fixture:
        fixture.wait(b"pairing_expired=true")
        checks.append("five_minute_expiry_with_injected_clock")
    with Fixture(executable) as fixture:
        with fixture.connect() as stream:
            stream.sendall(struct.pack("!I", 69) + b"auth\n")
            started = time.monotonic()
            if read_frame(stream) != b"denied" or time.monotonic() - started > 6:
                raise AssertionError("fragmented auth deadline not enforced")
        with fixture.connect() as stream:
            send_frame(stream, b"auth\n" + fixture.code)
            if read_frame(stream) != b"accepted":
                raise AssertionError("auth after rejected attempt failed")
            send_frame(stream, b"fixture:stop")
        fixture.wait()
        checks.append("incomplete_frame_absolute_deadline")
    for invalid_length in (True, False):
        with Fixture(executable) as fixture:
            with fixture.connect() as stream:
                send_frame(stream, b"auth\n" + fixture.code)
                if read_frame(stream) != b"accepted":
                    raise AssertionError("diagnostic fixture auth rejected")
                stream.sendall(struct.pack("!I", 0 if invalid_length else 20))
                expected = b'"value":"tls_invalid_frame"' if invalid_length else b'"value":"tls_read_timeout"'
                fixture.wait(expected, timeout=7)
                checks.append("authorized_bad_frame_diagnostic" if invalid_length else "authorized_partial_frame_diagnostic")
    return checks


def run_inside(binary_dir: Path, report: Path) -> None:
    checks = []
    # The product must refuse synthetic Xvfb even though the display is usable.
    environment = dict(os.environ)
    environment.pop("XDG_SESSION_ID", None)
    result = subprocess.run([str(binary_dir / "linux_sender"), "--check-environment"],
                            env=environment, capture_output=True, text=True, timeout=5)
    if result.returncode != 2 or "desktop_session_unavailable=true" not in result.stderr:
        raise AssertionError("product accepted non-user desktop session")
    checks.append("product_rejects_ssh_or_greeter_session")
    for name in ("linux_input_fixture", "linux_desktop_fixture"):
        result = subprocess.run([str(binary_dir / name)], capture_output=True, text=True, timeout=15)
        if result.returncode:
            # Fixture diagnostics contain only fixed test data, never a credential.
            raise AssertionError(f"{name}: {result.stdout[-2000:]} {result.stderr[-2000:]}")
        checks.append(name)
        print(result.stdout.strip())
    # Change only this private Xvfb's layout, including AltGr symbols.
    subprocess.run(["setxkbmap", "-layout", "de", "-variant", "nodeadkeys"], check=True, timeout=5)
    result = subprocess.run([str(binary_dir / "linux_input_fixture")],
                            capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise AssertionError(f"AltGr fixture: {result.stdout[-2000:]} {result.stderr[-2000:]}")
    print(result.stdout.strip())
    checks.append("linux_input_fixture_de_nodeadkeys_altgr")
    checks.extend(pairing_checks(binary_dir / "linux_pairing_fixture"))
    artifact = {
        "schema_version": 1,
        "evidence_kind": "isolated_synthetic_xvfb",
        "passed": True,
        "checks": checks,
        "product_runtime_accepted": False,
        "android_runtime_accepted": False,
        "binaries": {name: hashlib.sha256((binary_dir / name).read_bytes()).hexdigest()
                     for name in ("linux_sender", "linux_input_fixture", "linux_desktop_fixture", "linux_pairing_fixture")},
    }
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(artifact, indent=2) + "\n")
    print(f"synthetic_checks_passed={len(checks)} product_runtime_accepted=false android_runtime_accepted=false")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary_dir", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--inside-fixture", action="store_true", help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    binary_dir = arguments.binary_dir.resolve()
    report = arguments.report.resolve()
    if not arguments.inside_fixture:
        return subprocess.run(["xvfb-run", "-a", "-s", "-screen 0 1600x900x24 -nolisten tcp",
                               sys.executable, str(Path(__file__).resolve()), str(binary_dir),
                               "--report", str(report), "--inside-fixture"], check=False).returncode
    try:
        run_inside(binary_dir, report)
        return 0
    except (AssertionError, OSError, EOFError, subprocess.TimeoutExpired) as error:
        print(f"synthetic_checks_failed={error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
