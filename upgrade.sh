#!/usr/bin/env bash
# Upgrades a packaged Toposcope on this host, with a backup first and a way back (#198).
#
#   ./upgrade.sh [X.Y.Z] [--no-backup] [--wait <minutes>]   to X.Y.Z, or the latest stable release
#   ./upgrade.sh backup                                    both volumes, then start again
#   ./upgrade.sh rollback [--yes]                          back to the last backup
#   ./upgrade.sh enable-ui | disable-ui                    let the app's Upgrade button ask (systemd, root)
#
# Run it in the directory that holds compose.yml and .env (or set TOPOSCOPE_DIR). It is for
# operators: unlike the agent skill's toposcope.sh, rollback replaces the data with the backup's,
# and it keeps only the last 3 backups. The app never runs it: that would need the Docker socket.
# With enable-ui, the app writes a request into its own volume and a systemd unit here runs it (#220).
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
UNITS="${TOPOSCOPE_SYSTEMD_DIR:-/etc/systemd/system}"

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
        # The paragraph that starts with the lead: at the start of the body, or after a blank line.
        # A mention of the lead inside another paragraph is not it (#210).
        if (match(body, /("body": *"|\\n\\n)\*\*Before you upgrade:\*\*([^"\\]|\\.)*/)) {
          text = substr(body, RSTART, RLENGTH)
          sub(/^("body": *"|\\n\\n)\*\*Before you upgrade:\*\* */, "", text)
          sub(/\\n.*/, "", text); gsub(/\\"/, "\"", text)
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

# The settings an env.example describes, set or commented out; from stdin without a file.
example_keys() { sed -n 's/^#* *\([A-Z][A-Z0-9_]*\)=.*/\1/p' ${1:+"$1"} | sort -u; }

# Names the settings the new env.example adds to the running release's that .env does not have,
# commented examples too, since each is described there. Without the old env.example, only the
# ones the new one sets (#256).
new_settings() {
  local example="$1" old_keys="$2" keys key missing=""
  if [ -n "$old_keys" ]; then
    keys="$(example_keys "$example" | grep -vxF -e "$old_keys" || true)"
  else
    keys="$(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$example" | sort -u)"
  fi
  for key in $keys; do
    grep -Eq "^#* *$key=" "$ROOT/.env" || missing="$missing $key"
  done
  [ -z "$missing" ] || say "New settings in env.example that .env does not have:$missing (each is described there)."
}

swap_files() {
  local from="$1" to="$2" dir="$ROOT/releases/$2" old_vector="$ROOT/releases/$1/vector.yaml" file old_keys=""
  # The running release's settings, before its env.example is replaced.
  if [ -f "$ROOT/env.example" ]; then
    old_keys="$(example_keys "$ROOT/env.example")"
  else
    old_keys="$(curl -fsSL -m 10 "$RELEASES/v$from/env.example" 2>/dev/null | example_keys)" || old_keys=""
  fi
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
  new_settings "$ROOT/env.example" "$old_keys"
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
    # 0.9 has people instead of one shared password (#305): nobody signs in until an Owner is made.
    case "$from" in
      0.[0-8].*) say "From 0.9 there is no shared password. Make the first Owner: ./toposcope.sh owner-link <email>, then open the link it prints within the hour. Delete TOPOSCOPE_PASSWORD from .env; scripts need a personal or service account token." ;;
    esac
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

# --- Upgrade from here (#220) ---------------------------------------------------------------
# The app writes upgrade/request.json into its own volume; a systemd path unit runs ui-run, which
# runs the ordinary upgrade and writes upgrade/status.json and upgrade/last.log back for the app.
#
# This runs as root on the host, and the volume is the app's to write: a link the app puts there
# could name any host path. So this script never opens a path in the volume itself. Every read and
# write there runs in a throwaway container that mounts only that volume, with no network, where a
# link can only name a path inside that container.

app_volume() { printf '%s_app_data' "$(project)"; }

# Where the volume is on this host: only for the path unit to watch, never opened here.
ui_dir() {
  local mount
  [ -n "$(project)" ] || return 1
  mount="$(docker volume inspect -f '{{ .Mountpoint }}' "$(app_volume)" 2>/dev/null)" || return 1
  [ -n "$mount" ] || return 1
  printf '%s/upgrade' "$mount"
}

# Runs a shell script inside the volume, as /data, with this script's stdin.
in_volume() {
  docker run --rm -i --network none -v "$(app_volume):/data" --entrypoint /bin/sh "$(app_image "$ROOT/compose.yml")" -c "$1"
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# A JSON string, or null when empty. Control characters are dropped.
json_or_null() {
  [ -n "$1" ] || { printf 'null'; return; }
  printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# state to from started finished backup message
write_status() {
  printf '{"state":%s,"to":%s,"from":%s,"started_at":%s,"finished_at":%s,"backup":%s,"message":%s}\n' \
    "$(json_or_null "$1")" "$(json_or_null "$2")" "$(json_or_null "$3")" "$(json_or_null "$4")" \
    "$(json_or_null "$5")" "$(json_or_null "$6")" "$(json_or_null "$7")" |
    in_volume 'mkdir -p /data/upgrade && cat >/data/upgrade/.status.json.new && mv -f /data/upgrade/.status.json.new /data/upgrade/status.json'
}

unit_name() { printf 'toposcope-upgrade-%s' "$1"; }

cmd_enable_ui() {
  need docker
  need systemctl
  [ -d "${TOPOSCOPE_SYSTEMD_RUN:-/run/systemd/system}" ] ||
    die "Upgrading from the app needs systemd, and this host does not run it. ./upgrade.sh X.Y.Z still works."
  [ -f "$ROOT/compose.yml" ] && [ -f "$ROOT/.env" ] || die "No compose.yml and .env in $ROOT. Run this in the install's directory, or set TOPOSCOPE_DIR."
  [ -w "$UNITS" ] || die "Installing the unit writes $UNITS, which needs root: sudo ./upgrade.sh enable-ui"
  local root name dir unit
  root="$(cd "$ROOT" && pwd)"
  case "$root" in *[[:space:]]*) die "The install's path has a space in it, which a systemd unit cannot name: $root" ;; esac
  name="$(project)"
  [ -n "$name" ] || die "Could not tell this install's Compose project, so not which volume the app writes to."
  dir="$(ui_dir)" || die "Could not find the $(app_volume) volume. Is Toposcope installed here?"
  unit="$(unit_name "$name")"
  cat >"$UNITS/$unit.path" <<UNIT
[Unit]
Description=Toposcope ($name): upgrade when the app asks

[Path]
PathExists=$dir/request.json

[Install]
WantedBy=multi-user.target
UNIT
  cat >"$UNITS/$unit.service" <<UNIT
[Unit]
Description=Toposcope ($name): an upgrade the app asked for

[Service]
Type=oneshot
TimeoutStartSec=infinity
WorkingDirectory=$root
Environment=HOME=/root
Environment=TOPOSCOPE_DIR=$root
Environment=TOPOSCOPE_URL=$URL
Environment=COMPOSE_PROJECT_NAME=$name
ExecStart=$root/upgrade.sh ui-run
UNIT
  # A request left from before must not start an upgrade the moment the unit is on.
  printf '{"enabled_at":"%s","unit":"%s"}\n' "$(now_utc)" "$unit" |
    in_volume 'mkdir -p /data/upgrade && rm -f /data/upgrade/request.json && cat >/data/upgrade/enabled' ||
    die "Could not write into the $(app_volume) volume."
  systemctl daemon-reload || die "systemctl daemon-reload failed."
  systemctl enable --now "$unit.path" >/dev/null 2>&1 || die "Could not start $unit.path. See: systemctl status $unit.path"
  say "Upgrading from the app is on for $root ($unit.path)."
  say "The app's version popover now offers Upgrade; this host runs ./upgrade.sh X.Y.Z when it is clicked, with its backup."
  say "To turn it off: ./upgrade.sh disable-ui"
}

cmd_disable_ui() {
  need systemctl
  [ -w "$UNITS" ] || die "Removing the unit writes $UNITS, which needs root: sudo ./upgrade.sh disable-ui"
  local name unit
  name="$(project)"
  [ -n "$name" ] || die "Could not tell this install's Compose project."
  unit="$(unit_name "$name")"
  systemctl disable --now "$unit.path" >/dev/null 2>&1 || true
  rm -f "$UNITS/$unit.path" "$UNITS/$unit.service"
  systemctl daemon-reload || true
  in_volume 'rm -f /data/upgrade/enabled /data/upgrade/request.json' </dev/null || true
  say "Upgrading from the app is off. ./upgrade.sh X.Y.Z still works."
}

# Run by the systemd unit when the app asks: takes the request, runs the upgrade, says how it went.
cmd_ui_run() {
  local request version from started code now backup message log="$ROOT/upgrade-ui.log"
  # Taken in the same breath as read: the path unit must not fire again on the same request.
  request="$(in_volume 'f=/data/upgrade/request.json; [ -f "$f" ] || exit 0; head -c 4096 "$f"; rm -f "$f"' </dev/null)" ||
    die "Could not read the app's volume."
  [ -n "$request" ] || return 0
  version="$(printf '%s' "$request" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' | head -n 1)"
  from="$(running_version)"
  started="$(now_utc)"
  if ! is_version "$version"; then
    write_status failed "" "$from" "$started" "$started" "" "The request did not name a release (X.Y.Z)."
    return 1
  fi
  write_status running "$version" "$from" "$started" "" "" ""
  # The output goes to the install's own directory, and a copy into the volume through the container.
  set +e
  TOPOSCOPE_DIR="$ROOT" bash "$0" "$version" 2>&1 | tee "$log" | in_volume 'cat >/data/upgrade/last.log'
  code="${PIPESTATUS[0]}"
  set -e
  now="$(running_version)"
  backup="$(sed -n 's/.* Backup: \(.*\)$/\1/p' "$log" | tail -n 1)"
  if [ "$code" = 0 ] && [ "$now" = "$version" ]; then
    write_status done "$version" "$from" "$started" "$(now_utc)" "$backup" ""
    return 0
  fi
  [ -n "$backup" ] || backup="$(sed -n 's/^Backup done in [0-9]*s: \(.*\), [0-9]* MB\.$/\1/p' "$log" | tail -n 1)"
  message="$(grep -E 'did not come up|does not match|Could not|is not newer|not answering|needs about|No compose.yml|not installed|has no SHA256SUMS|did not finish|does not list' "$log" | head -n 1 || true)"
  [ -n "$message" ] || message="$(grep -v '^ ' "$log" | tail -n 1 || true)"
  message="${message% Its last log lines:}"
  write_status failed "$version" "$from" "$started" "$(now_utc)" "$backup" "$message"
  return 1
}

case "${1:-}" in
  enable-ui) cmd_enable_ui ;;
  disable-ui) cmd_disable_ui ;;
  ui-run) cmd_ui_run ;;
  backup) cmd_backup ;;
  rollback) shift; cmd_rollback "$@" ;;
  continue) shift; cmd_continue "$@" ;;
  -h | --help | help) sed -n '2,12p' "$0" ;;
  *) cmd_upgrade "$@" ;;
esac
