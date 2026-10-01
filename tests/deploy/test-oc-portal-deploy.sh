#!/bin/bash
# The deploy script's local checks: it refuses anything but an existing
# vX.Y.Z tag before touching the network. (OC_PORTAL_SSH=false makes any
# network step fail loudly.)
# No `set -e`: every check below must run and report, whatever the one
# before it did (each records a failure in $fail instead).
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
bash -n $D deploy/lxc-bootstrap.sh deploy/oc-portal-admin deploy/oc-portal-backup deploy/anubis/install-anubis.sh && echo "ok   bash -n" || fail=1

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

mkdir -p "$sim_root/opt/oc-portal/releases" "$sim_root/var/lib/oc-portal/backups" "$sim_root/var/lib/oc-portal-deploy/status" "$sim_root/var/log" "$sim_root/run" "$sim_root/fake-systemd"
# The modes bootstrap/the OS give these on the guest, whatever this shell's
# umask: the deploy script refuses group- or other-writable ones.
chmod 0700 "$sim_root/var/lib/oc-portal-deploy" "$sim_root/var/lib/oc-portal-deploy/status"
chmod 0755 "$sim_root/var/log" "$sim_root/run"
echo fake-db-contents > "$sim_root/var/lib/oc-portal/portal.db"

# A throwaway repo with the working tree's current deploy/ scripts (so the
# fix under test runs, not the last commit), tagged several times. All tags
# point at the same commit -- content doesn't matter, since npm/npx below
# never really build anything.
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.next' ./ "$sim_repo/" >/dev/null
git -C "$sim_repo" init -q
git -C "$sim_repo" -c user.email=t@t -c user.name=t add -A
git -C "$sim_repo" -c user.email=t@t -c user.name=t commit -q -m base
for t in v1.0.0 v1.0.1 v1.0.2 v1.0.3 v1.0.4 v1.0.5 v1.0.6 v1.0.7 v1.0.8 v1.0.9 v1.0.10 v1.0.11; do git -C "$sim_repo" tag "$t"; done

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
echo "${@: -1}" >> "$state/curl-urls.log" 2>/dev/null || true
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
# fake-systemd/build-seconds makes the "build" take that long (real sleep:
# the fake `sleep` below is a no-op), for the SSH-call-rate checks.
state="${OC_PORTAL_ROOT:-}/fake-systemd"
secs="$(cat "$state/build-seconds" 2>/dev/null || echo 0)"
command -p sleep "$secs"
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
# (inheriting env and PATH) instead of connecting anywhere. With
# OC_PORTAL_SSH_COUNT set, every invocation appends a line to that file.
set -euo pipefail
if [ -n "${OC_PORTAL_SSH_COUNT:-}" ]; then echo call >> "$OC_PORTAL_SSH_COUNT"; fi
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
# file, waits OC_PORTAL_DROP_DELAY seconds (default 0 -- lets a test make
# the guest slower than the laptop's first few status polls without that
# delay living inside the remote script itself), launches the "remote"
# script fully detached (setsid, no stdio connected to us) and returns 255
# -- OpenSSH's own convention for "the connection failed" -- without
# waiting, exactly as a real ssh client would if the network died
# mid-session while the remote process kept running. The raw single-command
# call shape (the tar upload, and oc-portal-deploy's own follow-up log/
# status queries) still runs synchronously and correctly, so only the
# deploy/rollback body itself is affected. Counts calls like oc-ssh-shim.
set -euo pipefail
if [ -n "${OC_PORTAL_SSH_COUNT:-}" ]; then echo call >> "$OC_PORTAL_SSH_COUNT"; fi
if [ "${1:-}" = "bash -s" ] && [ "${2:-}" = "--" ]; then
  shift 2
  script_file="$(mktemp "${OC_PORTAL_ROOT:-/tmp}/drop-script.XXXXXX")"
  cat > "$script_file"
  delay="${OC_PORTAL_DROP_DELAY:-0}"
  ( command -p sleep "$delay"; setsid bash -s -- "$@" < "$script_file" ) > /dev/null 2>&1 &
  # OC_PORTAL_DROP_AFTER: how long the "connection" stays up before it
  # drops (default 0), so the live follower has already shown some lines.
  command -p sleep "${OC_PORTAL_DROP_AFTER:-0}"
  exit 255
else
  exec bash -c "${1:-}"
fi
SH
chmod +x "$sim_bin/oc-ssh-shim-drop"

