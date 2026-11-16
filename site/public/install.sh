#!/bin/sh
# Installs the latest loki on a Mac with Apple silicon or on Linux, or updates it in place, then opens it. GitHub
# Pages serves this file from site/public/ (docs/plans/2026-11-15-2319-feat-self-updating-install-plan.md, KTD9):
#
#   curl -fsSL https://almondlabs.github.io/loki/install.sh | sh
#   curl -fsSL https://almondlabs.github.io/loki/install.sh | sh -s -- --nightly
#
# It downloads the unversioned files every release carries, so it never asks GitHub's API anything. It touches only
# the app: agents, chats and settings live in ~/.loki and are kept. loki then updates itself, and fetches its own
# Node and git at Welcome, so this script installs neither.
#
# For tests: LOKI_DOWNLOAD_URL replaces https://github.com/AlmondLabs/loki/releases (a file:// URL works),
# LOKI_APPLICATIONS_DIR replaces /Applications, and LOKI_NO_OPEN=1 leaves loki closed.
set -eu

releases_url="${LOKI_DOWNLOAD_URL:-https://github.com/AlmondLabs/loki/releases}"
tmp=""

say() {
  printf '%s\n' "$1"
}

# Every failure is what went wrong, then one line on what to do next.
fail() {
  printf '%s\n%s\n' "$1" "$2" >&2
  exit 1
}

cleanup() {
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
}

# True when a loki started from $1 is running. pgrep -f matches the path, so another program called loki (Grafana
# Loki, say) doesn't count.
running() {
  pgrep -f "$1" >/dev/null 2>&1
}

stop_if_running() {
  if running "$1"; then
    fail "loki is open, so it can't be replaced." "Quit loki, then run the line again."
  fi
}

# A 404 is a release that doesn't carry the file yet, not a connection problem, so it says so. curl writes the status
# even when -f fails, and 000 when nothing answered.
download() {
  if status="$(curl -fsSL -w '%{http_code}' -o "$2" "$1")"; then return 0; fi
  if [ "$status" = 404 ]; then
    fail "The latest loki$channel_name isn't published yet." "$not_published_next"
  fi
  fail "Couldn't download $1." "Check your internet connection, then run the line again."
}

# True on a Mac with Apple silicon, the only Mac loki ships for. sysctl answers 1 there even when this shell runs under
# Rosetta, where uname -m says x86_64; an Intel Mac answers 0 or has no such key.
apple_silicon() {
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]
}

# Unpacks loki.app into /Applications, or ~/Applications when /Applications isn't writable, replacing the old copy.
# curl and tar set no quarantine flag, so macOS opens the app without asking.
install_macos() {
  stop_if_running "loki.app/Contents/MacOS/loki"
  say "Downloading the latest loki$channel_name."
  download "$base_url/loki-macos-arm64.app.tar.gz" "$tmp/loki.app.tar.gz"
  mkdir "$tmp/unpacked"
  if ! tar -xzf "$tmp/loki.app.tar.gz" -C "$tmp/unpacked" || [ ! -d "$tmp/unpacked/loki.app" ]; then
    fail "The download isn't a loki app." "Run the line again in a few minutes; if it fails again, tell us at https://github.com/AlmondLabs/loki/issues."
  fi
  folder="${LOKI_APPLICATIONS_DIR:-/Applications}"
  if [ ! -d "$folder" ] || [ ! -w "$folder" ]; then
    folder="$HOME/Applications"
    mkdir -p "$folder"
  fi
  say "Installing loki in $folder."
  if ! rm -rf "$folder/loki.app" || ! mv "$tmp/unpacked/loki.app" "$folder/loki.app"; then
    fail "Couldn't put loki in $folder." "Check that you can write to $folder, then run the line again."
  fi
  if [ "${LOKI_NO_OPEN:-}" = 1 ]; then
    say "Done. loki is in $folder."
  else
    open "$folder/loki.app"
    say "Done. loki is open."
  fi
}

