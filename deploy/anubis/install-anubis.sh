#!/bin/bash
# Install or update Anubis in front of the portal, on the portal guest
# (LXC 116) or the NOC's guest (LXC 118, NOC design §N1.5), as root.
# lxc-bootstrap.sh runs it; it can also be run on its own from a copy of
# deploy/ (see deploy/anubis/README.md):
#   bash deploy/anubis/install-anubis.sh [portal|noc]
# The site picks the settings and the policy: oc-portal.env and
# oc-portal.botPolicies.yaml, or oc-noc.env and oc-noc.botPolicies.yaml.
# Either is installed under the one instance name, anubis@oc-portal, so the
# unit, its drop-in and oc-portal-deploy's status line are the same on both.
# Omitting it is safe (final review I1): it never silently assumes "portal".
# It is read from, in order, the marker this script writes on every run
# (the instance's own .site file, below), or OC_SITE in this guest's
# /etc/opencell/portal.env (Task 12's settings, written after bootstrap), or,
# for a guest already running a version of this script from before the
# marker existed, whichever of oc-portal.env/oc-noc.env the files already in
# place match byte for byte. Nothing found at all (a brand-new guest, nothing
# to clobber) falls back to portal. An explicit argument that contradicts
# what is already here is refused outright, never silently overridden.
# Idempotent: it installs the pinned .deb (release.env) only when that exact
# version is not already installed, after checking its SHA-256 and its
# signature by the pinned key; it puts the instance's environment, policy and
# systemd drop-in in place; it makes the JWT signing key once; and it
# restarts anubis@oc-portal only when something changed. While port 3000 is
# taken (by the portal, before its move to 127.0.0.1:3001) it neither enables
# nor starts Anubis, so a reboot can't race the two for the port: it says so
# and leaves `systemctl enable --now` to the operator.
# OC_PORTAL_ROOT prefixes every absolute path it touches (tests only, as in
# oc-portal-deploy; unset in production).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${OC_PORTAL_ROOT:-}"
INSTANCE=oc-portal
UNIT="anubis@$INSTANCE.service"
PORT=3000
MARKER="$ROOT/etc/anubis/$INSTANCE.site"

die() { echo "install-anubis: $*" >&2; exit 1; }

# Which site (if any) is already set up here (see the comment above).
detect_installed_site() {
  if [ -f "$MARKER" ]; then
    case "$(cat "$MARKER" 2>/dev/null || true)" in
      portal | noc) cat "$MARKER"; return ;;
    esac
  fi
  if [ -f "$ROOT/etc/opencell/portal.env" ]; then
    local v; v="$(sed -n 's/^OC_SITE=\(portal\|noc\)[[:space:]]*$/\1/p' "$ROOT/etc/opencell/portal.env" | tail -n 1)"
    if [ -n "$v" ]; then echo "$v"; return; fi
  fi
  local installed="$ROOT/etc/anubis/$INSTANCE.env"
  if [ -f "$installed" ]; then
    if cmp -s "$HERE/oc-noc.env" "$installed"; then echo noc; return; fi
    if cmp -s "$HERE/oc-portal.env" "$installed"; then echo portal; return; fi
  fi
  echo ""
}

if [ $# -gt 1 ]; then
  echo "usage: install-anubis.sh [portal|noc]" >&2
  exit 2
fi
detected="$(detect_installed_site)"
if [ $# -eq 1 ]; then
  SITE="$1"
  case "$SITE" in
    portal | noc) ;;
    *) echo "usage: install-anubis.sh [portal|noc] (got '$SITE')" >&2; exit 2 ;;
  esac
  if [ -n "$detected" ] && [ "$detected" != "$SITE" ]; then
    die "this guest is already set up as '$detected' ($MARKER, OC_SITE in $ROOT/etc/opencell/portal.env, or the files already installed); refusing to switch it to '$SITE'. Remove $MARKER first if this is really intended."
  fi
else
  SITE="${detected:-portal}"
fi
[ "$(id -u)" -eq 0 ] || [ -n "$ROOT" ] || die "run this as root on the portal guest"

# shellcheck source=release.env
. "$HERE/release.env"
: "${ANUBIS_VERSION:?release.env: ANUBIS_VERSION}" "${ANUBIS_DEB_SHA256_AMD64:?release.env: ANUBIS_DEB_SHA256_AMD64}" "${ANUBIS_SIGNING_KEY_FPR:?release.env: ANUBIS_SIGNING_KEY_FPR}"

arch="$(dpkg --print-architecture)"
[ "$arch" = amd64 ] || die "only the amd64 package is pinned; this guest is $arch"