cat > "$sim_bin/oc-ssh-shim-truncate" <<'SH'
#!/bin/bash
# Simulates a transfer cut just before the script's last line: the
# deploy/rollback body arrives without its final `main "$@"`, so the guest's
# bash defines main, never calls it, and exits 0 having done nothing.
set -euo pipefail
if [ "${1:-}" = "bash -s" ] && [ "${2:-}" = "--" ]; then
  shift 2
  head -n -1 | bash -s -- "$@"
else
  exec bash -c "${1:-}"
fi
SH
chmod +x "$sim_bin/oc-ssh-shim-truncate"

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
# entirely independently of the connection that started it. It must also
# report the *real* outcome, not a guess: "guest recorded exit N" and "no
# status recorded yet" are deliberately distinct messages (never suggesting
# a re-run, which for `rollback` would reverse a rollback that in fact
# already succeeded), so each case below checks the actual text.
touch "$sim_root/fake-systemd/unhealthy"
drop_out="$(env PATH="$sim_bin:$PATH" OC_PORTAL_ROOT="$sim_root" OC_PORTAL_SSH="$sim_bin/oc-ssh-shim-drop" "$D_SIM" deploy v1.0.2 2>&1)"
drop_rc=$?
if [ "$drop_rc" -eq 1 ] && printf '%s' "$drop_out" | grep -q "guest recorded exit 1"; then
  echo "ok   sim: a dropped connection during the health window reports the guest's real outcome"
else
  echo "FAIL sim: dropped-connection deploy exit was $drop_rc, wanted 1 with a 'guest recorded exit' message: $drop_out"
  fail=1
fi
simassert "sim: current is v1.0.1 after a dropped-connection rollback" [ "$(current_tag)" = v1.0.1 ]
simassert "sim: previous is unchanged after a dropped-connection rollback" [ "$(previous_tag)" = "$prev_before_failures" ]
rm -f "$sim_root/fake-systemd/unhealthy"

# The guest can legitimately outlast the laptop's *first few* polls (a slow
# build, a slow health check) without that meaning "unknown": as long as it
# finishes inside the poll budget, the laptop must still report the real
# (here: rolled-back) outcome. OC_PORTAL_DROP_DELAY only delays how long the
# shim waits before even starting the detached guest script -- nothing here
# touches the *guest-side* fake `sleep`, so this exercises genuine
# wall-clock waiting on the laptop side (bypassing PATH via `command -p`, so
# that guest-side fake `sleep` could never shrink it).
touch "$sim_root/fake-systemd/unhealthy"
slow_out="$(env PATH="$sim_bin:$PATH" OC_PORTAL_ROOT="$sim_root" OC_PORTAL_SSH="$sim_bin/oc-ssh-shim-drop" OC_PORTAL_DROP_DELAY=1 OC_PORTAL_DEPLOY_POLL_BUDGET=3 OC_PORTAL_DEPLOY_POLL_INTERVAL=0.2 "$D_SIM" deploy v1.0.5 2>&1)"
slow_rc=$?
if [ "$slow_rc" -eq 1 ] && printf '%s' "$slow_out" | grep -q "guest recorded exit 1"; then
  echo "ok   sim: a guest slower than the first few polls still gets its real outcome reported"
else
  echo "FAIL sim: outlasting-the-first-polls deploy exit was $slow_rc, wanted 1 with a 'guest recorded exit' message: $slow_out"
  fail=1
fi
simassert "sim: current is v1.0.1 after outlasting the first polls" [ "$(current_tag)" = v1.0.1 ]
rm -f "$sim_root/fake-systemd/unhealthy"

# If the guest genuinely outlasts the *whole* poll budget, the laptop must
# say so plainly -- never claim a result it doesn't have, and never suggest
# re-running deploy or rollback.
touch "$sim_root/fake-systemd/unhealthy"
unknown_out="$(env PATH="$sim_bin:$PATH" OC_PORTAL_ROOT="$sim_root" OC_PORTAL_SSH="$sim_bin/oc-ssh-shim-drop" OC_PORTAL_DROP_DELAY=4 OC_PORTAL_DEPLOY_POLL_BUDGET=2 OC_PORTAL_DEPLOY_POLL_INTERVAL=0.2 "$D_SIM" deploy v1.0.6 2>&1)"
unknown_rc=$?
if [ "$unknown_rc" -eq 1 ] \
  && printf '%s' "$unknown_out" | grep -q "no status recorded yet" \
  && ! printf '%s' "$unknown_out" | grep -q "guest recorded exit" \
  && printf '%s' "$unknown_out" | grep -q "do not just re-run"; then
  echo "ok   sim: a guest that outlasts the whole poll budget says so, and explicitly warns against re-running"
