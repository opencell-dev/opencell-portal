#!/bin/bash
# The deploy script's local checks: it refuses anything but an existing
# vX.Y.Z tag before touching the network. (OC_PORTAL_SSH=false makes any
# network step fail loudly.)
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
D=deploy/oc-portal-deploy
fail=0
check() { # expected-exit description command...
  local want="$1" what="$2"; shift 2
  local out; out="$("$@" 2>&1)"; local got=$?
  if [ "$got" -eq "$want" ]; then echo "ok   $what"; else echo "FAIL $what (exit $got, wanted $want): $out"; fail=1; fi
}
export OC_PORTAL_SSH=false
check 2 "no command" $D
check 2 "unknown command" $D frobnicate
check 2 "a branch name is not deployed" $D deploy main
check 2 "a tag without v is not deployed" $D deploy 1.2.3
check 2 "a missing tag is refused" $D deploy v99.99.99
check 2 "rollback takes no argument" $D rollback v1.0.0
check 1 "the network step runs through OC_PORTAL_SSH" $D status
bash -n $D deploy/lxc-bootstrap.sh deploy/oc-portal-admin deploy/oc-portal-backup && echo "ok   bash -n" || fail=1

# --- fake-root simulation of the remote script ------------------------------
# The checks above never reach the network. This section runs the deploy
# script for real -- against a scratch "guest" tree instead of an actual
# host -- to exercise the logic that only ever executes on the far side of
# the SSH call: switching `current`, health-checking, rolling back, pruning
# old releases, and backing up the database.
#
#   OC_PORTAL_ROOT   prefixes every absolute path the remote-side script
#                    touches (read by oc-portal-deploy; empty in production).
#   OC_PORTAL_SSH    a local shim that runs the "remote" script directly,
#                    inheriting this process's environment (real ssh would
#                    not forward OC_PORTAL_ROOT, so production is unaffected).
#   PATH             is prepended with fakes for systemctl, curl, runuser,
#                    npm, npx, sqlite3, chown and sleep, so no real service,
#                    network call, privileged user switch or build happens.
sim_root="$(mktemp -d)"
sim_repo="$(mktemp -d)"
sim_bin="$(mktemp -d)"
cleanup_sim() { rm -rf "$sim_root" "$sim_repo" "$sim_bin"; }
trap cleanup_sim EXIT

mkdir -p "$sim_root/opt/oc-portal/releases" "$sim_root/var/lib/oc-portal/backups" "$sim_root/run" "$sim_root/fake-systemd"

# A throwaway repo with the working tree's current deploy/ scripts (so the
# fix under test runs, not the last commit), tagged several times. All tags
# point at the same commit -- content doesn't matter, since npm/npx below
# never really build anything.
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.next' ./ "$sim_repo/" >/dev/null
git -C "$sim_repo" init -q
git -C "$sim_repo" -c user.email=t@t -c user.name=t add -A
git -C "$sim_repo" -c user.email=t@t -c user.name=t commit -q -m base
for t in v1.0.0 v1.0.1 v1.0.2 v1.0.3 v1.0.4; do git -C "$sim_repo" tag "$t"; done

cat > "$sim_bin/systemctl" <<'SH'
#!/bin/bash
state="${OC_PORTAL_ROOT:-}/fake-systemd"
mkdir -p "$state"
case "$1" in
  restart)
    ver="$(sed -n 's/^OC_VERSION=//p' "${OC_PORTAL_ROOT:-}/opt/oc-portal/current/.version.env" 2>/dev/null)"
    failfor="$(cat "$state/restart-fail-for" 2>/dev/null || true)"
    if [ -n "$failfor" ] && [ "$ver" = "$failfor" ]; then
      echo "fake systemctl: restart failed for $ver" >&2
      exit 1
    fi
    echo "$ver" > "$state/serving-version"
    echo active > "$state/active"
    ;;
  is-active) cat "$state/active" 2>/dev/null || echo inactive ;;
  *) : ;;
esac
SH

cat > "$sim_bin/curl" <<'SH'
#!/bin/bash
state="${OC_PORTAL_ROOT:-}/fake-systemd"
[ -f "$state/unhealthy" ] && exit 7
ver="$(cat "$state/serving-version" 2>/dev/null)"
[ -n "$ver" ] || exit 7
printf '{"ok":true,"version":"%s"}' "$ver"
SH

cat > "$sim_bin/runuser" <<'SH'
#!/bin/bash
# fake runuser: drops "-u USER --" and just runs the rest as this user.
args=(); skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -u) skip=1 ;;
    --) ;;
    *) args+=("$a") ;;
  esac
done
exec "${args[@]}"
SH

cat > "$sim_bin/npm" <<'SH'
#!/bin/bash
state="${OC_PORTAL_ROOT:-}/fake-systemd"
[ -f "$state/npm-fail" ] && { echo "fake npm: forced failure" >&2; exit 1; }
mkdir -p node_modules && : > node_modules/.fake
SH

cat > "$sim_bin/npx" <<'SH'
#!/bin/bash
mkdir -p .next && : > .next/.fake
SH

