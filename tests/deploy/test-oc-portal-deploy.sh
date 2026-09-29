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
# old releases, and backing up the database. It is deliberately paranoid
# about staying inside a scratch tree: every path it will `rm -rf` is
# derived from OC_PORTAL_ROOT, so a failure to create that scratch tree
# (however unlikely) must never silently fall through to the real absolute
# paths -- which, run as root, would be the real guest layout.
#
#   OC_PORTAL_ROOT   prefixes every absolute path the remote-side script
#                    touches (read by oc-portal-deploy; empty in production).
#   OC_PORTAL_SSH    a local shim that runs the "remote" script directly,
#                    inheriting this process's environment (real ssh would
#                    not forward OC_PORTAL_ROOT, so production is unaffected).
#   PATH             is prepended with fakes for systemctl, curl, runuser,
#                    npm, npx, sqlite3, chown and sleep, so no real service,
#                    network call, privileged user switch or build happens.
if [ "$(id -u)" -eq 0 ]; then
  echo "FAIL fake-root simulation: refusing to run as root (a guard failing here would touch the real /opt/oc-portal, not a scratch copy)" >&2
  fail=1
else

assert_scratch_dir() { # dir label
  local d="$1" label="$2"
  [ -n "$d" ] || { echo "FATAL: $label is empty" >&2; exit 1; }
  case "$d" in
    /*) : ;;
    *) echo "FATAL: $label ('$d') is not an absolute path" >&2; exit 1 ;;
  esac
  [ "$d" != "/" ] || { echo "FATAL: $label is /" >&2; exit 1; }
  [ -d "$d" ] || { echo "FATAL: $label ('$d') does not exist" >&2; exit 1; }
}

sim_root="$(mktemp -d)" || exit 1
sim_repo="$(mktemp -d)" || exit 1
sim_bin="$(mktemp -d)" || exit 1
assert_scratch_dir "$sim_root" "sim_root (becomes OC_PORTAL_ROOT)"
assert_scratch_dir "$sim_repo" "sim_repo"
assert_scratch_dir "$sim_bin" "sim_bin"
cleanup_sim() { rm -rf "$sim_root" "$sim_repo" "$sim_bin"; }
trap cleanup_sim EXIT

mkdir -p "$sim_root/opt/oc-portal/releases" "$sim_root/var/lib/oc-portal/backups" "$sim_root/run" "$sim_root/fake-systemd"
echo fake-db-contents > "$sim_root/var/lib/oc-portal/portal.db"

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
    echo "restart $ver" >> "$state/call-order.log"
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
state="${OC_PORTAL_ROOT:-}/fake-systemd"
echo "backup" >> "$state/call-order.log" 2>/dev/null || true
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

cat > "$sim_bin/oc-ssh-shim-drop" <<'SH'
#!/bin/bash
# Simulates a dropped SSH connection: for the heredoc-script call shape (the
# one remote() uses for deploy/rollback), it captures stdin into a scratch
# file, launches the "remote" script fully detached (setsid, no stdio
# connected to us) and returns 255 -- OpenSSH's own convention for "the
# connection failed" -- without waiting, exactly as a real ssh client would
# if the network died mid-session while the remote process kept running.
# The raw single-command call shape (the tar upload, and oc-portal-deploy's
# own follow-up log/status queries) still runs synchronously and correctly,
# so only the deploy/rollback body itself is affected.
set -euo pipefail
if [ "${1:-}" = "bash -s" ] && [ "${2:-}" = "--" ]; then
  shift 2
  script_file="$(mktemp "${OC_PORTAL_ROOT:-/tmp}/drop-script.XXXXXX")"
  cat > "$script_file"
  setsid bash -s -- "$@" < "$script_file" > /dev/null 2>&1 &
  exit 255
else
  exec bash -c "${1:-}"
fi
SH
chmod +x "$sim_bin/oc-ssh-shim-drop"

sim_env() { env PATH="$sim_bin:$PATH" OC_PORTAL_ROOT="$sim_root" OC_PORTAL_SSH="$sim_bin/oc-ssh-shim" "$@"; }
D_SIM="$sim_repo/deploy/oc-portal-deploy"
current_tag() { basename "$(readlink "$sim_root/opt/oc-portal/current" 2>/dev/null)" 2>/dev/null; }
previous_tag() { basename "$(cat "$sim_root/opt/oc-portal/previous" 2>/dev/null)" 2>/dev/null; }

simcheck() { # expected-exit description command...
  local want="$1" what="$2"; shift 2
  local out; out="$(sim_env "$@" 2>&1)"; local got=$?
  if [ "$got" -eq "$want" ]; then echo "ok   $what"; else echo "FAIL $what (exit $got, wanted $want): $out"; fail=1; fi
}
simassert() { # description condition...
  local what="$1"; shift
  if "$@"; then echo "ok   $what"; else echo "FAIL $what"; fail=1; fi
}
# Like simassert, but retries for up to ~10s: used only after a simulated
# dropped connection, where the guest-side script keeps running fully
# detached from this process (that's the point of the fix under test) and
# so its final state isn't guaranteed to have landed the instant our own
# (deliberately short) status-file poll gives up.
wait_until() { # description condition...
  local what="$1"; shift
  local i=0
  while [ "$i" -lt 100 ]; do
    if "$@"; then echo "ok   $what"; return 0; fi
    sleep 0.1
    i=$((i + 1))
  done
  echo "FAIL $what (timed out waiting for the detached run to finish)"; fail=1
}

simcheck 0 "sim: first deploy" "$D_SIM" deploy v1.0.0
simassert "sim: current is v1.0.0 after first deploy" [ "$(current_tag)" = v1.0.0 ]

simcheck 0 "sim: second deploy" "$D_SIM" deploy v1.0.1
simassert "sim: current is v1.0.1 after second deploy" [ "$(current_tag)" = v1.0.1 ]
simassert "sim: previous is v1.0.0 after second deploy" [ "$(previous_tag)" = v1.0.0 ]

simcheck 1 "sim: redeploy of current is refused" "$D_SIM" deploy v1.0.1
simassert "sim: current is unchanged after refused redeploy of current" [ "$(current_tag)" = v1.0.1 ]

simcheck 1 "sim: redeploy of previous (the rollback target) is refused" "$D_SIM" deploy v1.0.0
simassert "sim: current is unchanged after refused redeploy of previous" [ "$(current_tag)" = v1.0.1 ]
simassert "sim: previous is unchanged after refused redeploy of previous" [ "$(previous_tag)" = v1.0.0 ]
simassert "sim: the previous release's tree survives the refused redeploy" [ -d "$sim_root/opt/oc-portal/releases/v1.0.0" ]

prev_before_failures="$(previous_tag)"

touch "$sim_root/fake-systemd/npm-fail"
simcheck 1 "sim: failed build leaves current intact" "$D_SIM" deploy v1.0.2
simassert "sim: current is still v1.0.1 after a failed build" [ "$(current_tag)" = v1.0.1 ]
simassert "sim: previous is unchanged after a failed build" [ "$(previous_tag)" = "$prev_before_failures" ]
rm -f "$sim_root/fake-systemd/npm-fail"

touch "$sim_root/fake-systemd/unhealthy"
simcheck 1 "sim: an unhealthy release rolls back and exits 1" "$D_SIM" deploy v1.0.2
simassert "sim: current is v1.0.1 after an unhealthy rollback" [ "$(current_tag)" = v1.0.1 ]
simassert "sim: previous is unchanged after an unhealthy rollback" [ "$(previous_tag)" = "$prev_before_failures" ]
rm -f "$sim_root/fake-systemd/unhealthy"

echo v1.0.2 > "$sim_root/fake-systemd/restart-fail-for"
simcheck 1 "sim: a restart failure still rolls back" "$D_SIM" deploy v1.0.2
simassert "sim: current is v1.0.1 after a restart-failure rollback" [ "$(current_tag)" = v1.0.1 ]
simassert "sim: previous is unchanged after a restart-failure rollback" [ "$(previous_tag)" = "$prev_before_failures" ]
rm -f "$sim_root/fake-systemd/restart-fail-for"

# A dropped SSH connection must not leave a broken release live: the remote
# script no longer depends on the (now-gone) pipe once it redirects its own
# output to a log file, so it keeps running -- including its own rollback --
# entirely independently of the connection that started it.
touch "$sim_root/fake-systemd/unhealthy"
set +e
drop_out="$(env PATH="$sim_bin:$PATH" OC_PORTAL_ROOT="$sim_root" OC_PORTAL_SSH="$sim_bin/oc-ssh-shim-drop" "$D_SIM" deploy v1.0.2 2>&1)"
drop_rc=$?
set -e
if [ "$drop_rc" -eq 1 ]; then
  echo "ok   sim: a dropped connection during the health window is reported as a failure"
else
  echo "FAIL sim: dropped-connection deploy exit was $drop_rc, wanted 1: $drop_out"
  fail=1
fi
wait_until "sim: current is v1.0.1 after a dropped-connection rollback" bash -c '[ "$(basename "$(readlink "'"$sim_root"'/opt/oc-portal/current" 2>/dev/null)")" = v1.0.1 ]'
simassert "sim: previous is unchanged after a dropped-connection rollback" [ "$(previous_tag)" = "$prev_before_failures" ]
rm -f "$sim_root/fake-systemd/unhealthy"

rm -f "$sim_root/fake-systemd/call-order.log"
sim_env "$D_SIM" deploy v1.0.3 >/dev/null 2>&1
simassert "sim: the pre-deploy DB backup happens before the switch (restart)" bash -c '
  log="'"$sim_root"'/fake-systemd/call-order.log"
  b=$(grep -n "^backup" "$log" 2>/dev/null | head -1 | cut -d: -f1)
  r=$(grep -n "^restart" "$log" 2>/dev/null | head -1 | cut -d: -f1)
  [ -n "$b" ] && [ -n "$r" ] && [ "$b" -lt "$r" ]
'
sim_env "$D_SIM" deploy v1.0.4 >/dev/null 2>&1
simassert "sim: current is v1.0.4 after further deploys" [ "$(current_tag)" = v1.0.4 ]
simassert "sim: pruning keeps current (v1.0.4)" [ -d "$sim_root/opt/oc-portal/releases/v1.0.4" ]
simassert "sim: pruning keeps previous (v1.0.3)" [ -d "$sim_root/opt/oc-portal/releases/v1.0.3" ]
simassert "sim: pruning removes the oldest release (v1.0.0)" [ ! -d "$sim_root/opt/oc-portal/releases/v1.0.0" ]

simcheck 0 "sim: rollback" "$D_SIM" rollback
simassert "sim: current is v1.0.3 after rollback" [ "$(current_tag)" = v1.0.3 ]
simassert "sim: rollback backs up the database first" bash -c 'compgen -G "'"$sim_root"'/var/lib/oc-portal/backups/pre-rollback-v1.0.3-*.db" >/dev/null'

fi

exit $fail
