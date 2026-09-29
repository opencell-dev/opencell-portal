#!/bin/bash
# The deploy script's local checks: it refuses anything but an existing
# vX.Y.Z tag before touching the network. (OC_PORTAL_SSH=false makes any
# network step fail loudly.)
set -uo pipefail
cd "$(dirname "$0")/../.."
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
exit $fail
