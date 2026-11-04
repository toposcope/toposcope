#!/usr/bin/env bash
# One command: build, then run the proof in several configurations. Results
# land in out/<config>/report.md and results.json, with the members' logs.
#
#   ./run.sh            default, tuned and budget (about 50 minutes)
#   ./run.sh stalls     the paused-owner matrix that isolates the stalls
#   ./run.sh <config>   any one of: default tuned budget stall-timeouts
#                       stall-snapshot stall-both stall-notls
set -euo pipefail
cd "$(dirname "$0")"
which=${1:-all}
export COMPOSE_PROJECT_NAME=dqproof HOST_OUT="$PWD/out"
docker compose build
status=0
cleanup() {
  docker rm -f -v dqproof-f1 dqproof-f2 dqproof-f3 >/dev/null 2>&1 || true
  docker compose --profile runner down -v --remove-orphans >/dev/null 2>&1 || true
}
# run <label> <latency ms, 0 = dqlite default> <election ms> <phases> [threshold/trailing] [tls]
run() {
  local label=$1 latency=$2 election=$3 phases=$4 snap=${5:-} tls=${6:-1}
  echo "=== $label: LATENCY_MS=$latency ELECTION_MS=$election PHASES=$phases SNAP=$snap TLS=$tls"
  cleanup
  rm -rf out/acks out/backup out/results.json out/report.md
  mkdir -p out
  export LATENCY_MS=$latency ELECTION_MS=$election LABEL=$label PHASES=$phases TLS=$tls
  export SNAP_THRESHOLD=${snap%/*} SNAP_TRAILING=${snap#*/}
  export SNAP_DESC=${snap:+threshold ${snap%/*}, trailing ${snap#*/}}
  [[ -z $snap ]] && export SNAP_THRESHOLD= SNAP_TRAILING=
  docker compose up -d n1 n2 n3
  docker compose --profile runner run --rm runner || status=1
  mkdir -p "out/$label"
  { docker compose logs --no-color; for f in f1 f2 f3; do docker logs "dqproof-$f" 2>&1 | sed "s/^/dqproof-$f  | /"; done; } > "out/$label/members.log" 2>&1 || true
  mv out/results.json out/report.md "out/$label/" 2>/dev/null || true
  rm -rf "out/$label/acks" && mv out/acks "out/$label/acks" 2>/dev/null || true
  cleanup
}
want() { [[ $which == "$1" || ($which == all && $2 == main) || ($which == stalls && $2 == stalls) ]]; }
want default main && run default 0 3000 guard,faults,latency,memory,backup
want tuned main && run tuned 20 300 guard,faults,latency,memory 128/512
want budget main && run budget 20 300 budget 128/512
# The stall matrix: one variable at a time, many paused-owner trials.
export PAUSE_TRIALS=${PAUSE_TRIALS_STALLS:-15}
want stall-timeouts stalls && run stall-timeouts 20 300 pauses
want stall-snapshot stalls && run stall-snapshot 0 3000 pauses 128/512
want stall-both stalls && run stall-both 20 300 pauses 128/512
want stall-notls stalls && run stall-notls 20 300 pauses 128/512 0
exit $status
