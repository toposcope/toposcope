#!/usr/bin/env bash
# One Toposcope on this machine, for the toposcope agent skill.
# Talks only to 127.0.0.1, except `check <monitor> -- <command>`, which sends
# to TOPOSCOPE_URL when it is set. Writes secrets to files and never prints them.
# Stops the instance when asked and never removes data.
set -euo pipefail

VERSION="0.10.1"
IMAGE="ghcr.io/toposcope/toposcope:$VERSION"
# The release files, checked against its SHA256SUMS. Tests point this at a stand-in on loopback.
RELEASE="${TOPOSCOPE_RELEASE_URL:-https://github.com/toposcope/toposcope/releases/download/v$VERSION}"
# A packaged install runs the release's copy beside its compose.yml and .env; the skill keeps its own.
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${TOPOSCOPE_DIR:-}" ] && [ -f "$HERE/compose.yml" ] && [ -f "$HERE/.env" ]; then
  ROOT="$HERE"
else
  ROOT="${TOPOSCOPE_DIR:-$HOME/.toposcope}"
fi
# The packaged install publishes 8080. Tests point this at a stub on loopback.
PORT="${TOPOSCOPE_PORT:-8080}"
URL="http://127.0.0.1:$PORT"
PROJECT="${COMPOSE_PROJECT_NAME:-toposcope}"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

# The port is digits and nothing else, so URL names 127.0.0.1 and no other host.
[[ $PORT =~ ^[0-9]{1,5}$ ]] && [ "$((10#$PORT))" -ge 1 ] && [ "$((10#$PORT))" -le 65535 ] ||
  die "TOPOSCOPE_PORT is a port, 1 to 65535."

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

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Downloads the release's files into $ROOT, each checked against the release's SHA256SUMS first:
# a file goes in place only when it matches, and a mismatch starts nothing and names the file.
fetch_release() {
  curl -fsSL "$RELEASE/SHA256SUMS" -o "$ROOT/SHA256SUMS" ||
    die "Could not download SHA256SUMS for $VERSION from the release, so its files cannot be checked. Nothing was started."
  local file expected got
  for file in compose.yml env.example vector.yaml LICENSE toposcope.sh; do
    curl -fsSL "$RELEASE/$file" -o "$ROOT/$file.part" ||
      die "Could not download $file for $VERSION from the release. Nothing was started."
    expected="$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1; exit }' "$ROOT/SHA256SUMS")"
    [ -n "$expected" ] || die "The release's SHA256SUMS does not list $file. Nothing was started."
    got="$(sha256_of "$ROOT/$file.part")"
    [ "$got" = "$expected" ] ||
      die "$file from the $VERSION release does not match its SHA256SUMS: it is kept as $ROOT/$file.part. Nothing was started."
    mv -f "$ROOT/$file.part" "$ROOT/$file"
  done
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
  printf -- '- keep its files and two generated secrets in %s, and its data in two Docker volumes\n' "$ROOT"
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
    fetch_release
    (
      umask 077
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          CLICKHOUSE_PASSWORD= | TOPOSCOPE_INGEST_TOKEN=)
            printf '%s%s\n' "$line" "$(secret)"
            ;;
          *) printf '%s\n' "$line" ;;
        esac
      done <"$ROOT/env.example" >"$ROOT/.env"
    )
    local key
    for key in CLICKHOUSE_PASSWORD TOPOSCOPE_INGEST_TOKEN; do
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
      [ -z "$service" ] || printf 'OTEL_SERVICE_NAME=%s\n' "$service"
      [ -z "$version" ] || printf 'OTEL_RESOURCE_ATTRIBUTES=service.version=%s\n' "$version"
      printf 'TOPOSCOPE_URL=http://127.0.0.1:8080\n'
      printf 'TOPOSCOPE_INGEST_TOKEN=%s\n' "$token"
    } >"$file"
  )
  chmod 600 "$file"
  printf 'Wrote %s. It sets the OTLP endpoint, protocol, token header, logs and metrics exporters on' "$file"
  [ -z "$service" ] || printf ', service name'
  [ -z "$version" ] || printf ', service version'
  printf ', and TOPOSCOPE_URL and TOPOSCOPE_INGEST_TOKEN for a direct post. Values are not shown. It holds the ingest token: keep it out of git.\n'
}

