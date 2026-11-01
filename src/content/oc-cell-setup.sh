#!/bin/bash
# OpenCell base station setup (portal spec §6.3). You can read all of it before
# running it: open the same address in a browser. On a Raspberry Pi with one
# OpenCell W12 board on USB, as root, it:
#   1. installs what it needs to build (apt), then builds and installs oc-cell
#      from the OpenCell source below, checked against its SHA-256;
#   2. makes the node's private key here, on this Pi; the key never leaves it;
#   3. sends a certificate request with your one-time setup token;
#   4. installs the certificate and settings it gets back;
#   5. starts the oc-cell service.
# Run again with a new setup command: it keeps this Pi's key, unless you add
# --new-key (`... | sudo bash -s -- --new-key`), and asks for a new certificate.
set -euo pipefail

#@VALUES@

die() {
  echo "OpenCell setup: $*" >&2
  exit 1
}

say() {
  echo "==> $*"
}

# Atomic: a link is replaced, never missing for a moment.
link() { # TARGET LINK
  ln -sfn -- "$1" "$2.new"
  mv -Tf -- "$2.new" "$2"
}

# The checks that stop before anything changes, and before the token is used.
preflight() {
  [ "$(id -u)" = 0 ] || die "please run this as root: curl ... | sudo bash"
  case "$(uname -m)" in
    aarch64 | armv7l) ;;
    *) die "this is for a Raspberry Pi (aarch64 or armv7l), and this machine is $(uname -m)" ;;
  esac
  [ -r "$PREFIX/etc/os-release" ] || die "this is for Raspberry Pi OS or Debian 12 or newer: no /etc/os-release here"
  local id version like
  # shellcheck disable=SC1091
  id=$(. "$PREFIX/etc/os-release" && echo "${ID:-}")
  # shellcheck disable=SC1091
  like=$(. "$PREFIX/etc/os-release" && echo "${ID_LIKE:-}")
  # shellcheck disable=SC1091
  version=$(. "$PREFIX/etc/os-release" && echo "${VERSION_ID:-0}")
  case " $id $like " in
    *" debian "* | *" raspbian "*) ;;
    *) die "this is for Raspberry Pi OS or Debian 12 or newer, and this is '$id'" ;;
  esac
  [[ $version =~ ^[0-9]+ ]] && [ "${BASH_REMATCH[0]}" -ge 12 ] || die "this needs Debian 12 or newer, and this is version '$version'"
  command -v systemctl >/dev/null || die "this needs systemd"
  local boards=("$PREFIX"/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_*-if00)
  [ "${#boards[@]}" -gt 0 ] || die "no OpenCell W12 board on USB: plug it in, and run the same command again (it has not been used)"
  if [ "${#boards[@]}" -gt 1 ]; then
    printf '  %s\n' "${boards[@]#"$PREFIX"}" >&2
    die "more than one W12 board on USB: oc-cell drives one. Leave one plugged in, and run the same command again (it has not been used)"
  fi
  BOARD=${boards[0]#"$PREFIX"}
  [[ $BOARD =~ ^[A-Za-z0-9_:./-]+$ ]] || die "that board's name looks wrong: $BOARD"
}

packages() {
  [ "$SKIP_APT" = 1 ] && return 0
  say "Installing the build tools"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends cmake make gcc libc6-dev libssl-dev libsqlite3-dev openssl ca-certificates curl
}

