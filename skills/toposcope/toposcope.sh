#!/usr/bin/env bash
# One Toposcope on this machine, for the toposcope agent skill.
# Talks only to 127.0.0.1. Writes secrets to files and never prints them.
# Stops the instance when asked and never removes data.
set -euo pipefail

VERSION="0.5.0"
IMAGE="ghcr.io/toposcope/toposcope:$VERSION"
RELEASE="https://github.com/toposcope/toposcope/releases/download/v$VERSION"
ROOT="${TOPOSCOPE_DIR:-$HOME/.toposcope}"
# The packaged install publishes 8080. Tests point this at a stub on loopback.
PORT="${TOPOSCOPE_PORT:-8080}"
URL="http://127.0.0.1:$PORT"
PROJECT="${COMPOSE_PROJECT_NAME:-toposcope}"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "This needs $1, and it is not installed."
}

# A value from the instance's .env, read as text. The file is never sourced.
env_value() {
  [ -f "$ROOT/.env" ] || die "No instance files in $ROOT. Run: up"
  sed -n "s/^$1=//p" "$ROOT/.env" | head -n 1
}

secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

health() {
  curl -fsS -m 3 "$URL/api/health" 2>/dev/null
}

health_version() {
  printf '%s' "$1" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

report_version() {
  local running
  running="$(health_version "$1")"
  if [ "$running" = "$VERSION" ]; then
    printf 'Toposcope %s is running at %s. Its files are in %s.\n' "$running" "$URL" "$ROOT"
  elif [ -n "$running" ]; then
    printf 'Toposcope %s is running at %s; this skill ships with %s. Its files are in %s.\n' \
      "$running" "$URL" "$VERSION" "$ROOT"
  else
    printf 'A Toposcope that does not report its version is running at %s, so it is older than this skill expects (%s). Its files are in %s.\n' \
      "$URL" "$VERSION" "$ROOT"
  fi
}

compose() {
  (cd "$ROOT" && docker compose "$@")
}

machine_arch() {
  case "$(uname -m)" in
    arm64 | aarch64) printf 'arm64' ;;
    x86_64 | amd64) printf 'amd64' ;;
    *) uname -m ;;
  esac
}

# The architectures the app image is published for, space separated. Empty when it cannot be read.
image_archs() {
  local found
  found="$(docker manifest inspect -v "$IMAGE" 2>/dev/null |
    sed -n 's/.*"architecture": *"\([^"]*\)".*/\1/p' | grep -v unknown | sort -u | tr '\n' ' ' || true)"
  printf '%s' "${found% }"
}

cmd_cost() {
  need docker
  local machine arch
  machine="$(machine_arch)"
  arch="$(image_archs)"

  printf 'Standing up Toposcope %s on this machine will:\n' "$VERSION"
  printf -- '- start two containers, ClickHouse and the app, published only on 127.0.0.1 (8080, and 5514/udp for syslog)\n'
  printf -- '- take about 2 GB of memory even with nothing arriving (ClickHouse levels off near 1.7 GiB); its limits are 4 GB for ClickHouse and 512 MB for the app\n'
  printf -- '- pull about 1.7 GB of images the first time\n'
  printf -- '- keep its files and three generated secrets in %s, and its data in two Docker volumes\n' "$ROOT"
  if [ -z "$arch" ]; then
    printf 'The app image could not be inspected from here, so its architecture is unknown. This machine is %s.\n' "$machine"
  elif printf ' %s ' "$arch" | grep -q " $machine "; then
    printf 'The app image is built for %s, which is this machine.\n' "$machine"
  else
    printf 'The app image is built for %s and this machine is %s, so it runs emulated: slower, and fine for a laptop.\n' \
      "$arch" "$machine"
  fi
  printf 'Nothing has been started.\n'
}