# A read-only service account token for `check`, made once on the host and kept in a file,
# never printed (#305: there is no shared password to read with).
read_token() {
  local file="$ROOT/skill.token"
  if [ ! -s "$file" ]; then
    need docker
    [ -f "$ROOT/compose.yml" ] || die "No instance files in $ROOT. Run: up"
    (
      umask 077
      compose exec -T app bun run src/cli.ts service-token toposcope-skill viewer skill >"$file.part" 2>"$ROOT/token.log"
    ) || die "Could not make a read token for the skill. See $ROOT/token.log."
    mv "$file.part" "$file"
  fi
  tr -d '\r\n' <"$file"
}

# The first Owner, or a locked-out Owner's way back in (32a): a link that works once, for an hour.
# It is printed here and nowhere else: not in the app's log, not on disk.
cmd_owner_link() {
  local email="${1:-}"
  printf '%s' "$email" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' ||
    die "Usage: owner-link <email>"
  need docker
  [ -f "$ROOT/compose.yml" ] || die "No instance files in $ROOT. Run this beside the install's compose.yml, or set TOPOSCOPE_DIR."
  compose exec -T app bun run src/cli.ts owner-link "$email"
}

# A service account's token, for a script that is not a person (32f). Printed once, here.
cmd_service_token() {
  local account="${1:-}" role="${2:-}" name="${3:-host}"
  printf '%s' "$account" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' && printf '%s' "$role" | grep -Eq '^(viewer|operator|owner)$' ||
    die "Usage: service-token <account> <viewer|operator|owner> [token name]"
  need docker
  [ -f "$ROOT/compose.yml" ] || die "No instance files in $ROOT. Run this beside the install's compose.yml, or set TOPOSCOPE_DIR."
  compose exec -T app bun run src/cli.ts service-token "$account" "$role" "$name"
}

# A token the instance made for this script that it could not keep: revoked, so no live token is
# left printed nowhere.
drop_tokens() {
  printf '%s\n' "$1" | compose exec -T app bun run src/cli.ts revoke-token >/dev/null 2>>"$ROOT/token.log" || true
}

# An agent (#357): the Operator service account `agent: <name>`, made once and kept, and a new
# token for it each run, written to a file only this user can read. The token is never printed.
cmd_agent() {
  local name="${1:-}"
  [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,56}$ ]] ||
    die "Usage: agent <name>, with 1 to 57 letters, digits, . _ or -, starting with a letter or digit"
  need docker
  [ -f "$ROOT/compose.yml" ] || die "No instance files in $ROOT. Run this beside the install's compose.yml, or set TOPOSCOPE_DIR."
  local file="$ROOT/agent-$name.token"
  if [ -L "$file" ] || { [ -e "$file" ] && [ ! -f "$file" ]; }; then
    die "$file is not a regular file, so no token is written there. Nothing was made."
  fi
  local token tmp
  token="$(compose exec -T app bun run src/cli.ts agent "$name" 2>"$ROOT/token.log")" || {
    drop_tokens "$token"
    die "Could not make a token for agent: $name. See $ROOT/token.log."
  }
  if [[ ! $token =~ ^tsp1_[A-Za-z0-9_-]+$ ]]; then
    drop_tokens "$token"
    die "The instance did not answer with one token for agent: $name. Nothing was written."
  fi
  # A new file of its own, made only for this user before the token goes in, then put in place.
  if ! tmp="$(umask 077 && mktemp "$ROOT/.agent-$name.XXXXXX")" || ! chmod 600 "$tmp" ||
    ! printf '%s\n' "$token" >"$tmp" || [ -L "$file" ] || { [ -e "$file" ] && [ ! -f "$file" ]; } ||
    ! mv -f "$tmp" "$file"; then
    drop_tokens "$token"
    die "Could not write $file, so its token was revoked."
  fi
  local said role kept
  said="$(sed -n 's/^agent: //p' "$ROOT/token.log" | tail -n 1)"
  role="${said% *}"
  kept="${said##* }"
  case "$role" in
    operator) role="an Operator" ;;
    viewer) role="a Viewer" ;;
  esac
  if [ "$kept" = "kept" ]; then
    printf 'agent: %s is %s already; it has a new token, and its earlier ones work until they are revoked in Access.\n' "$name" "$role"
  else
    printf 'Made agent: %s, %s. What it saves shows under that name.\n' "$name" "$role"
  fi
  printf 'Its token is in %s, which only you can read. The token is not shown.\n' "$file"
  printf 'For Claude Code, in the app'"'"'s repository:\n'
  claude_line "$file"
}

