#!/bin/sh
# Builds listen, then becomes it (exec), so Ctrl-C in the terminal reaches listen itself rather than a wrapper
# that exits and leaves it recording.
set -e
cd "$(dirname "$0")"
swift build -c release --product listen >&2
exec "$(swift build -c release --show-bin-path)/listen" "$@"
