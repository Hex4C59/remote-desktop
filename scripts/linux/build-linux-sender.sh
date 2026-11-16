#!/usr/bin/env bash
set -euo pipefail
webrtc_root="${1:?Usage: build-linux-sender.sh WEBRTC_SRC [JOBS]}"
job_count="${2:-4}"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Linux x64 required' >&2; exit 1; }
[[ "$job_count" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid job count' >&2; exit 1; }
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
webrtc_root="$(cd "$webrtc_root" && pwd)"
expected_revision="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["webrtc"]["revision"])' "$project_root/scripts/webrtc/webrtc-build-candidate.json")"
[[ "$(git -C "$webrtc_root" rev-parse HEAD)" == "$expected_revision" ]] || { echo 'WebRTC revision mismatch' >&2; exit 1; }
# Independent overlay and output: never update remote_desktop_probe, Android's
# APK output, shared GN files, backend.star, or another platform's args.gn.
overlay="$webrtc_root/remote_desktop_linux"
mkdir -p "$overlay/remote_desktop_probe" "$overlay/tests"
cp "$project_root/scripts/linux/linux-sender.BUILD.gn" "$overlay/BUILD.gn"
for portable_file in frame_source.h software_trace.h video_statistics_log.h video_statistics_log.cpp; do
  cp "$project_root/apps/windows/src/$portable_file" "$overlay/remote_desktop_probe/$portable_file"
done
cp "$project_root/apps/linux/src/"*.cpp "$project_root/apps/linux/src/"*.h "$overlay/remote_desktop_probe/"
cp "$project_root/apps/linux/tests/"*.cpp "$overlay/tests/"
cd "$webrtc_root"
buildtools/linux64/gn gen out/remote-desktop-linux --root-target=//remote_desktop_linux:linux_validation --args='target_os="linux" target_cpu="x64" is_clang=true use_sysroot=true use_siso=false use_remoteexec=false rtc_use_x11=true rtc_use_x11_extensions=true rtc_use_pipewire=false use_gtk=true gtk_version=3 is_debug=false is_component_build=false rtc_include_tests=false rtc_build_examples=false rtc_build_tools=false'
third_party/ninja/ninja -C out/remote-desktop-linux -j "$job_count" remote_desktop_linux:linux_validation
sha256sum out/remote-desktop-linux/linux_sender
