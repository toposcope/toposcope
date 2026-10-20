#!/usr/bin/env bash
# Upgrades a packaged Toposcope on this host, with a backup first and a way back (#198).
#
#   ./upgrade.sh [X.Y.Z] [--no-backup] [--wait <minutes>]   to X.Y.Z, or the latest stable release
#   ./upgrade.sh backup                                    both volumes, then start again
#   ./upgrade.sh rollback [--yes]                          back to the last backup
#
# Run it in the directory that holds compose.yml and .env (or set TOPOSCOPE_DIR). It is for
# operators: unlike the agent skill's toposcope.sh, rollback replaces the data with the backup's,
# and it keeps only the last 3 backups. The app never runs it: that would need the Docker socket.
# Secrets are read from .env as text and never printed.
set -euo pipefail

ROOT="${TOPOSCOPE_DIR:-$PWD}"
URL="${TOPOSCOPE_URL:-http://127.0.0.1:8080}"
RELEASES="${TOPOSCOPE_RELEASE_BASE:-https://github.com/toposcope/toposcope/releases/download}"
API="${TOPOSCOPE_RELEASES_API:-https://api.github.com/repos/toposcope/toposcope/releases}"
BACKUPS="$ROOT/backups"
KEEP=3
WAIT_MINUTES=10
FILES="compose.yml env.example vector.yaml LICENSE toposcope.sh upgrade.sh"