# oc-deploy's layout (network-core spec §17.4), so a later oc-deploy from the
# laptop takes over: <lib>/<tag>/bin/oc-cell, current, previous.
install_build() {
  local lib="$PREFIX/usr/local/lib/opencell/oc-cell" cur=""
  [ -L "$lib/current" ] && cur=$(readlink "$lib/current")
  if [ "$cur" = "$TAG" ] && [ -x "$lib/$TAG/bin/oc-cell" ]; then
    say "oc-cell $TAG is installed already"
  else
    say "Downloading the oc-cell $TAG source"
    curl -fsSL --max-time 900 -o "$WORK/oc-cell.tgz" "$ORIGIN/setup/$TOKEN/oc-cell.tgz" || die "the download failed: check this Pi's internet connection, and run the same command again"
    echo "$SHA256  $WORK/oc-cell.tgz" | sha256sum -c --quiet - || die "the download does not match its SHA-256: run the same command again"
    # Built by nobody, in a directory of its own; root only installs the result.
    mkdir -p "$WORK/src" "$WORK/build"
    tar -xzf "$WORK/oc-cell.tgz" --no-same-owner -C "$WORK/src"
    chown -R nobody "$WORK"
    say "Building oc-cell $TAG (a few minutes on a Pi)"
    runuser -u nobody -- cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=RelWithDebInfo -DOC_PI_TESTS=OFF "-DOC_VERSION=$TAG" || die "cmake failed"
    runuser -u nobody -- cmake --build "$WORK/build" -j2 || die "the build failed"
    local new="$lib/.new-$TAG"
    rm -rf -- "$new"
    mkdir -p -- "$lib"
    cmake --install "$WORK/build" --prefix "$new" >/dev/null
    [ -x "$new/bin/oc-cell" ] || die "the build installed no oc-cell"
    local ver
    ver=$("$new/bin/oc-cell" --version 2>&1 || true)
    case "$ver" in
      "oc-cell $TAG" | "oc-cell $TAG "*) ;;
      *) die "the build says '$ver', not 'oc-cell $TAG'" ;;
    esac
    install -m 0644 "$WORK/src/dist/systemd/oc-cell.service" "$new/oc-cell.service"
    install -m 0644 "$WORK/src/dist/systemd/system.conf.d/10-opencell-cpus.conf" "$new/10-opencell-cpus.conf"
    rm -rf -- "${lib:?}/$TAG"
    mv -T -- "$new" "$lib/$TAG"
    link "$TAG" "$lib/current"
    if [ -n "$cur" ] && [ "$cur" != "$TAG" ]; then link "$cur" "$lib/previous"; fi
    mkdir -p -- "$PREFIX/usr/local/bin"
    link "../lib/opencell/oc-cell/current/bin/oc-cell" "$PREFIX/usr/local/bin/oc-cell"
  fi
  mkdir -p -- "$PREFIX/etc/systemd/system"
  install -m 0644 "$lib/$TAG/oc-cell.service" "$PREFIX/etc/systemd/system/oc-cell.service"
  if [ -f "$lib/$TAG/10-opencell-cpus.conf" ]; then
    mkdir -p -- "$PREFIX/etc/systemd/system.conf.d"
    if ! cmp -s "$lib/$TAG/10-opencell-cpus.conf" "$PREFIX/etc/systemd/system.conf.d/10-opencell-cpus.conf"; then
      install -m 0644 "$lib/$TAG/10-opencell-cpus.conf" "$PREFIX/etc/systemd/system.conf.d/10-opencell-cpus.conf"
      REEXEC=1
    fi
  fi
}

account() {
  groupadd -f oc-cell
  getent passwd oc-cell >/dev/null || useradd --system -g oc-cell -G dialout --no-create-home --shell /usr/sbin/nologin oc-cell
  ETC="$PREFIX/etc/opencell"
  mkdir -p -- "$ETC"
  chmod 0750 "$ETC"
  chown root:oc-cell "$ETC"
}

# The key is made here, and only here. A new key takes its place only once a
# certificate for it has come back: a failure leaves the node as it was.
make_key() {
  KEY="$ETC/cell.key"
  if [ "$1" = 1 ] || [ ! -e "$KEY" ]; then
    say "Making this node's private key (it stays on this Pi)"
    KEY="$ETC/cell.key.new"
    (umask 0077 && openssl ecparam -name prime256v1 -genkey -noout -out "$KEY")
  else
    say "Keeping this node's private key"
    openssl pkey -in "$KEY" -noout 2>/dev/null || die "$KEY is not a key. To make a new one, add --new-key"
  fi
  openssl req -new -key "$KEY" -subj /CN=oc-cell -out "$WORK/csr"
}