cmd_up() {
  need docker
  need curl
  docker compose version >/dev/null 2>&1 || die "This needs Docker Compose v2 (docker compose)."

  local body
  if body="$(health)"; then
    [ -f "$ROOT/.env" ] || die "A Toposcope already answers at $URL, but its .env is not in $ROOT. Set TOPOSCOPE_DIR to the directory that holds its files. Nothing was started."
    report_version "$body"
    return
  fi

  if [ ! -f "$ROOT/.env" ]; then
    if docker volume inspect "${PROJECT}_ch_data" >/dev/null 2>&1; then
      die "Docker already holds Toposcope data (volume ${PROJECT}_ch_data) from an install whose files are not in $ROOT. Set TOPOSCOPE_DIR to that install's directory. Nothing was started."
    fi
    mkdir -p "$ROOT"
    chmod 700 "$ROOT"
    local file
    for file in compose.yml env.example vector.yaml LICENSE; do
      curl -fsSL "$RELEASE/$file" -o "$ROOT/$file" ||
        die "Could not download $file for $VERSION from the release. Nothing was started."
    done
    (
      umask 077
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          CLICKHOUSE_PASSWORD= | TOPOSCOPE_PASSWORD= | TOPOSCOPE_INGEST_TOKEN=)
            printf '%s%s\n' "$line" "$(secret)"
            ;;
          *) printf '%s\n' "$line" ;;
        esac
      done <"$ROOT/env.example" >"$ROOT/.env"
    )
    local key
    for key in CLICKHOUSE_PASSWORD TOPOSCOPE_PASSWORD TOPOSCOPE_INGEST_TOKEN; do
      [ -n "$(env_value "$key")" ] || die "$key was not written to $ROOT/.env: the release's env.example has changed. Nothing was started."
    done
  fi

  # An image with no build for this machine is not pulled at all unless its
  # platform is named. Compose reads compose.override.yml beside compose.yml.
  local machine arch
  machine="$(machine_arch)"
  arch="$(image_archs)"
  if [ -n "$arch" ] && ! printf ' %s ' "$arch" | grep -q " $machine " && [ ! -f "$ROOT/compose.override.yml" ]; then
    printf 'services:\n  app:\n    platform: linux/%s\n' "${arch%% *}" >"$ROOT/compose.override.yml"
  fi

  compose up -d --quiet-pull >/dev/null 2>"$ROOT/up.log" ||
    die "docker compose could not start the instance. Its output is in $ROOT/up.log."

  local tries=0
  until body="$(health)"; do
    tries=$((tries + 1))
    [ "$tries" -le 120 ] || die "The instance did not become healthy in four minutes. See: docker compose logs, in $ROOT."
    sleep 2
  done
  report_version "$body"
}

cmd_status() {
  need curl
  local body
  if body="$(health)"; then
    report_version "$body"
  elif [ -f "$ROOT/.env" ]; then
    printf 'No Toposcope answers at %s. Its files are in %s; up starts it again.\n' "$URL" "$ROOT"
  else
    printf 'No Toposcope answers at %s, and none has been stood up in %s.\n' "$URL" "$ROOT"
  fi
}

cmd_stop() {
  need docker
  [ -f "$ROOT/compose.yml" ] || die "No instance files in $ROOT. Nothing to stop."
  # ClickHouse needs longer than the default ten seconds to stop cleanly.
  compose stop --timeout 60 >/dev/null 2>&1 || die "docker compose could not stop the instance in $ROOT."
  printf 'Stopped. The data stays in its Docker volumes and the files in %s; up starts it again.\n' "$ROOT"
}