say() { printf '%s\n' "$*"; }
die() {
  printf '%s\n' "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || die "This needs $1, and it is not installed."; }

# A value from .env, read as text. The file is never sourced.
env_value() { sed -n "s/^$1=//p" "$ROOT/.env" | head -n 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# 0 when $1 is a newer X.Y.Z than $2.
newer_than() {
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<<"$1"
  IFS=. read -r b1 b2 b3 <<<"$2"
  [ "$a1" -gt "$b1" ] && return 0
  [ "$a1" -lt "$b1" ] && return 1
  [ "$a2" -gt "$b2" ] && return 0
  [ "$a2" -lt "$b2" ] && return 1
  [ "$a3" -gt "$b3" ]
}

is_version() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }

health() { curl -fsS -m 5 "$URL/api/health" 2>/dev/null; }

health_version() { printf '%s' "$1" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }

# The version answering, healthy, or nothing.
running_version() {
  local body
  body="$(health)" || return 0
  printf '%s' "$body" | grep -q '"ok":true' || return 0
  health_version "$body"
}

# The Compose project, so the volumes are the ones this install uses.
project() {
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    printf '%s' "$COMPOSE_PROJECT_NAME"
    return
  fi
  compose_with "$ROOT/compose.yml" config --format json 2>/dev/null |
    sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' | head -n 1
}

# docker compose on a given compose.yml, with this install's .env and override.
compose_with() {
  local file="$1"
  shift
  local args=(-f "$file")
  [ ! -f "$ROOT/compose.override.yml" ] || args+=(-f "$ROOT/compose.override.yml")
  (cd "$ROOT" && docker compose --project-directory "$ROOT" --env-file "$ROOT/.env" "${args[@]}" "$@")
}

app_image() { sed -n 's/^ *image: *\(ghcr.io\/toposcope\/toposcope:[^ ]*\).*/\1/p' "$1" | head -n 1; }

compose_version() { app_image "$1" | sed 's/.*://'; }

# Waits for /api/health to report $1 and ok, for up to $2 seconds.
wait_for() {
  local want="$1" limit="$2" waited=0 got
  while [ "$waited" -lt "$limit" ]; do
    got="$(running_version)"
    [ "$got" != "$want" ] || return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# Starts a compose file and waits for its version. 0 when it answered.
start_and_wait() {
  local file="$1" version="$2"
  compose_with "$file" up -d --quiet-pull >/dev/null 2>"$ROOT/upgrade-up.log" || return 1
  # Tests shorten the wait; an operator sets it with --wait <minutes>.
  wait_for "$version" "${TOPOSCOPE_UPGRADE_WAIT_SECONDS:-$((WAIT_MINUTES * 60))}"
}

# A deploy change mark, with the ingest token from .env, never printed.
mark() {
  local title="$1" backup="${2:-}" token body
  token="$(env_value TOPOSCOPE_INGEST_TOKEN)"
  [ -n "$token" ] || return 0
  body="{\"kind\":\"deploy\",\"service\":\"toposcope\",\"title\":\"$title\""
  [ -z "$backup" ] || body="$body,\"attrs\":{\"backup\":\"$backup\"}"
  body="$body}"
  printf 'header = "authorization: Bearer %s"\n' "$token" |
    curl -fsS -m 10 -K - -o /dev/null -X POST "$URL/v1/marks" -H 'content-type: application/json' --data-binary "$body" ||
    say "The change mark \"$title\" was not posted."
}

# The release's files into releases/X.Y.Z/, each checked against its SHA256SUMS.
fetch_release() {
  local version="$1" dir="$ROOT/releases/$1" file expected got
  mkdir -p "$dir"
  curl -fsSL "$RELEASES/v$version/SHA256SUMS" -o "$dir/SHA256SUMS" ||
    die "The $version release has no SHA256SUMS, so its files cannot be checked. Nothing was changed."
  for file in $FILES; do
    curl -fsSL "$RELEASES/v$version/$file" -o "$dir/$file" ||
      die "Could not download $file for $version. Nothing was changed."
    expected="$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1; exit }' "$dir/SHA256SUMS")"
    [ -n "$expected" ] || die "The $version release's SHA256SUMS does not list $file. Nothing was changed."
    got="$(sha256_of "$dir/$file")"
    [ "$got" = "$expected" ] || die "$file from the $version release does not match its SHA256SUMS. Nothing was changed."
  done
  chmod +x "$dir/upgrade.sh"
}

latest_release() {
  curl -fsSL -m 10 -H 'user-agent: toposcope' "$API/latest" 2>/dev/null |
    sed -n 's/.*"tag_name": *"v\{0,1\}\([0-9][0-9.]*\)".*/\1/p' | head -n 1
}

# Each release's Before you upgrade, newer than $1 up to $2, as the releases list holds them.
print_before() {
  local from="$1" to="$2" json
  json="$(curl -fsSL -m 10 -H 'user-agent: toposcope' "$API?per_page=30" 2>/dev/null)" || {
    say "Could not read the release notes. Read them before going on: https://github.com/toposcope/toposcope/releases"
    return 0
  }
  printf '%s' "$json" | FROM="$from" TO="$to" awk '
    function newer(a, b,  x, y, i) { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) return 1; if (x[i] + 0 < y[i] + 0) return 0 } return 0 }
    { buf = buf $0 "\n" }
    END {
      n = split(buf, parts, /"tag_name": *"v?/)
      for (i = 2; i <= n; i++) {
        v = parts[i]; sub(/".*/, "", v)
        if (!(newer(v, ENVIRON["FROM"]) && !newer(v, ENVIRON["TO"]))) continue
        body = parts[i]
        if (match(body, /\*\*Before you upgrade:\*\*[^"]*/)) {
          text = substr(body, RSTART + 24, RLENGTH - 24); gsub(/\\n.*/, "", text); gsub(/^ +/, "", text)
          printf "Before you upgrade to %s: %s\n", v, text
        }
      }
    }'
}

volume_kb() {
  local image="$1" volume="$2"
  docker run --rm -v "$volume:/data:ro" --entrypoint du "$image" -sk /data 2>/dev/null | awk '{ print $1; exit }'
}

# Both volumes into backups/<UTC time>-<version>/, with the compose.yml in use. Prints the path.
take_backup() {
  local version="$1" image="$2" name dir ch app need free started part
  name="$(project)"
  [ -n "$name" ] || die "Could not tell this install's Compose project, so not which volumes to back up."
  ch="$(volume_kb "$image" "${name}_ch_data")"
  app="$(volume_kb "$image" "${name}_app_data")"
  [ -n "$ch" ] && [ -n "$app" ] || die "Could not read the size of ${name}_ch_data and ${name}_app_data. Nothing was changed."
  need=$((ch + app))
  mkdir -p "$BACKUPS"
  free="$(df -Pk "$BACKUPS" | awk 'NR == 2 { print $4 }')"
  [ "$free" -gt "$need" ] ||
    die "The backup needs about $((need / 1024)) MB and $BACKUPS has $((free / 1024)) MB free. Free some space, or run with --no-backup. Nothing was changed."
  dir="$BACKUPS/$(date -u +%Y%m%dT%H%M%SZ)-$version"
  local n=2 base="$dir"
  while [ -e "$dir" ]; do
    dir="$base-$n"
    n=$((n + 1))
  done
  mkdir -p "$dir"
  cp "$ROOT/compose.yml" "$dir/compose.yml"
  [ ! -f "$ROOT/compose.override.yml" ] || cp "$ROOT/compose.override.yml" "$dir/compose.override.yml"
  printf '%s\n' "$version" >"$dir/version"
  say "Backing up about $((need / 1024)) MB into $dir. Ingest is stopped while it runs." >&2
  started="$(date +%s)"
  for part in ch_data app_data; do
    docker run --rm -v "${name}_$part:/data:ro" -v "$dir:/backup" --entrypoint tar "$image" czf "/backup/$part.tgz" -C /data . &
    local pid=$! ticks=0
    # Says how far it has got every 10 seconds, so a long backup is never silent.
    while kill -0 "$pid" 2>/dev/null; do
      sleep 0.2
      ticks=$((ticks + 1))
      [ $((ticks % 50)) -ne 0 ] || ! kill -0 "$pid" 2>/dev/null ||
        say "  still writing $part.tgz: $(($(date +%s) - started))s, $(du -sk "$dir" | awk '{ print int($1 / 1024) }') MB so far" >&2
    done
    wait "$pid" || die "The backup of ${name}_$part did not finish. The stack is stopped; start it with: docker compose up -d"
  done
  say "Backup done in $(($(date +%s) - started))s: $dir, $(du -sk "$dir" | awk '{ print int($1 / 1024) }') MB." >&2
  prune_backups
  printf '%s' "$dir"
}

# Keeps the newest $KEEP backups.
prune_backups() {
  local all=() d i
  for d in "$BACKUPS"/*/; do
    [ -f "$d/version" ] && all+=("${d%/}")
  done
  [ "${#all[@]}" -gt "$KEEP" ] || return 0
  for ((i = 0; i < ${#all[@]} - KEEP; i++)); do
    rm -rf -- "${all[$i]}"
    say "Removed the old backup ${all[$i]} (keeping the last $KEEP)." >&2
  done
}

latest_backup() {
  local d last=""
  for d in "$BACKUPS"/*/; do
    [ -f "$d/version" ] && last="${d%/}"
  done
  printf '%s' "$last"
}

# Empties both volumes and fills them from a backup, with the backup's own image.
restore_backup() {
  local dir="$1" name image part
  name="$(project)"
  image="$(app_image "$dir/compose.yml")"
  for part in ch_data app_data; do
    docker run --rm -v "${name}_$part:/data" -v "$dir:/backup:ro" --entrypoint sh "$image" -c \
      "find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar xzf /backup/$part.tgz -C /data" ||
      die "Could not restore ${name}_$part from $dir."
  done
  cp "$dir/compose.yml" "$ROOT/compose.yml"
}

# Names settings the new env.example has that .env does not.
new_settings() {
  local example="$1" key missing=""
  for key in $(sed -n 's/^#* *\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$example" | sort -u); do
    grep -Eq "^#* *$key=" "$ROOT/.env" || missing="$missing $key"
  done
  [ -z "$missing" ] || say "New settings in env.example that .env does not have:$missing (each is described there)."
}

swap_files() {
  local from="$1" to="$2" dir="$ROOT/releases/$2" old_vector="$ROOT/releases/$1/vector.yaml" file
  cp "$ROOT/compose.yml" "$ROOT/compose.yml.$from"
  for file in compose.yml env.example LICENSE toposcope.sh upgrade.sh; do
    cp "$dir/$file" "$ROOT/.$file.new" && mv -f "$ROOT/.$file.new" "$ROOT/$file"
  done
  chmod +x "$ROOT/upgrade.sh"
  [ -f "$old_vector" ] || curl -fsSL "$RELEASES/v$from/vector.yaml" -o "$old_vector" 2>/dev/null || true
  if [ ! -f "$ROOT/vector.yaml" ] || { [ -f "$old_vector" ] && cmp -s "$ROOT/vector.yaml" "$old_vector"; }; then
    cp "$dir/vector.yaml" "$ROOT/vector.yaml"
  elif ! cmp -s "$ROOT/vector.yaml" "$dir/vector.yaml"; then
    cp "$dir/vector.yaml" "$ROOT/vector.yaml.new"
    say "vector.yaml was edited here, so it was kept; the $to one is vector.yaml.new beside it."
  fi
  new_settings "$ROOT/env.example"
}

cmd_upgrade() {
  local target="" no_backup=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-backup) no_backup=1 ;;
      --wait) WAIT_MINUTES="${2:?--wait needs minutes}"; shift ;;
      *) target="$1" ;;
    esac
    shift
  done
  need docker
  need curl
  [ -f "$ROOT/compose.yml" ] && [ -f "$ROOT/.env" ] || die "No compose.yml and .env in $ROOT. Run this in the install's directory, or set TOPOSCOPE_DIR."
  local running
  running="$(running_version)"
  [ -n "$running" ] || die "Toposcope at $URL is not answering as healthy, so there is nothing to compare an upgrade with. Start it first, or go back with: ./upgrade.sh rollback"
  [ -n "$target" ] || target="$(latest_release)"
  is_version "$target" || die "Could not tell which release to upgrade to. Name it: ./upgrade.sh X.Y.Z"
  newer_than "$target" "$running" || die "$target is not newer than the running $running. To go back, run: ./upgrade.sh rollback"
  say "Toposcope $running → $target"
  fetch_release "$target"
  local args=("$running" "$target" --wait "$WAIT_MINUTES")
  [ "$no_backup" = 0 ] || args+=(--no-backup)
  # The new release's own upgrade.sh finishes: a release that needs one more step carries it.
  exec env TOPOSCOPE_DIR="$ROOT" "$ROOT/releases/$target/upgrade.sh" continue "${args[@]}"
}

cmd_continue() {
  local from="$1" to="$2" no_backup=0
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-backup) no_backup=1 ;;
      --wait) WAIT_MINUTES="$2"; shift ;;
    esac
    shift
  done
  local new="$ROOT/releases/$to/compose.yml" old_image backup="" stopped
  old_image="$(app_image "$ROOT/compose.yml")"
  print_before "$from" "$to"
  compose_with "$new" pull -q app >/dev/null 2>&1 || die "Could not pull $(app_image "$new"). Nothing was changed."
  [ "$no_backup" = 0 ] || say "No backup (--no-backup): if $to does not come up, the way back is the $from compose.yml only."
  stopped="$(date +%s)"
  compose_with "$ROOT/compose.yml" stop >/dev/null 2>&1 || die "Could not stop the stack. Nothing was changed."
  # A backup that fails stops here: the stack stays stopped and the message says how to start it.
  if [ "$no_backup" = 0 ]; then
    backup="$(take_backup "$from" "$old_image")" || exit 1
  fi
  swap_files "$from" "$to"
  if start_and_wait "$ROOT/compose.yml" "$to"; then
    say "Toposcope $to is up. Ingest was stopped for $(($(date +%s) - stopped))s.${backup:+ Backup: $backup}"
    mark "Toposcope $from → $to" "$backup"
    return 0
  fi
  say "Toposcope $to did not come up. Its last log lines:"
  compose_with "$ROOT/compose.yml" logs --tail 20 app 2>/dev/null || true
  compose_with "$ROOT/compose.yml" stop >/dev/null 2>&1 || true
  cp "$ROOT/compose.yml.$from" "$ROOT/compose.yml"
  say "Starting $from again with its own compose.yml."
  if start_and_wait "$ROOT/compose.yml" "$from"; then
    say "Back on $from."
    mark "Toposcope $to did not start; back on $from" "$backup"
    exit 1
  fi
  [ -n "$backup" ] || die "$from did not come up either, and there is no backup to restore (--no-backup). See: docker compose logs"
  say "$from did not open its data either. Restoring both volumes from $backup."
  compose_with "$ROOT/compose.yml" stop >/dev/null 2>&1 || true
  restore_backup "$backup"
  start_and_wait "$ROOT/compose.yml" "$from" || die "$from did not come up from the backup either. See: docker compose logs"
  say "Back on $from, restored from $backup."
  mark "Toposcope $to did not start; back on $from, restored from the backup" "$backup"
  exit 1
}