changed=0
installed="$(dpkg-query -W -f='${Version}' anubis 2>/dev/null || true)"
if [ "$installed" != "$ANUBIS_VERSION" ]; then
  echo "install-anubis: installing Anubis $ANUBIS_VERSION (installed: ${installed:-none})"
  cache="$ROOT/var/cache/oc-portal-anubis"
  install -d -m 0700 "$cache"
  deb="anubis_${ANUBIS_VERSION}_amd64.deb"
  url="https://github.com/TecharoHQ/anubis/releases/download/v$ANUBIS_VERSION/$deb"
  rm -f "$cache/$deb" "$cache/$deb.asc"
  curl -fsSL --retry 3 -o "$cache/$deb" "$url"
  curl -fsSL --retry 3 -o "$cache/$deb.asc" "$url.asc"

  echo "$ANUBIS_DEB_SHA256_AMD64  $cache/$deb" | sha256sum -c --quiet - >/dev/null 2>&1 \
    || die "checksum mismatch: the download is not the pinned $deb (release.env); not installing it"

  gnupg="$(mktemp -d)"
  trap 'rm -rf "$gnupg"' EXIT
  gpg --homedir "$gnupg" --batch --quiet --dearmor -o "$gnupg/techaro.gpg" "$HERE/techaro-packages.asc"
  status="$(gpgv --status-fd 1 --keyring "$gnupg/techaro.gpg" "$cache/$deb.asc" "$cache/$deb" 2>/dev/null)" \
    || die "the signature on $deb does not verify with techaro-packages.asc; not installing it"
  # VALIDSIG's last field is the signing key's primary fingerprint.
  printf '%s\n' "$status" | grep -qE "^\[GNUPG:\] VALIDSIG .* $ANUBIS_SIGNING_KEY_FPR\$" \
    || die "$deb is not signed by the pinned key $ANUBIS_SIGNING_KEY_FPR; not installing it"

  DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$cache/$deb"
  now="$(dpkg-query -W -f='${Version}' anubis 2>/dev/null || true)"
  [ "$now" = "$ANUBIS_VERSION" ] || die "after installing, dpkg reports anubis '${now:-none}', not $ANUBIS_VERSION"
  changed=1
fi

# The instance's files. install(1) as root makes them root-owned.
place() { # mode source destination
  if ! cmp -s "$2" "$3"; then
    install -m "$1" "$2" "$3"
    echo "install-anubis: updated ${3#"$ROOT"}"
    changed=1
  fi
  chmod "$1" "$3"
}
install -d -m 0755 "$ROOT/etc/anubis" "$ROOT/etc/systemd/system/$UNIT.d"
place 0644 "$HERE/oc-$SITE.env" "$ROOT/etc/anubis/$INSTANCE.env"
place 0644 "$HERE/oc-$SITE.botPolicies.yaml" "$ROOT/etc/anubis/$INSTANCE.botPolicies.yaml"
place 0644 "$HERE/opencell.conf" "$ROOT/etc/systemd/system/$UNIT.d/opencell.conf"

# Final review I1: record the site every run, so the next one (even with no
# argument) knows it without guessing, however this guest got here. Writing
# it is not itself a "change" (it never restarts anything on its own).
if [ "$(cat "$MARKER" 2>/dev/null || true)" != "$SITE" ]; then
  printf '%s\n' "$SITE" > "$MARKER.new"
  mv -f "$MARKER.new" "$MARKER"
  chmod 0644 "$MARKER"
fi

key="$ROOT/etc/anubis/$INSTANCE.key.env"
if ! grep -qxE 'ED25519_PRIVATE_KEY_HEX=[0-9a-f]{64}' "$key" 2>/dev/null; then
  (umask 077 && printf 'ED25519_PRIVATE_KEY_HEX=%s\n' "$(openssl rand -hex 32)" > "$key.new")
  mv -f "$key.new" "$key"
  echo "install-anubis: made a new signing key (every earlier pass is void)"
  changed=1
fi
chmod 0600 "$key"

systemctl daemon-reload
if systemctl is-active --quiet "$UNIT"; then
  systemctl enable "$UNIT"
  if [ "$changed" -eq 1 ]; then
    systemctl restart "$UNIT"
    echo "install-anubis: restarted $UNIT"
  else
    echo "install-anubis: $UNIT unchanged and running"
  fi
elif [ -n "$(ss -Hltn "sport = :$PORT")" ]; then
  # Not even enabled: after a reboot it would race the portal for the port.
  echo "install-anubis: port $PORT is still taken (the portal, not yet moved to 127.0.0.1:3001?):" >&2
  echo "install-anubis: $UNIT is installed but neither enabled nor started; once the portal" >&2
  echo "install-anubis: is on 3001, run: systemctl enable --now $UNIT" >&2
else
  systemctl enable --now "$UNIT"
  echo "install-anubis: enabled and started $UNIT"
fi