# The line that adds this instance to Claude Code as an agent. The token's file is read when the
# line runs, its path escaped for the shell; the token then sits in Claude Code's own config.
claude_line() {
  local quoted
  printf -v quoted '%q' "$1"
  printf '  claude mcp add --transport http toposcope %s/mcp --header "Authorization: Bearer $(cat -- %s)"\n' "$URL" "$quoted"
}

# The file an agent's token is in: `agent-<name>.token` beside .env, or the only one there is.
# Prints the file's path, never the token.
agent_file() {
  local name="${1:-}" file
  if [ -n "$name" ]; then
    [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,56}$ ]] ||
      die "An agent's name is 1 to 57 letters, digits, . _ or -, starting with a letter or digit."
    file="$ROOT/agent-$name.token"
  else
    local found=()
    for file in "$ROOT"/agent-*.token; do
      [ -e "$file" ] || [ -L "$file" ] || continue
      found+=("$file")
    done
    [ "${#found[@]}" -gt 0 ] || die "No agent's token in $ROOT. Run: agent <name>"
    [ "${#found[@]}" -eq 1 ] || die "There is more than one agent's token in $ROOT: name one with --agent <name>."
    file="${found[0]}"
  fi
  [ ! -L "$file" ] && [ -f "$file" ] || die "No agent's token at $file. Run: agent <name>"
  printf '%s' "$file"
}

# An agent's token, read from its file into the caller's variable `token`. Never printed.
read_agent_token() {
  token=""
  IFS= read -r token <"$1" || [ -n "$token" ] || die "Could not read $1."
  token="${token%$'\r'}"
  [[ $token =~ ^tsp1_[A-Za-z0-9_-]+$ ]] || die "$1 does not hold one token. Run: agent <name>"
}

# Whether a file is one `mcp --json` wrote: its five lines, in its shape.
mcp_json_ours() {
  LC_ALL=C awk -v m="$1" '
    NR == 1 && $0 != m { bad = 1 }
    NR == 2 && $0 != "  \"type\": \"http\"," { bad = 1 }
    NR == 3 && $0 !~ /^  "url": "http:\/\/127\.0\.0\.1:[0-9]+\/mcp",$/ { bad = 1 }
    NR == 4 && $0 !~ /^  "headers": \{ "Authorization": "Bearer tsp1_[A-Za-z0-9_-]+" \}$/ { bad = 1 }
    { last = $0 }
    END { exit (NR == 5 && last == "} } }" && !bad) ? 0 : 1 }
  ' "$2"
}

# The temp file `mcp --json` writes before it moves it in place; taken away however the script ends.
MCP_TMP=""
trap '[ -z "$MCP_TMP" ] || rm -f -- "$MCP_TMP"' EXIT INT TERM

