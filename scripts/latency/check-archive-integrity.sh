#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/remote-desktop-archive-check.XXXXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
"${JAVAC:-javac}" -d "$work_dir" \
  "$repo_root/apps/android/src/main/java/dev/remotedesktop/probe/ArchiveIntegrity.java" \
  "$repo_root/probes/android/ArchiveIntegrityTest.java"
"${JAVA:-java}" -cp "$work_dir" dev.remotedesktop.probe.ArchiveIntegrityTest "$@"