else
  echo "FAIL sim: budget-exceeded deploy exit was $unknown_rc: $unknown_out"
  fail=1
fi
# The detached run is still in flight at this point (by design -- that's
# what "budget exceeded" means); wait for *this specific run* to record its
# own status before checking the outcome or moving on -- checking `current`
# directly here would be a vacuous pass, since it can already happen to
# equal v1.0.1 from an earlier scenario while this run is still asleep, and
# proceeding before it actually finishes races the next deploys below (it
# raced in exactly this way while this test was being written).
unknown_run_id="$(printf '%s' "$unknown_out" | grep -oE '[0-9]{8}T[0-9]{6}Z-[0-9]+' | head -1)"
wait_until "sim: the slow guest eventually records its own status" bash -c '[ -f "'"$sim_root"'/var/lib/oc-portal-deploy/status/'"$unknown_run_id"'" ]'
simassert "sim: current is v1.0.1 once the slow guest actually finishes" [ "$(current_tag)" = v1.0.1 ]
rm -f "$sim_root/fake-systemd/unhealthy"

# Case K: a symlinked deploy-status directory (as if a compromised
# oc-portal service user had swapped it) must be refused outright, and
# nothing on the far side of that symlink may be touched -- not even a
# chmod -- before the refusal.
decoy_dir="$(mktemp -d)" || exit 1
chmod 0755 "$decoy_dir"
rm -rf "$sim_root/var/lib/oc-portal-deploy/status"
ln -s "$decoy_dir" "$sim_root/var/lib/oc-portal-deploy/status"
symlink_out="$(sim_env "$D_SIM" deploy v1.0.7 2>&1)"
symlink_rc=$?
if [ "$symlink_rc" -eq 1 ] && printf '%s' "$symlink_out" | grep -q "is a symlink"; then
  echo "ok   sim: a symlinked deploy-status directory is refused"
else
  echo "FAIL sim: symlinked-status-dir deploy exit was $symlink_rc, wanted 1 naming the symlink: $symlink_out"
  fail=1
fi
simassert "sim: the decoy directory's permissions are untouched (nothing chmod'ed)" bash -c "[ \"\$(stat -c %a '$decoy_dir')\" = 755 ]"
simassert "sim: current is unchanged after the symlink refusal" [ "$(current_tag)" = v1.0.1 ]
rm -f "$sim_root/var/lib/oc-portal-deploy/status"
rmdir "$decoy_dir"
mkdir -m 0700 "$sim_root/var/lib/oc-portal-deploy/status"

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

# A directory anyone but its owner can write to is refused like a symlink.
chmod 0775 "$sim_root/var/log"
gw_out="$(sim_env "$D_SIM" deploy v1.0.8 2>&1)"
gw_rc=$?
chmod 0755 "$sim_root/var/log"
if [ "$gw_rc" -eq 1 ] && printf '%s' "$gw_out" | grep -q "group- or other-writable"; then
  echo "ok   sim: a group-writable log directory is refused"
else
  echo "FAIL sim: group-writable log dir deploy exit was $gw_rc, wanted 1 naming the mode: $gw_out"
  fail=1
fi
simassert "sim: current is unchanged after the group-writable refusal" [ "$(current_tag)" = v1.0.3 ]

# Case L: while run A holds the deploy lock, a refused run B must not
# replace A as the "latest run" -- status keeps reporting A (in progress),
# and once A's lock is gone without a status, reports it as interrupted.
latest_file="$sim_root/var/lib/oc-portal-deploy/latest-run-id"
run_a="20260101T000000Z-4242"
echo "$run_a" > "$latest_file"
exec 8>"$sim_root/run/oc-portal-deploy.lock"
if flock -n 8; then
  lock_out="$(sim_env "$D_SIM" deploy v1.0.8 2>&1 8>&-)"
  lock_rc=$?
  status_busy="$(sim_env "$D_SIM" status 2>&1 8>&-)"
  if [ "$lock_rc" -eq 1 ] && printf '%s' "$lock_out" | grep -q "another deploy/rollback is in progress" \
    && printf '%s' "$lock_out" | grep -q "guest recorded exit 1"; then
    echo "ok   sim: case L: a deploy while the lock is held is refused"
  else
    echo "FAIL sim: case L: locked deploy exit was $lock_rc: $lock_out"
    fail=1
  fi
  simassert "sim: case L: the refused run did not replace the lock holder's latest-run-id" [ "$(cat "$latest_file")" = "$run_a" ]
  if printf '%s' "$status_busy" | grep -qF "latest run: $run_a (in progress)"; then
    echo "ok   sim: case L: status reports the lock holder as in progress"
  else
    echo "FAIL sim: case L: status while locked: $status_busy"
    fail=1
  fi
