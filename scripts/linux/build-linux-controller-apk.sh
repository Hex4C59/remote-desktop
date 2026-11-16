#!/usr/bin/env bash
set -euo pipefail
webrtc_root="${1:?Usage: build-linux-controller-apk.sh WEBRTC_SRC [JOBS]}"
job_count="${2:-4}"
[[ "$(uname -s)" == Linux ]] || { echo 'Linux build host required' >&2; exit 1; }
[[ "$job_count" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid job count' >&2; exit 1; }
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
webrtc_root="$(cd "$webrtc_root" && pwd)"
expected_revision="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["webrtc"]["revision"])' "$project_root/scripts/webrtc/webrtc-build-candidate.json")"
[[ "$(git -C "$webrtc_root" rev-parse HEAD)" == "$expected_revision" ]] || { echo 'WebRTC revision mismatch' >&2; exit 1; }
overlay="$webrtc_root/remote_desktop_linux_android"
mkdir -p "$overlay/android"
cp "$project_root/scripts/webrtc/BUILD.gn" "$overlay/BUILD.gn"
cp "$project_root/apps/windows/src/"*.cpp "$project_root/apps/windows/src/"*.h "$overlay/"
cp "$project_root/probes/webrtc/"*.cpp "$overlay/"
cp "$project_root/apps/android/src/main/AndroidManifest.xml" "$overlay/android/"
cp -R "$project_root/apps/android/src/main/java/." "$overlay/android/"
cd "$webrtc_root"
buildtools/linux64/gn gen out/remote-desktop-linux-controller --root-target=//remote_desktop_linux_android:receiver --args='target_os="android" target_cpu="arm64" is_debug=false is_component_build=false rtc_include_tests=false rtc_build_examples=false rtc_build_tools=false use_remoteexec=false use_siso=false android_static_analysis="off"'
third_party/ninja/ninja -C out/remote-desktop-linux-controller -j "$job_count" remote_desktop_linux_android:receiver
sha256sum out/remote-desktop-linux-controller/apks/RemoteDesktopProbe.apk