# How an MCP client connects as an agent (#361). Prints the Claude Code line, which reads the token
# from its file when it runs; `--json <file>` writes the config other clients read, with the token
# in it, to a file only this user can read and git ignores. The token is never printed.
cmd_mcp() {
  local agent="" json=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --agent) agent="${2:-}"; [ -n "$agent" ] || die "Usage: mcp [--agent <name>] [--json <file>]"; shift 2 ;;
      --json) json="${2:-}"; [ -n "$json" ] || die "Usage: mcp [--agent <name>] [--json <file>]"; shift 2 ;;
      *) die "Usage: mcp [--agent <name>] [--json <file>]" ;;
    esac
  done
  local file
  file="$(agent_file "$agent")"
  if [ -z "$json" ]; then
    printf 'For Claude Code, in the app'"'"'s repository (it reads the token from %s as it runs, and keeps it in its own config):\n' "$file"
    claude_line "$file"
    printf 'For another client: mcp --json <file> writes its config. The token is not shown.\n'
    return
  fi

  local token marker='{ "mcpServers": { "toposcope": {'
  read_agent_token "$file"
  local dir base
  dir="$(dirname "$json")"
  base="$(basename "$json")"
  [ -d "$dir" ] || die "$dir is not a directory."
  if [ -L "$json" ] || { [ -e "$json" ] && [ ! -f "$json" ]; }; then
    die "$json is not a regular file, so no token is written there."
  fi
  if [ -e "$json" ] && ! mcp_json_ours "$marker" "$json"; then
    die "$json exists and was not written by this skill. Choose another file, or add toposcope to it by hand from: mcp"
  fi
  if ! command -v git >/dev/null 2>&1; then
    printf 'git is not installed, so whether %s is in a git repository was not checked. Keep it out of git: it holds the token.\n' "$json" >&2
  elif git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 && ! git -C "$dir" check-ignore -q -- "$base"; then
    die "$json is in a git repository and git does not ignore it. Add it to .gitignore first: it will hold the agent's token."
  fi
  # Written beside the instance's .env, which no repository holds, then moved in place.
  if ! MCP_TMP="$(umask 077 && mktemp "$ROOT/.mcp-json.XXXXXX")" || ! chmod 600 "$MCP_TMP" ||
    ! {
      printf '%s\n' "$marker"
      printf '  "type": "http",\n'
      printf '  "url": "%s/mcp",\n' "$(json_text "$URL")"
      printf '  "headers": { "Authorization": "Bearer %s" }\n' "$(json_text "$token")"
      printf '} } }\n'
    } >"$MCP_TMP" || [ -L "$json" ] || ! mv -f "$MCP_TMP" "$json"; then
    die "Could not write $json."
  fi
  MCP_TMP=""
  printf 'Wrote %s: the toposcope MCP server at %s/mcp, as %s. It holds the token, which is not shown: keep it out of git.\n' \
    "$json" "$URL" "$(basename "$file" .token | sed 's/^agent-/agent: /')"
}

# Whether text is one JSON object and nothing after it: strings and their escapes read, every bracket
# closed by its own kind, and the outer object closed by the last character that is not space. So it
# cannot end the arguments early and name another tool; the instance parses the rest.
json_object_ok() {
  printf '%s' "$1" | LC_ALL=C awk '
    { text = text (NR > 1 ? "\n" : "") $0 }
    END {
      n = length(text); depth = 0; instr = 0; esc = 0; started = 0
      for (i = 1; i <= n; i++) {
        c = substr(text, i, 1)
        if (instr) {
          if (esc) esc = 0; else if (c == "\\") esc = 1; else if (c == "\"") instr = 0
          continue
        }
        if (c == " " || c == "\t" || c == "\n" || c == "\r") continue
        if (!started) { if (c != "{") exit 1; started = 1 }
        else if (depth == 0) exit 1
        if (c == "\"") instr = 1
        else if (c == "{" || c == "[") stack[++depth] = c
        else if (c == "}") { if (depth == 0 || stack[depth] != "{") exit 1; depth-- }
        else if (c == "]") { if (depth == 0 || stack[depth] != "[") exit 1; depth-- }
      }
      exit (started && depth == 0 && !instr) ? 0 : 1
    }'
}