else
  echo "FAIL sim: case L: could not take the test's own lock"
  fail=1
fi
exec 8>&-
status_free="$(sim_env "$D_SIM" status 2>&1)"
if printf '%s' "$status_free" | grep -qF "latest run: $run_a (no recorded status (interrupted"; then
  echo "ok   sim: case L: once the lock is free, a run without a status reads as interrupted"
else
  echo "FAIL sim: case L: status after release: $status_free"
  fail=1
fi

# ssh exiting 0 is not proof a run happened: a transfer cut just before the
# script's last line exits 0 having done nothing. The run's own status file
# decides.
trunc_out="$(env PATH="$sim_bin:$PATH" OC_PORTAL_ROOT="$sim_root" OC_PORTAL_SSH="$sim_bin/oc-ssh-shim-truncate" "$D_SIM" deploy v1.0.8 2>&1)"
trunc_rc=$?
if [ "$trunc_rc" -eq 1 ] && printf '%s' "$trunc_out" | grep -q "recorded no status"; then
  echo "ok   sim: ssh exit 0 without a recorded status (script cut short) is a failure"
else
  echo "FAIL sim: truncated-script deploy exit was $trunc_rc, wanted 1 with 'recorded no status': $trunc_out"
  fail=1
fi
simassert "sim: current is unchanged after a truncated script" [ "$(current_tag)" = v1.0.3 ]

# The live log and the result line: each log line printed once, the result
# line once and last (after the follower has stopped). And the laptop's SSH
# call rate stays low for the whole run: every call is counted by the shim,
# and an 8-second deploy (a 1 s poll would make 10+ calls) must stay within
# upload + deploy + ~2 polls at 5 s + the final fetch + the status read + 1.
count_log() { wc -l < "$1" 2>/dev/null || echo 0; }
check_single_run_output() { # description output want_rc_line
  local what="$1" out="$2" want="$3"
  local starts ends results last
  starts="$(printf '%s\n' "$out" | grep -c '^=== run .* start ' || true)"
  ends="$(printf '%s\n' "$out" | grep -c '^=== run .* end ' || true)"
  results="$(printf '%s\n' "$out" | grep -c 'guest recorded exit' || true)"
  last="$(printf '%s\n' "$out" | tail -n 1)"
  if [ "$starts" = 1 ] && [ "$ends" = 1 ] && [ "$results" = 1 ] && printf '%s' "$last" | grep -q "^$want"; then
    echo "ok   $what"
  else
    echo "FAIL $what (starts=$starts ends=$ends results=$results last='$last'): $out"
    fail=1
  fi
}
calls="$sim_root/ssh-calls"
rm -f "$calls"
echo 8 > "$sim_root/fake-systemd/build-seconds"
rate_out="$(env -u OC_PORTAL_DEPLOY_POLL_INTERVAL -u OC_PORTAL_DEPLOY_POLL_BUDGET OC_PORTAL_SSH_COUNT="$calls" PATH="$sim_bin:$PATH" OC_PORTAL_ROOT="$sim_root" OC_PORTAL_SSH="$sim_bin/oc-ssh-shim" "$D_SIM" deploy v1.0.8 2>&1)"
rate_rc=$?
simassert "sim: an 8-second deploy succeeds" [ "$rate_rc" -eq 0 ]
n="$(count_log "$calls")"
simassert "sim: an 8-second deploy makes at most 7 SSH calls (made $n)" [ "$n" -le 7 ]
check_single_run_output "sim: live log lines once each, result line once and last" "$rate_out" "guest recorded exit 0"