cmd_app_env() {
  local file="" service="" version=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --service) service="${2:-}"; shift 2 ;;
      --version) version="${2:-}"; shift 2 ;;
      -*) die "Unknown option $1" ;;
      *) file="$1"; shift ;;
    esac
  done
  [ -n "$file" ] || die "Usage: app-env <file> [--service <name>] [--version <version>]"

  local token marker="# toposcope skill: app settings."
  token="$(env_value TOPOSCOPE_INGEST_TOKEN)"
  [ -n "$token" ] || die "No ingest token in $ROOT/.env."
  if [ -e "$file" ] && [ "$(head -n 1 "$file")" != "$marker" ]; then
    die "$file exists and was not written by this skill. Choose another file."
  fi

  (
    umask 077
    {
      printf '%s\n' "$marker"
      printf '# Holds the ingest token: keep this file out of git.\n'
      printf 'OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8080\n'
      printf 'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n'
      printf 'OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%%20%s\n' "$token"
      printf 'OTEL_LOGS_EXPORTER=otlp\n'
      printf 'OTEL_METRICS_EXPORTER=otlp\n'
      # Counters and histograms are stored as the amount per interval; a running total is refused.
      printf 'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta\n'
      [ -z "$service" ] || printf 'OTEL_SERVICE_NAME=%s\n' "$service"
      [ -z "$version" ] || printf 'OTEL_RESOURCE_ATTRIBUTES=service.version=%s\n' "$version"
      printf 'TOPOSCOPE_URL=http://127.0.0.1:8080\n'
      printf 'TOPOSCOPE_INGEST_TOKEN=%s\n' "$token"
    } >"$file"
  )
  chmod 600 "$file"
  printf 'Wrote %s. It sets the OTLP endpoint, protocol, token header, logs and metrics exporters on, metrics as deltas' "$file"
  [ -z "$service" ] || printf ', service name'
  [ -z "$version" ] || printf ', service version'
  printf ', and TOPOSCOPE_URL and TOPOSCOPE_INGEST_TOKEN for a direct post. Values are not shown. It holds the ingest token: keep it out of git.\n'
}

cmd_marker() {
  printf 'tscheck%s\n' "$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
}

cmd_check() {
  need curl
  local word="${1:-}"
  printf '%s' "$word" | grep -Eq '^tscheck[0-9a-f]{12}$' ||
    die "Usage: check <word>, with the word that marker printed."

  local password body="" waited=0 wait="${TOPOSCOPE_CHECK_WAIT:-30}"
  password="$(env_value TOPOSCOPE_PASSWORD)"
  [ -n "$password" ] || die "No operator password in $ROOT/.env."

  # The word is the error's whole message, so it is in the log line or in
  # exception.message. Exporters batch, so a row can take a few seconds.
  # Every read names its window.
  local q="$word OR exception.message:$word"
  while :; do
    body="$(printf 'user = "toposcope:%s"\n' "$password" |
      curl -fsS -m 10 -K - "$URL/api/search?q=$word%20OR%20exception.message:$word&range=15m")" ||
      die "Could not read from the instance at $URL. Run: status"
    if printf '%s' "$body" | grep -q "$word"; then
      break
    fi
    [ "$waited" -lt "$wait" ] || break
    sleep 2
    waited=$((waited + 2))
  done

  local from to e1
  from="$(printf '%s' "$body" | sed -n 's/.*"from":"\([^"]*\)".*/\1/p')"
  to="$(printf '%s' "$body" | sed -n 's/.*"to":"\([^"]*\)".*/\1/p')"
  e1="$(printf '%s' "$body" | sed -n 's/.*"e1":"\([0-9a-f]\{16\}\)".*/\1/p')"

  if ! printf '%s' "$body" | grep -q "$word"; then
    printf 'nothing arrived\n'
    printf 'No row with %s as its log line or its exception.message reached the instance in the last 15 minutes.\n' "$word"
  elif printf '%s' "$body" | grep -q '"exception\.frames"'; then
    printf 'frames\n'
    printf 'The row carries the frames of its stack, and its fingerprint came from them.\n'
  else
    printf 'message\n'
    printf 'The row arrived without frames, so its fingerprint fell back to the log line.\n'
  fi
  printf 'q: %s\n' "$q"
  [ -z "$e1" ] || printf 'q for this error from now on: e1:%s\n' "$e1"
  printf 'window: the last 15 minutes'
  [ -z "$from" ] || [ -z "$to" ] || printf ' (%s to %s)' "$from" "$to"
  printf '\nopen: http://127.0.0.1:8080/?q=%s%%20OR%%20exception.message:%s&range=15m\n' "$word" "$word"
}

case "${1:-}" in
  cost) cmd_cost ;;
  up) cmd_up ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  app-env) shift; cmd_app_env "$@" ;;
  marker) cmd_marker ;;
  check) shift; cmd_check "$@" ;;
  *)
    die "Usage: toposcope.sh cost | up | status | stop | app-env <file> [--service <name>] [--version <version>] | marker | check <word>"
    ;;
esac
