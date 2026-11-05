#!/usr/bin/env bash
# One command: build, then run the proof in several configurations. Results
# land in out/<config>/report.md and results.json, with the members' logs.
#
#   ./run.sh            default, tuned and budget (about 50 minutes)
#   ./run.sh stalls     the paused-owner matrix that isolates the stalls
#   ./run.sh rqlite     the same harness on rqlite: rq-default, rq-restore, rq-snap, rq-budget
#   ./run.sh rq-stalls  rqlite: repeated one-way partitions and the paused-owner matrix
#   ./run.sh <config>   any one config named below
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
  export BACKEND=${BACKEND:-dqlite} CTL=${CTL:-ctl} RQ_ARGS=${RQ_ARGS:-}
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
want() { [[ $which == "$1" || ($which == all && $2 == main) || ($which == stalls && $2 == stalls) || ($which == rqlite && $2 == rqlite) || ($which == rq-stalls && $2 == rq-stalls) ]]; }
want default main && run default 0 3000 guard,faults,latency,memory,backup
want tuned main && run tuned 20 300 guard,faults,latency,memory 128/512
want budget main && run budget 20 300 budget 128/512
# The stall matrix: one variable at a time, many paused-owner trials.
export PAUSE_TRIALS=${PAUSE_TRIALS_STALLS:-15}
want stall-timeouts stalls && run stall-timeouts 20 300 pauses
want stall-snapshot stalls && run stall-snapshot 0 3000 pauses 128/512
want stall-both stalls && run stall-both 20 300 pauses 128/512
want stall-notls stalls && run stall-notls 20 300 pauses 128/512 0

# rqlite: same operations, faults, records and criteria. rqlite's defaults
# are election and heartbeat 1 s, snapshot at 8192 entries or a 4 MB WAL.
# rqrun <label> <election ms> <phases> <rqlited flags> [tls]
rqrun() {
  BACKEND=rqlite CTL=ctlr RQ_ARGS=$4 MTLS=${MTLS:-1} REV_TRIALS=${REV_TRIALS_RQ:-6} run "$1" 0 "$2" "$3" "" "${5:-1}"
}
SNAPPY="-raft-snap 128 -raft-snap-int 1s -raft-snap-wal-size 262144"
FAST="-raft-heartbeat-timeout 300ms -raft-election-timeout 300ms -raft-leader-lease-timeout 300ms"
export PAUSE_TRIALS=3
# rq-default shares one certificate across installations (MTLS=0), as the
# dqlite runs do: an old member returning after a restore is then accepted
# as leader by the restored members (see RESULTS-rqlite.md). Every other
# rqlite config gives each installation its own certificate authority.
want rq-default rqlite && MTLS=0 rqrun rq-default 1000 batch,faults,latency,memory,backup ""
want rq-restore rqlite && rqrun rq-restore 1000 backup ""
want rq-snap rqlite && rqrun rq-snap 1000 faults,backup "$SNAPPY"
want rq-budget rqlite && rqrun rq-budget 1000 budget "$SNAPPY"
# The snapshot-install stall, created on purpose at the settings under test
# (defaults, a CA per installation): see cmd/runner/snapstall.go.
want rq-snapstall rq-stalls && rqrun rq-snapstall 1000 snapstall ""
# Asymmetric partitions repeated, with default and frequent snapshots.
want rq-asym rq-stalls && REV_MODES=asym-in,asym-out REV_TRIALS_RQ=15 rqrun rq-asym 1000 faults ""
want rq-asym-snap rq-stalls && REV_MODES=asym-in,asym-out REV_TRIALS_RQ=15 rqrun rq-asym-snap 1000 faults "$SNAPPY"
export PAUSE_TRIALS=${PAUSE_TRIALS_STALLS:-15}
want rq-stall-default rq-stalls && rqrun rq-stall-default 1000 pauses ""
want rq-stall-snapshot rq-stalls && rqrun rq-stall-snapshot 1000 pauses "$SNAPPY"
want rq-stall-fast rq-stalls && rqrun rq-stall-fast 300 pauses "$FAST $SNAPPY"
want rq-stall-notls rq-stalls && rqrun rq-stall-notls 1000 pauses "$SNAPPY" 0
exit $status
