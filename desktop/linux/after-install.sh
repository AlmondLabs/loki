#!/bin/sh
# Ubuntu 24.04 and later let only programs with an AppArmor profile make user namespaces, which Chromium's sandbox
# needs; this profile gives loki that and nothing more.
set -e
if [ -d /etc/apparmor.d ]; then
  cat > /etc/apparmor.d/loki <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile loki /opt/loki/loki flags=(unconfined) {
  userns,
  include if exists <local/loki>
}
PROFILE
  if command -v apparmor_parser >/dev/null 2>&1; then apparmor_parser -r /etc/apparmor.d/loki || true; fi
fi