# The same when the connection drops 6 s into an 8-second build, after the
# live follower has already shown the first lines: the laptop keeps
# following at the (default) 10 s poll from where it left off (no line
# repeated) -- upload, the dropped call, the live follower's three fetches,
# two post-drop polls and the status read, plus 1.
rm -f "$calls"
drop_rate_out="$(env -u OC_PORTAL_DEPLOY_POLL_INTERVAL -u OC_PORTAL_DEPLOY_POLL_BUDGET OC_PORTAL_DROP_AFTER=6 OC_PORTAL_SSH_COUNT="$calls" PATH="$sim_bin:$PATH" OC_PORTAL_ROOT="$sim_root" OC_PORTAL_SSH="$sim_bin/oc-ssh-shim-drop" "$D_SIM" deploy v1.0.9 2>&1)"
drop_rate_rc=$?
simassert "sim: a dropped 8-second deploy still reports success" [ "$drop_rate_rc" -eq 0 ]
n="$(count_log "$calls")"
simassert "sim: a dropped 8-second deploy makes at most 9 SSH calls (made $n)" [ "$n" -le 9 ]
check_single_run_output "sim: after a drop, log lines once each, result line once and last" "$drop_rate_out" "guest recorded exit 0"
simassert "sim: current is v1.0.9 after the dropped deploy finished" [ "$(current_tag)" = v1.0.9 ]
rm -f "$sim_root/fake-systemd/build-seconds" "$calls"

