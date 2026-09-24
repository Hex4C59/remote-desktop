#!/usr/bin/env bash
set -euo pipefail
webrtc_root="${1:?Usage: build-webrtc-probe.sh WEBRTC_SRC [JOBS]}"
job_count="${2:-16}"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
expected_revision="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["webrtc"]["revision"])' "$project_root/docs/design/webrtc-build-candidate.json")"
[[ "$(git -C "$webrtc_root" rev-parse HEAD)" == "$expected_revision" ]] || { echo 'WebRTC revision mismatch' >&2; exit 1; }
# Assemble the existing libwebrtc overlay from application and probe sources.
overlay="$webrtc_root/remote_desktop_probe"
mkdir -p "$overlay/android"
cp "$project_root/scripts/webrtc/BUILD.gn" "$overlay/BUILD.gn"
cp "$project_root/apps/windows/src/"*.cpp "$project_root/apps/windows/src/"*.h "$overlay/"
cp "$project_root/probes/webrtc/pattern_source.cpp" "$overlay/"
cp "$project_root/apps/android/src/main/AndroidManifest.xml" "$overlay/android/"
cp -R "$project_root/apps/android/src/main/java/." "$overlay/android/"
cd "$webrtc_root"
buildtools/linux64/gn gen out/remote-desktop-arm64 --root-target=//remote_desktop_probe:receiver --args='target_os="android" target_cpu="arm64" is_debug=false is_component_build=false rtc_include_tests=false rtc_build_examples=false rtc_build_tools=false use_remoteexec=false use_siso=true android_static_analysis="off"'
third_party/siso/cipd/siso ninja -C out/remote-desktop-arm64 remote_desktop_probe:receiver -j "$job_count"
sha256sum out/remote-desktop-arm64/apks/RemoteDesktopProbe.apk
