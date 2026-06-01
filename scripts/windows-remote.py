#!/usr/bin/env python3
"""Run a PowerShell file or transfer a file using project-local SSH settings."""

import argparse
import base64
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--script", type=Path, help="local PowerShell script to execute")
    action.add_argument("--upload", nargs=2, metavar=("LOCAL", "REMOTE"))
    action.add_argument("--download", nargs=2, metavar=("REMOTE", "LOCAL"))
    parser.add_argument("--log", type=Path, help="save merged command output locally")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    config_path = ROOT / ".local/windows.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    host, user = config["host"], config["user"]
    if not host or host.startswith("-") or any(c in host for c in "\r\n /\\:@"):
        parser.error("host must be an IPv4 address or DNS name")
    if not user or any(c in user for c in "\r\n@"):
        parser.error("invalid SSH username")
    options = [
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=yes",
        "-o", f"UserKnownHostsFile={ROOT / '.local/windows_known_hosts'}",
    ]
    if args.script:
        script = args.script.read_text(encoding="utf-8-sig")
        # Native command failure still needs checking inside PowerShell scripts.
        script = (
            "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n& {\n"
            + script + "\n}\n"
            + "$remoteCommandSucceeded = $?\n"
            + "if ((Test-Path variable:LASTEXITCODE) -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n"
            + "if (-not $remoteCommandSucceeded) { exit 1 }\n"
        )
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        command = ["ssh", *options, "-l", user, host,
                   f"powershell.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand {encoded}"]
    else:
        # scp uses SFTP by default. Never use the legacy remote-shell protocol.
        if args.upload:
            local, remote = args.upload
            operands = [str(Path(local).resolve()), f"{user}@{host}:{remote}"]
        else:
            remote, local = args.download
            operands = [f"{user}@{host}:{remote}", str(Path(local).resolve())]
        command = ["scp", *options, "--", *operands]
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=args.timeout)
        output, status = result.stdout, result.returncode
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or b"") + b"\nLocal SSH command timed out; remote process state is unknown.\n"
        status = 124
    if args.log:
        args.log.parent.mkdir(parents=True, exist_ok=True)
        args.log.write_bytes(output)
    sys.stdout.buffer.write(output)
    return status


if __name__ == "__main__":
    sys.exit(main())