request_certificate() {
  say "Asking for this node's certificate"
  if ! curl -sS --fail-with-body --max-time 60 -H "Origin: $ORIGIN" -H 'Content-Type: application/pkcs10' --data-binary "@$WORK/csr" -o "$WORK/bundle" "$ORIGIN/setup/$TOKEN/csr"; then
    [ -s "$WORK/bundle" ] && cat "$WORK/bundle" >&2
    die "no certificate. Nothing on this Pi changed"
  fi
}

# The answer's parts by their names, and only these three names.
split_bundle() {
  mkdir -p "$WORK/parts"
  awk -v dir="$WORK/parts" '
    /^--- / {
      name = substr($0, 5)
      if (name != "oc-cell.crt" && name != "ca.crt" && name != "oc-cell.conf") exit 3
      file = dir "/" name
      printf "" > file
      next
    }
    file == "" { exit 3 }
    { print > file }
  ' "$WORK/bundle" || die "the portal's answer makes no sense"
  local part
  for part in oc-cell.crt ca.crt oc-cell.conf; do
    [ -s "$WORK/parts/$part" ] || die "the portal's answer lacks $part"
  done
  [ "$(grep -c 'BEGIN CERTIFICATE' "$WORK/parts/oc-cell.crt")" = 2 ] || die "the certificate must come with its issuer"
  # The certificate must be for this key.
  [ "$(openssl x509 -in "$WORK/parts/oc-cell.crt" -noout -pubkey)" = "$(openssl pkey -in "$KEY" -pubout)" ] || die "the certificate is not for this node's key"
  sed -i "s|@BOARD@|$BOARD|" "$WORK/parts/oc-cell.conf"
}

install_files() {
  local part target
  for part in oc-cell.crt:cell.crt ca.crt:ca.crt oc-cell.conf:oc-cell.conf; do
    target="$ETC/${part#*:}"
    install -m 0640 "$WORK/parts/${part%%:*}" "$target.new"
    chown root:oc-cell "$target.new"
    mv -Tf -- "$target.new" "$target"
  done
  if [ "$KEY" = "$ETC/cell.key.new" ]; then
    chmod 0640 "$KEY"
    chown root:oc-cell "$KEY"
    mv -Tf -- "$KEY" "$ETC/cell.key"
  else
    chmod 0640 "$KEY"
    chown root:oc-cell "$KEY"
  fi
}

start_service() {
  say "Starting oc-cell"
  local was_active=0
  systemctl is-active --quiet oc-cell && was_active=1
  systemctl daemon-reload
  [ "$REEXEC" = 0 ] || systemctl daemon-reexec
  systemctl enable --now oc-cell
  [ "$was_active" = 0 ] || systemctl restart oc-cell
  local i
  for ((i = 0; i < 30; i++)); do
    systemctl is-active --quiet oc-cell && return 0
    sleep 1
  done
  die "oc-cell did not start. See: journalctl -u oc-cell -n 50"
}

main() {
  local new_key=0 a
  for a in "$@"; do
    case "$a" in
      --new-key) new_key=1 ;;
      *) die "unknown option: $a" ;;
    esac
  done
  PREFIX=""
  SKIP_APT=0
  # For the portal's own tests only: they run this on a machine that is no Pi.
  if [ "${OC_SETUP_TEST:-}" = 1 ]; then
    PREFIX=${OC_SETUP_PREFIX:-}
    SKIP_APT=${OC_SETUP_SKIP_APT:-0}
  fi
  REEXEC=0
  shopt -s nullglob
  preflight
  WORK=$(mktemp -d)
  trap 'rm -rf -- "$WORK"' EXIT
  packages
  install_build
  account
  make_key "$new_key"
  request_certificate
  split_bundle
  install_files
  start_service
  say "Done. Watch it come online on My nodes: $ORIGIN/nodes"
}

main "$@"
