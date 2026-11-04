#!/usr/bin/env bash
# One command: build, then run the proof twice, once with dqlite's default
# timeouts (election 3 s) and once tuned (network latency 20 ms, election
# 300 ms, raft snapshot every 128 entries keeping 512). Results land in out/<config>/report.md and results.json.
# Usage: ./run.sh [default|tuned|all]   (default: all)
set -euo pipefail
cd "$(dirname "$0")"
which=${1:-all}
export COMPOSE_PROJECT_NAME=dqproof
docker compose build
status=0
run() {
  local label=$1 latency=$2 election=$3 phases=$4 snap=${5:-}
  echo "=== $label: LATENCY_MS=$latency ELECTION_MS=$election PHASES=$phases SNAP=$snap"
  docker compose --profile runner down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf out/acks out/backup out/results.json out/report.md
  mkdir -p out
  export LATENCY_MS=$latency ELECTION_MS=$election LABEL=$label PHASES=$phases
  export SNAP_THRESHOLD=${snap%/*} SNAP_TRAILING=${snap#*/}
  export SNAP_DESC=${snap:+threshold ${snap%/*}, trailing ${snap#*/}}
  [[ -z $snap ]] && export SNAP_THRESHOLD= SNAP_TRAILING=
  docker compose up -d n1 n2 n3 r1 r2 r3
  docker compose --profile runner run --rm runner || status=1
  mkdir -p "out/$label"
  docker compose logs --no-color > "out/$label/members.log" 2>&1 || true
  mv out/results.json out/report.md "out/$label/" 2>/dev/null || true
  rm -rf "out/$label/acks" && mv out/acks "out/$label/acks" 2>/dev/null || true
  docker compose --profile runner down -v --remove-orphans >/dev/null 2>&1 || true
}
if [[ $which == all || $which == default ]]; then run default 0 3000 faults,latency,memory,backup; fi
if [[ $which == all || $which == tuned ]]; then run tuned 20 300 faults,latency,memory 128/512; fi
exit $status