# The health check talks to the portal itself, on the PORT its portal.env
# sets: 3000 before Anubis fronted it, 3001 since (Anubis now answers on 3000
# and needs the client-address headers only nginx-proxy sends).
last_health_url() { tail -n 1 "$sim_root/fake-systemd/curl-urls.log" 2>/dev/null; }
simcheck 0 "sim: deploy without a portal.env" "$D_SIM" deploy v1.0.10
simassert "sim: ...health-checks the portal on 127.0.0.1:3000 (got $(last_health_url))" [ "$(last_health_url)" = http://127.0.0.1:3000/healthz ]
mkdir -p "$sim_root/etc/opencell"
printf 'NODE_ENV=production\nPORT=3001\nOC_LISTEN=127.0.0.1\nOC_TRUSTED_PROXY=127.0.0.1\n' > "$sim_root/etc/opencell/portal.env"
simcheck 0 "sim: deploy with the portal on 3001 behind Anubis" "$D_SIM" deploy v1.0.11
simassert "sim: ...health-checks the portal on 127.0.0.1:3001 (got $(last_health_url))" [ "$(last_health_url)" = http://127.0.0.1:3001/healthz ]
sim_env "$D_SIM" status >/dev/null 2>&1
simassert "sim: status asks the portal on 3001 too (got $(last_health_url))" [ "$(last_health_url)" = http://127.0.0.1:3001/healthz ]
simcheck 0 "sim: rollback with the portal on 3001" "$D_SIM" rollback
simassert "sim: ...health-checks 127.0.0.1:3001 (got $(last_health_url))" [ "$(last_health_url)" = http://127.0.0.1:3001/healthz ]
rm -f "$sim_root/etc/opencell/portal.env"

# The default SSH command (no OC_PORTAL_SSH): the `oc-portal` host from the
# operator's own SSH config (OC_SSH_CONFIG, default ~/.ssh/cm/oc-portal.conf
# -- not in this repo), multiplexed over one master connection, socket in a
# private 0700 directory. A fake `ssh` first on PATH records its arguments
# and fails like an unreachable host -- guarded so the real ssh can never
# run here.
fake_ssh_dir="$sim_bin/fake-ssh"
mkdir -p "$fake_ssh_dir"
cat > "$fake_ssh_dir/ssh" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$OC_FAKE_SSH_ARGS"
cat > /dev/null
exit 255
SH
chmod +x "$fake_ssh_dir/ssh"
if [ "$(PATH="$fake_ssh_dir:$PATH" command -v ssh)" != "$fake_ssh_dir/ssh" ]; then
  echo "FAIL default ssh: the fake ssh is not first on PATH; not running these checks"
  fail=1
else
  xdg_home="$sim_root/xdg"
  mkdir -p "$xdg_home/short" "$xdg_home/sym/target" "$xdg_home/$(printf 'x%.0s' $(seq 1 80))"
  ln -s "$xdg_home/sym/target" "$xdg_home/sym/oc-portal-ssh"
  args_file="$sim_root/fake-ssh-args"
  default_ssh() { # xdg_runtime_dir (relative to $xdg_home: socket paths must stay short)
    (cd "$xdg_home" && env -u OC_PORTAL_SSH PATH="$fake_ssh_dir:$PATH" XDG_RUNTIME_DIR="$1" OC_FAKE_SSH_ARGS="$args_file" "$D_SIM" status 2>&1)
  }
  rm -f "$args_file"
  default_ssh short >/dev/null
  if [ -f "$args_file" ] && grep -qx 'ControlMaster=auto' "$args_file" && grep -qx 'ControlPath=short/oc-portal-ssh/%C' "$args_file" \
    && grep -qx 'ControlPersist=60' "$args_file" && grep -qx -- '-F' "$args_file" \
    && grep -qx "$HOME/.ssh/cm/oc-portal.conf" "$args_file" && [ "$(tail -n 3 "$args_file" | head -n 1)" = oc-portal ]; then
    echo "ok   default ssh: every call is multiplexed over one master, through the operator's oc-portal SSH alias"
  else
    echo "FAIL default ssh: arguments were: $(tr '\n' ' ' < "$args_file" 2>/dev/null)"
    fail=1
  fi
  simassert "default ssh: the control socket directory is private (0700)" [ "$(stat -c %a "$xdg_home/short/oc-portal-ssh" 2>/dev/null)" = 700 ]
  rm -f "$args_file"
  sym_out="$(default_ssh sym)"; sym_rc=$?
  simassert "default ssh: a symlinked control socket directory is refused before any ssh call" \
    bash -c "[ '$sym_rc' -eq 2 ] && [ ! -f '$args_file' ] && printf '%s' \"\$1\" | grep -q 'is a symlink'" _ "$sym_out"
  long_out="$(default_ssh "$xdg_home/$(printf 'x%.0s' $(seq 1 80))")"; long_rc=$?
  simassert "default ssh: a control socket path too long for ssh is refused before any ssh call" \
    bash -c "[ '$long_rc' -eq 2 ] && [ ! -f '$args_file' ] && printf '%s' \"\$1\" | grep -q 'too long'" _ "$long_out"
fi

# --- install-anubis.sh: Anubis in front of the portal (lxc-bootstrap) -------
# Runs the real script against a scratch root (OC_PORTAL_ROOT) with fakes for
# the package tools, systemctl, ss and the download, but the real sha256sum,
# gpg/gpgv, openssl and install: a small file stands in for the pinned .deb,
# signed by a throwaway key that a copy of deploy/anubis/ pins.
a_root="$(mktemp -d)" || exit 1
a_bin="$(mktemp -d)" || exit 1
a_src="$(mktemp -d)" || exit 1
a_gpg="$(mktemp -d)" || exit 1
for d in "$a_root" "$a_bin" "$a_src" "$a_gpg"; do assert_scratch_dir "$d" "install-anubis scratch dir"; done
cleanup_anubis_sim() { rm -rf "$a_root" "$a_bin" "$a_src" "$a_gpg"; }
trap 'cleanup_sim; cleanup_anubis_sim' EXIT
chmod 0700 "$a_gpg"

# The real pins, first: well-formed, and the committed key is the pinned one.
real_pins="$(cat deploy/anubis/release.env)"
a_ver="$(sed -n 's/^ANUBIS_VERSION=//p' <<<"$real_pins")"
simassert "anubis: release.env pins a version, the .deb and tarball SHA-256s and a key fingerprint" bash -c '
  grep -qE "^ANUBIS_VERSION=[0-9]+\.[0-9]+\.[0-9]+$" <<<"$1" &&
  grep -qE "^ANUBIS_DEB_SHA256_AMD64=[0-9a-f]{64}$" <<<"$1" &&
  grep -qE "^ANUBIS_TARBALL_SHA256_LINUX_AMD64=[0-9a-f]{64}$" <<<"$1" &&
  grep -qE "^ANUBIS_SIGNING_KEY_FPR=[0-9A-F]{40}$" <<<"$1"' _ "$real_pins"
real_fpr="$(gpg --homedir "$a_gpg" --batch --with-colons --show-keys deploy/anubis/techaro-packages.asc 2>/dev/null | awk -F: '/^fpr/{print $10; exit}')"
simassert "anubis: the committed signing key is the pinned one ($real_fpr)" [ -n "$real_fpr" -a "ANUBIS_SIGNING_KEY_FPR=$real_fpr" = "$(grep '^ANUBIS_SIGNING_KEY_FPR=' <<<"$real_pins")" ]
simassert "anubis: lxc-bootstrap runs install-anubis.sh" grep -q 'anubis/install-anubis.sh' deploy/lxc-bootstrap.sh

mkdir -p "$a_src/anubis" "$a_src/dl" "$a_root/fake-state"
cp -a deploy/anubis/. "$a_src/anubis/"
deb="anubis_${a_ver}_amd64.deb"
printf 'fake anubis %s package\n' "$a_ver" > "$a_src/dl/$deb"
gen_key() { gpg --homedir "$a_gpg" --batch --quiet --passphrase '' --quick-gen-key "$1" ed25519 sign never 2>/dev/null
  gpg --homedir "$a_gpg" --batch --with-colons --list-keys "$1" 2>/dev/null | awk -F: '/^fpr/{print $10; exit}'; }
fpr_ok="$(gen_key 'OC test signer <signer@example.invalid>')"
fpr_other="$(gen_key 'OC other signer <other@example.invalid>')"
sign_with() { rm -f "$a_src/dl/$deb.asc"; gpg --homedir "$a_gpg" --batch --quiet --local-user "$1" --armor --detach-sign -o "$a_src/dl/$deb.asc" "$a_src/dl/$deb"; }
use_key_file() { gpg --homedir "$a_gpg" --batch --armor --export "$1" > "$a_src/anubis/techaro-packages.asc"; }
sign_with "$fpr_ok"
use_key_file "$fpr_ok"
sed -i -e "s/^ANUBIS_DEB_SHA256_AMD64=.*/ANUBIS_DEB_SHA256_AMD64=$(sha256sum "$a_src/dl/$deb" | cut -d' ' -f1)/" \
  -e "s/^ANUBIS_SIGNING_KEY_FPR=.*/ANUBIS_SIGNING_KEY_FPR=$fpr_ok/" "$a_src/anubis/release.env"

cat > "$a_bin/curl" <<'SH'
#!/bin/bash
# fake download: `curl ... -o OUT URL` copies OUT from $A_DL/<basename URL>.
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
echo "$url" >> "$OC_PORTAL_ROOT/fake-state/curl.log"
[ -f "$A_DL/$(basename "$url")" ] || exit 22
cp "$A_DL/$(basename "$url")" "$out"
SH
cat > "$a_bin/dpkg" <<'SH'
#!/bin/bash
[ "$1" = --print-architecture ] || exit 2
cat "$OC_PORTAL_ROOT/fake-state/arch" 2>/dev/null || echo amd64
SH
cat > "$a_bin/dpkg-query" <<'SH'
#!/bin/bash
cat "$OC_PORTAL_ROOT/fake-state/anubis-version" 2>/dev/null
SH
cat > "$a_bin/apt-get" <<'SH'
#!/bin/bash
# fake apt-get install -y ... ./anubis_V_amd64.deb: records the call and "installs" V.
state="$OC_PORTAL_ROOT/fake-state"
echo "$*" >> "$state/apt.log"
deb="${@: -1}"
[ -f "$deb" ] || { echo "fake apt-get: no such file $deb" >&2; exit 100; }
cmp -s "$deb" "$A_DL/$(basename "$deb")" || { echo "fake apt-get: not the downloaded package" >&2; exit 100; }
basename "$deb" | sed -n 's/^anubis_\(.*\)_amd64\.deb$/\1/p' > "$state/anubis-version"
SH
cat > "$a_bin/systemctl" <<'SH'
#!/bin/bash
state="$OC_PORTAL_ROOT/fake-state"
echo "$*" >> "$state/systemctl.log"
case "$1" in
  is-active) [ -f "$state/active" ]; exit ;;
  start|restart) touch "$state/active" ;;
  enable) if [ "$2" = --now ]; then touch "$state/active"; fi ;;
  *) : ;;
