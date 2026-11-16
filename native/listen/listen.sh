#!/bin/sh
set -e
cd "$(dirname "$0")"
swift build -c release --product listen >&2
exec "$(swift build -c release --show-bin-path)/listen" "$@"