# True when the AppImage at $1 can't start here: its runtime loads FUSE 2 (libfuse.so.2), which some systems leave
# out. A newer, static runtime carries its own FUSE and doesn't name the library, so it isn't held to this.
lacks_fuse() {
  head -c 2000000 "$1" | grep -q 'libfuse\.so\.2' || return 1
  ! { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libfuse\.so\.2'
}

fuse_command() {
  if command -v apt-get >/dev/null 2>&1; then
    # Ubuntu 24.04 renamed the package.
    if apt-cache show libfuse2t64 >/dev/null 2>&1; then
      echo "sudo apt install libfuse2t64"
    else
      echo "sudo apt install libfuse2"
    fi
  elif command -v dnf >/dev/null 2>&1; then
    echo "sudo dnf install fuse-libs"
  elif command -v pacman >/dev/null 2>&1; then
    echo "sudo pacman -S fuse2"
  elif command -v zypper >/dev/null 2>&1; then
    echo "sudo zypper install libfuse2"
  else
    echo "your package manager's libfuse2 package"
  fi
}

# Puts the AppImage at ~/.local/share/loki/loki.AppImage, the path it updates itself at, with a menu entry and icon.
install_linux() {
  data="${XDG_DATA_HOME:-$HOME/.local/share}"
  app="$data/loki/loki.AppImage"
  stop_if_running "$app"
  say "Downloading the latest loki$channel_name."
  download "$base_url/loki-linux-x86_64.AppImage" "$tmp/loki.AppImage"
  if lacks_fuse "$tmp/loki.AppImage"; then
    fail "loki needs FUSE 2 (libfuse2), which isn't installed." "Install it with $(fuse_command), then run the line again."
  fi
  say "Installing loki in $data/loki."
  mkdir -p "$data/loki" "$data/applications"
  chmod +x "$tmp/loki.AppImage"
  if ! mv "$tmp/loki.AppImage" "$app"; then
    fail "Couldn't put loki in $data/loki." "Check that you can write to $data/loki, then run the line again."
  fi
  # The icon is the AppImage's own, taken out without FUSE; without it the menu entry shows a generic one.
  icon_line=""
  mkdir "$tmp/icon"
  if (cd "$tmp/icon" && "$app" --appimage-extract .DirIcon </dev/null >/dev/null 2>&1); then
    icon="$tmp/icon/squashfs-root/.DirIcon"
    if [ -L "$icon" ]; then
      target="$(readlink "$icon")"
      (cd "$tmp/icon" && "$app" --appimage-extract "$target" </dev/null >/dev/null 2>&1) || true
    fi
    if [ -f "$icon" ] && cp "$icon" "$data/loki/loki.png" 2>/dev/null; then
      icon_line="Icon=$data/loki/loki.png"
    fi
  fi
  {
    echo "[Desktop Entry]"
    echo "Type=Application"
    echo "Name=loki"
    echo "Comment=A memory palace your agent builds"
    echo "Exec=\"$app\" %U"
    if [ -n "$icon_line" ]; then echo "$icon_line"; fi
    echo "Terminal=false"
    echo "Categories=Development;"
    echo "StartupWMClass=loki"
  } >"$data/applications/loki.desktop"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$data/applications" >/dev/null 2>&1 || true
  fi
  if [ "${LOKI_NO_OPEN:-}" = 1 ]; then
    say "Done. loki is in $data/loki."
  else
    nohup "$app" >/dev/null 2>&1 &
    say "Done. loki is open."
  fi
}

main() {
  channel="${LOKI_CHANNEL:-stable}"
  for arg in "$@"; do
    case "$arg" in
      --nightly) channel=nightly ;;
      --stable) channel=stable ;;
      *) fail "Unknown option: $arg." "Run the line with no options for Stable, or with --nightly for Nightly." ;;
    esac
  done
  case "$channel" in
    stable)
      base_url="$releases_url/latest/download"
      channel_name=""
      not_published_next="Run the line with --nightly for loki Nightly, or download loki from https://github.com/AlmondLabs/loki/releases."
      ;;
    nightly)
      base_url="$releases_url/download/nightly"
      channel_name=" Nightly"
      not_published_next="Run the line again in a few minutes, or download loki from https://github.com/AlmondLabs/loki/releases."
      ;;
    *) fail "Unknown channel: $channel." "Set LOKI_CHANNEL to stable or nightly, or leave it out." ;;
  esac

  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/loki-install.XXXXXX")"

  system="$(uname -s)"
  arch="$(uname -m)"
  case "$system" in
    Darwin)
      if ! apple_silicon; then
        fail "loki needs a Mac with Apple silicon." "Use loki on a Mac with Apple silicon, on Windows, or on an x86_64 Linux machine."
      fi
      install_macos
      ;;
    Linux)
      if [ "$arch" != x86_64 ]; then
        fail "loki for Linux runs on x86_64 only, and this machine is $arch." "Use loki on a Mac with Apple silicon, on Windows, or on an x86_64 Linux machine."
      fi
      install_linux
      ;;
    *) fail "This script installs loki on macOS and Linux, and this machine runs $system." "On Windows, run this in PowerShell: irm https://almondlabs.github.io/loki/install.ps1 | iex" ;;
  esac
}

# Everything runs from main, so a download cut short partway through the script runs nothing.
main "$@"