cmd_backup() {
  need docker
  [ -f "$ROOT/compose.yml" ] && [ -f "$ROOT/.env" ] || die "No compose.yml and .env in $ROOT."
  local version image dir
  version="$(compose_version "$ROOT/compose.yml")"
  image="$(app_image "$ROOT/compose.yml")"
  compose_with "$ROOT/compose.yml" stop >/dev/null 2>&1 || die "Could not stop the stack."
  dir="$(take_backup "$version" "$image")" || exit 1
  start_and_wait "$ROOT/compose.yml" "$version" || die "The backup is in $dir, but Toposcope did not come back up. See: docker compose logs"
  say "Toposcope $version is up again. Backup: $dir"
}

cmd_rollback() {
  local yes=0
  [ "${1:-}" != "--yes" ] || yes=1
  need docker
  local dir from to taken
  dir="$(latest_backup)"
  [ -n "$dir" ] || die "There is no backup in $BACKUPS to go back to."
  to="$(cat "$dir/version")"
  from="$(running_version)"
  taken="$(basename "$dir" | cut -d- -f1)"
  say "The last backup is $dir: Toposcope $to, taken $taken (UTC)."
  say "Going back replaces both volumes with it: everything stored since then is lost."
  [ "$yes" = 1 ] || die "Run ./upgrade.sh rollback --yes to go back."
  compose_with "$ROOT/compose.yml" stop >/dev/null 2>&1 || true
  restore_backup "$dir"
  start_and_wait "$ROOT/compose.yml" "$to" || die "$to did not come up from $dir. See: docker compose logs"
  say "Back on $to, from $dir."
  mark "Toposcope ${from:-?} → $to (rolled back)" "$dir"
}

case "${1:-}" in
  backup) cmd_backup ;;
  rollback) shift; cmd_rollback "$@" ;;
  continue) shift; cmd_continue "$@" ;;
  -h | --help | help) sed -n '2,10p' "$0" ;;
  *) cmd_upgrade "$@" ;;
esac