cat > "$sim_bin/sqlite3" <<'SH'
#!/bin/bash
# fake sqlite3: only understands `sqlite3 DB ".backup 'DEST'"`.
db="$1"; shift
dest="$(printf '%s' "$*" | sed -n "s/.*\.backup '\([^']*\)'.*/\1/p")"
[ -n "$dest" ] && cp -f "$db" "$dest" 2>/dev/null
exit 0
SH

cat > "$sim_bin/chown" <<'SH'
#!/bin/bash
exit 0
SH

cat > "$sim_bin/sleep" <<'SH'
#!/bin/bash
exit 0
SH

chmod +x "$sim_bin"/*

cat > "$sim_bin/oc-ssh-shim" <<'SH'
#!/bin/bash
# Local stand-in for OC_PORTAL_SSH: runs the "remote" command directly
# (inheriting env and PATH) instead of connecting anywhere.
set -euo pipefail
if [ "${1:-}" = "bash -s" ] && [ "${2:-}" = "--" ]; then
  shift 2
  exec bash -s -- "$@"
else
  exec bash -c "${1:-}"
fi
SH
chmod +x "$sim_bin/oc-ssh-shim"

sim_env() { env PATH="$sim_bin:$PATH" OC_PORTAL_ROOT="$sim_root" OC_PORTAL_SSH="$sim_bin/oc-ssh-shim" "$@"; }
D_SIM="$sim_repo/deploy/oc-portal-deploy"
current_tag() { basename "$(readlink "$sim_root/opt/oc-portal/current" 2>/dev/null)" 2>/dev/null; }

simcheck() { # expected-exit description command...
  local want="$1" what="$2"; shift 2
  local out; out="$(sim_env "$@" 2>&1)"; local got=$?
  if [ "$got" -eq "$want" ]; then echo "ok   $what"; else echo "FAIL $what (exit $got, wanted $want): $out"; fail=1; fi
}
simassert() { # description condition...
  local what="$1"; shift
  if "$@"; then echo "ok   $what"; else echo "FAIL $what"; fail=1; fi
}

simcheck 0 "sim: first deploy" "$D_SIM" deploy v1.0.0
simassert "sim: current is v1.0.0 after first deploy" [ "$(current_tag)" = v1.0.0 ]

simcheck 0 "sim: second deploy" "$D_SIM" deploy v1.0.1
simassert "sim: current is v1.0.1 after second deploy" [ "$(current_tag)" = v1.0.1 ]
simassert "sim: previous is v1.0.0 after second deploy" [ "$(basename "$(cat "$sim_root/opt/oc-portal/previous")")" = v1.0.0 ]

simcheck 1 "sim: redeploy of current is refused" "$D_SIM" deploy v1.0.1
simassert "sim: current is unchanged after refused redeploy" [ "$(current_tag)" = v1.0.1 ]

touch "$sim_root/fake-systemd/npm-fail"
simcheck 1 "sim: failed build leaves current intact" "$D_SIM" deploy v1.0.2
simassert "sim: current is still v1.0.1 after a failed build" [ "$(current_tag)" = v1.0.1 ]
rm -f "$sim_root/fake-systemd/npm-fail"

touch "$sim_root/fake-systemd/unhealthy"
simcheck 1 "sim: an unhealthy release rolls back and exits 1" "$D_SIM" deploy v1.0.2
simassert "sim: current is v1.0.1 after an unhealthy rollback" [ "$(current_tag)" = v1.0.1 ]
rm -f "$sim_root/fake-systemd/unhealthy"

echo v1.0.2 > "$sim_root/fake-systemd/restart-fail-for"
simcheck 1 "sim: a restart failure still rolls back" "$D_SIM" deploy v1.0.2
simassert "sim: current is v1.0.1 after a restart-failure rollback" [ "$(current_tag)" = v1.0.1 ]
rm -f "$sim_root/fake-systemd/restart-fail-for"

sim_env "$D_SIM" deploy v1.0.3 >/dev/null 2>&1
sim_env "$D_SIM" deploy v1.0.4 >/dev/null 2>&1
simassert "sim: current is v1.0.4 after further deploys" [ "$(current_tag)" = v1.0.4 ]
simassert "sim: pruning keeps current (v1.0.4)" [ -d "$sim_root/opt/oc-portal/releases/v1.0.4" ]
simassert "sim: pruning keeps previous (v1.0.3)" [ -d "$sim_root/opt/oc-portal/releases/v1.0.3" ]
simassert "sim: pruning removes the oldest release (v1.0.0)" [ ! -d "$sim_root/opt/oc-portal/releases/v1.0.0" ]

echo fake-db-contents > "$sim_root/var/lib/oc-portal/portal.db"
simcheck 0 "sim: rollback" "$D_SIM" rollback
simassert "sim: current is v1.0.3 after rollback" [ "$(current_tag)" = v1.0.3 ]
simassert "sim: rollback backs up the database first" bash -c 'compgen -G "'"$sim_root"'/var/lib/oc-portal/backups/pre-rollback-v1.0.3-*.db" >/dev/null'

exit $fail