# One MCP tool, called over HTTP as an agent (#361): a `tools/call` to /mcp. The token goes to curl
# through a pipe on its stdin as a header (`-H @-`), and the call's JSON through a pipe of its own
# (`@<(...)`), so neither is in an argument `ps` shows and neither touches the disk. `-q` keeps a
# .curlrc out and `--noproxy` a proxy, so neither sees the header. `-` in place of the JSON reads it
# from stdin. Prints the JSON-RPC answer; exits 1 when the tool or the server refused.
cmd_call() {
  local agent="" tool="" args=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --agent) agent="${2:-}"; [ -n "$agent" ] || die "Usage: call [--agent <name>] <tool> ['<json>' | -]"; shift 2 ;;
      *)
        if [ -z "$tool" ]; then tool="$1"; elif [ -z "$args" ]; then args="$1"; else die "Usage: call [--agent <name>] <tool> ['<json>' | -]"; fi
        shift
        ;;
    esac
  done
  [[ $tool =~ ^[a-z][a-z0-9_]{0,63}$ ]] || die "Usage: call [--agent <name>] <tool> ['<json>' | -], with a tool's name as tools/list gives it"
  need curl
  [ "$args" != "-" ] || args="$(cat)"
  [ -n "$args" ] || args="{}"
  json_object_ok "$args" || die "A tool's arguments are one JSON object, such as '{\"name\":\"errors\"}'."

  local file token
  file="$(agent_file "$agent")"
  read_agent_token "$file"
  local payload answer code
  payload="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
  # printf is the shell's own, so the token passes through a pipe and is in no process's arguments.
  answer="$(printf 'authorization: Bearer %s\n' "$token" |
    curl -q --noproxy '*' -sS -m 60 -X POST "$URL/mcp" -H @- \
      -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
      -H 'mcp-protocol-version: 2025-11-25' -A "toposcope.sh/$VERSION" \
      --data-binary @<(printf '%s' "$payload") -w '\n%{http_code}')" ||
    die "Could not reach $URL/mcp. Run: status"
  code="${answer##*$'\n'}"
  answer="${answer%$'\n'*}"
  printf '%s\n' "$answer"
  case "$code" in
    2??) ;;
    *) printf 'The instance answered %s.\n' "$code" >&2; return 1 ;;
  esac
  if [[ $answer != *'"isError":false'* ]]; then
    printf '%s refused: its answer above says why.\n' "$tool" >&2
    return 1
  fi
}

cmd_marker() {
  printf 'tscheck%s\n' "$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
}

cmd_check() {
  need curl
  local word="${1:-}"
  printf '%s' "$word" | grep -Eq '^tscheck[0-9a-f]{12}$' ||
    die "Usage: check <word>, with the word that marker printed."

  local token body="" waited=0 wait="${TOPOSCOPE_CHECK_WAIT:-30}"
  token="$(read_token)"

  # The word is the error's whole message, so it is in the log line or in
  # exception.message. Exporters batch, so a row can take a few seconds.
  # Every read names its window.
  local q="$word OR exception.message:$word"
  while :; do
    body="$(printf 'header = "authorization: Bearer %s"\n' "$token" |
      curl -q --noproxy '*' -fsS -m 10 -K - "$URL/api/search?q=$word%20OR%20exception.message:$word&range=15m")" ||
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

# A string's JSON text, without its quotes. Control characters other than tab,
# newline and carriage return are dropped.
json_text() {
  printf '%s' "$1" | LC_ALL=C tr -d '\000-\010\013\014\016-\037' |
    LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$(printf '\t')/\\\\t/g" -e "s/$(printf '\r')/\\\\r/g" |
    awk 'NR > 1 { printf "%s", "\\n" } { printf "%s", $0 }'
}

now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    # Seconds and microseconds, whatever the locale's decimal mark.
    local digits="${EPOCHREALTIME//[!0-9]/}"
    printf '%s' "${digits:0:13}"
  else
    printf '%s000' "$(date +%s)"
  fi
}