esac
exit 0
SH
cat > "$a_bin/ss" <<'SH'
#!/bin/bash
[ -f "$OC_PORTAL_ROOT/fake-state/port-busy" ] && echo 'LISTEN 0 511 *:3000 *:*'
exit 0
SH
chmod +x "$a_bin"/*

A="$a_src/anubis/install-anubis.sh"
st="$a_root/fake-state"
a_run() { env PATH="$a_bin:$PATH" OC_PORTAL_ROOT="$a_root" A_DL="$a_src/dl" GNUPGHOME=/nonexistent bash "$A" 2>&1; }
a_check() { # expected-exit description
  local want="$1" what="$2" out got
  out="$(a_run)"; got=$?
  a_out="$out"
  if [ "$got" -eq "$want" ]; then echo "ok   $what"; else echo "FAIL $what (exit $got, wanted $want): $out"; fail=1; fi
}
calls() { { wc -l < "$1"; } 2>/dev/null || echo 0; }
nothing_placed() { [ ! -e "$a_root/etc/anubis" ] && [ ! -e "$st/apt.log" ]; }

echo arm64 > "$st/arch"
a_check 1 "anubis: refuses a guest that is not amd64 (only amd64 is pinned)"
simassert "anubis: ...and installs nothing" nothing_placed
rm -f "$st/arch"

cp "$a_src/dl/$deb" "$a_src/deb.orig"
echo tampered >> "$a_src/dl/$deb"
a_check 1 "anubis: refuses a download that is not the pinned .deb (SHA-256)"
simassert "anubis: ...names the checksum" grep -q checksum <<<"$a_out"
simassert "anubis: ...and installs nothing" nothing_placed
cp "$a_src/deb.orig" "$a_src/dl/$deb"

sign_with "$fpr_other"
a_check 1 "anubis: refuses a .deb signed by a key it does not have"
simassert "anubis: ...and installs nothing" nothing_placed
use_key_file "$fpr_other"
a_check 1 "anubis: refuses a swapped key file (the signature must be by the pinned fingerprint)"
simassert "anubis: ...names the pinned key" grep -q "pinned key" <<<"$a_out"
simassert "anubis: ...and installs nothing" nothing_placed
use_key_file "$fpr_ok"
sign_with "$fpr_ok"

a_check 0 "anubis: first install"
simassert "anubis: ...installs the verified .deb once" [ "$(calls "$st/apt.log")" = 1 ]
simassert "anubis: ...places the instance environment (0644, as committed)" bash -c "cmp -s '$a_src/anubis/oc-portal.env' '$a_root/etc/anubis/oc-portal.env' && [ \"\$(stat -c %a '$a_root/etc/anubis/oc-portal.env')\" = 644 ]"
simassert "anubis: ...places the policy (0644, as committed)" bash -c "cmp -s '$a_src/anubis/oc-portal.botPolicies.yaml' '$a_root/etc/anubis/oc-portal.botPolicies.yaml' && [ \"\$(stat -c %a '$a_root/etc/anubis/oc-portal.botPolicies.yaml')\" = 644 ]"
simassert "anubis: ...places the systemd drop-in" cmp -s "$a_src/anubis/opencell.conf" "$a_root/etc/systemd/system/anubis@oc-portal.service.d/opencell.conf"
simassert "anubis: ...generates the signing key, root-only (0600)" bash -c "grep -qxE 'ED25519_PRIVATE_KEY_HEX=[0-9a-f]{64}' '$a_root/etc/anubis/oc-portal.key.env' && [ \"\$(stat -c %a '$a_root/etc/anubis/oc-portal.key.env')\" = 600 ]"
simassert "anubis: ...reloads systemd, then enables and starts anubis@oc-portal (port 3000 free)" bash -c "grep -qx daemon-reload '$st/systemctl.log' && grep -qx 'enable --now anubis@oc-portal.service' '$st/systemctl.log'"
key_before="$(cat "$a_root/etc/anubis/oc-portal.key.env")"

: > "$st/systemctl.log"; curl_before="$(calls "$st/curl.log")"
a_check 0 "anubis: a second run"
simassert "anubis: ...downloads and installs nothing (the pinned version is there)" [ "$(calls "$st/curl.log")" = "$curl_before" -a "$(calls "$st/apt.log")" = 1 ]
simassert "anubis: ...keeps the signing key (passes stay valid)" [ "$(cat "$a_root/etc/anubis/oc-portal.key.env")" = "$key_before" ]
simassert "anubis: ...restarts nothing when nothing changed" bash -c "! grep -qE '^(re)?start |--now' '$st/systemctl.log'"
simassert "anubis: ...and keeps the running instance enabled" grep -qx 'enable anubis@oc-portal.service' "$st/systemctl.log"

echo "# a policy edit" >> "$a_src/anubis/oc-portal.botPolicies.yaml"
: > "$st/systemctl.log"
a_check 0 "anubis: a run after a policy change"
simassert "anubis: ...installs the new policy" cmp -s "$a_src/anubis/oc-portal.botPolicies.yaml" "$a_root/etc/anubis/oc-portal.botPolicies.yaml"
simassert "anubis: ...and restarts the running instance" grep -qx 'restart anubis@oc-portal.service' "$st/systemctl.log"

rm -f "$st/active"; touch "$st/port-busy"; : > "$st/systemctl.log"
echo "# another edit" >> "$a_src/anubis/oc-portal.botPolicies.yaml"
a_check 0 "anubis: with port 3000 still taken (the portal not yet moved to 3001)"
simassert "anubis: ...neither enables nor starts it (a reboot must not race the portal for 3000), and says why" bash -c "! grep -qE '^(enable|(re)?start) ' '$st/systemctl.log' && grep -q 'port 3000' <<<\"\$1\" && grep -q 'enable --now' <<<\"\$1\"" _ "$a_out"
rm -f "$st/port-busy"

fi

exit $fail