# Runs a command and sends how it went to a push monitor (#177): its exit code
# (0 ok, 1 warn, 2 fail, 3 unknown, anything else a fail), how long it ran, and
# the tail of its output. For a Nagios plugin, whose first line carries
# perfdata, that line is the message and its first value is the value. A name
# not seen before creates its monitor. The command's output and exit code pass
# through, so cron still sees them.
cmd_check_monitor() {
  local monitor="${1:-}"
  [ -n "$monitor" ] && [ "${2:-}" = "--" ] && [ "$#" -gt 2 ] ||
    die "Usage: check <monitor> -- <command> [args...]"
  shift 2
  need curl
  local url="${TOPOSCOPE_URL:-$URL}" token="${TOPOSCOPE_INGEST_TOKEN:-}"
  [ -n "$token" ] || token="$(env_value TOPOSCOPE_INGEST_TOKEN)"
  [ -n "$token" ] || die "No ingest token: set TOPOSCOPE_INGEST_TOKEN, or run up."

  local out code started ended
  started="$(now_ms)"
  set +e
  out="$("$@" 2>&1)"
  code=$?
  set -e
  ended="$(now_ms)"
  [ -z "$out" ] || printf '%s\n' "$out"

  local first message="" value="" unit="" perf=""
  first="${out%%$'\n'*}"
  case "$first" in
    *"|"*=*)
      message="${first%%|*}"
      message="${message%"${message##*[![:space:]]}"}"
      perf="$(printf '%s' "${first#*|}" |
        LC_ALL=C sed -E -n "s/^[[:space:]]*('[^']*'|[^=[:space:]]+)=(-?[0-9]+(\.[0-9]+)?)([a-zA-Z%]*).*/\2 \4/p")"
      if [ -n "$perf" ]; then
        value="$(printf '%s' "${perf%% *}" | awk '{ print $1 + 0 }')"
        unit="${perf#* }"
      fi
      ;;
    *)
      message="$(printf '%s' "$out" | tail -c 4096)"
      ;;
  esac

  local status
  case "$code" in
    0 | 1 | 2 | 3) status="$code" ;;
    *) status='"fail"' ;;
  esac
  local body
  body="{\"monitor\":\"$(json_text "$monitor")\",\"status\":$status,\"exit_code\":$code"
  body="$body,\"duration_ms\":$((ended - started)),\"host\":\"$(json_text "$(uname -n)")\""
  body="$body,\"message\":\"$(json_text "$message")\""
  [ -z "$value" ] || body="$body,\"value\":$value"
  [ -z "$unit" ] || body="$body,\"unit\":\"$(json_text "$unit")\""
  body="$body}"

  printf 'header = "authorization: Bearer %s"\n' "$token" |
    curl -q -fsS -m 10 -K - -o /dev/null -X POST "$url/v1/checks" \
      -H 'content-type: application/json' -A "toposcope.sh/$VERSION" --data-binary "$body" ||
    printf 'The result of %s was not sent to %s.\n' "$monitor" "$url" >&2
  return "$code"
}

case "${1:-}" in
  cost) cmd_cost ;;
  up) cmd_up ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  app-env) shift; cmd_app_env "$@" ;;
  marker) cmd_marker ;;
  owner-link) shift; cmd_owner_link "$@" ;;
  service-token) shift; cmd_service_token "$@" ;;
  agent) shift; cmd_agent "$@" ;;
  mcp) shift; cmd_mcp "$@" ;;
  call) shift; cmd_call "$@" ;;
  # `check <word>` reads a test error back; `check <monitor> -- <command>` sends a result.
  check) shift; if [ "${2:-}" = "--" ]; then cmd_check_monitor "$@"; else cmd_check "$@"; fi ;;
  *)
    die "Usage: toposcope.sh cost | up | status | stop | owner-link <email> | service-token <account> <role> [name] | agent <name> | mcp [--agent <name>] [--json <file>] | call [--agent <name>] <tool> ['<json>' | -] | app-env <file> [--service <name>] [--version <version>] | marker | check <word> | check <monitor> -- <command>"
    ;;
esac
