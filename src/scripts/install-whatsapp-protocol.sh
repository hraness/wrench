#!/bin/sh
set -eu

version=0.15.0
transport_version=official-release
release_tag=v0.15.0
release_commit=a020de724180d31eccfa5241d45443402d62fb06
archive_name=wacli_0.15.0_darwin_arm64.tar.gz
archive_sha256=2b54f33d246e913a5c33525b4fc895a345363c2dcc673c70fa5f19cffb15d17d
binary_sha256=a900af4d0dfd10471bcdf74105b9f256d1a08574242a041df3e5985a548826aa
release_url="https://github.com/openclaw/wacli/releases/download/$release_tag/$archive_name"
signature_identifier=org.openclaw.wacli
signature_team=FWJYW4S8P8
signature_authority='Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)'
signature_cdhash=a67b5d50877d6a2c3386d969d24dfc991bcc6a85
signature_cdhash_full=a67b5d50877d6a2c3386d969d24dfc991bcc6a8571a3343afc82e8d6de32e486
signature_requirement='designated => identifier "org.openclaw.wacli" and anchor apple generic and certificate leaf[subject.OU] = FWJYW4S8P8'

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
state_home_resolver=$script_directory/resolve-state-home.ts

fail() {
  printf '%s\n' "Wrench WhatsApp runtime installer: $1" >&2
  exit 1
}

file_sha256() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

require_regular_file() {
  file=$1
  expected=$2
  label=$3
  if [ ! -f "$file" ] || [ -L "$file" ]; then
    fail "$label is not a real file"
  fi
  if [ "$(file_sha256 "$file")" != "$expected" ]; then
    fail "$label SHA-256 mismatch"
  fi
}

require_owned_private_directory() {
  directory=$1
  label=$2
  if [ ! -d "$directory" ] || [ -L "$directory" ]; then
    fail "$label is not a real directory"
  fi
  if [ "$(/usr/bin/stat -f '%u' "$directory")" != "$(/usr/bin/id -u)" ]; then
    fail "$label is not owned by the current user"
  fi
  if [ "$(/usr/bin/stat -f '%Lp' "$directory")" != "700" ]; then
    fail "$label must have mode 0700"
  fi
}

verify_signature() {
  binary=$1
  if ! /usr/bin/codesign --verify --strict --verbose=4 "$binary" >/dev/null 2>&1; then
    fail "official binary code signature is invalid"
  fi
  signature_output=$(/usr/bin/codesign --display --verbose=4 "$binary" 2>&1) \
    || fail "official binary signature metadata is unavailable"
  printf '%s\n' "$signature_output" | /usr/bin/grep -Fqx \
    "Identifier=$signature_identifier" \
    || fail "official binary signing identifier mismatch"
  printf '%s\n' "$signature_output" | /usr/bin/grep -Fqx \
    "TeamIdentifier=$signature_team" \
    || fail "official binary signing team mismatch"
  application_authorities=$(printf '%s\n' "$signature_output" \
    | /usr/bin/grep -c '^Authority=Developer ID Application:' || true)
  if [ "$application_authorities" != "1" ]; then
    fail "official binary must have one Developer ID Application authority"
  fi
  printf '%s\n' "$signature_output" | /usr/bin/grep -Fqx \
    "Authority=$signature_authority" \
    || fail "official binary Developer ID authority mismatch"
  printf '%s\n' "$signature_output" | /usr/bin/grep -Eq \
    'flags=0x[0-9a-fA-F]+\(runtime\)' \
    || fail "official binary is missing hardened runtime"
  printf '%s\n' "$signature_output" | /usr/bin/grep -Eq \
    '^Timestamp=.+$' \
    || fail "official binary is missing its trusted timestamp"
  if printf '%s\n' "$signature_output" | /usr/bin/grep -Fqx 'Timestamp=none'; then
    fail "official binary trusted timestamp is disabled"
  fi
  printf '%s\n' "$signature_output" | /usr/bin/grep -Fqx \
    "CDHash=$signature_cdhash" \
    || fail "official binary CDHash mismatch"
  printf '%s\n' "$signature_output" | /usr/bin/grep -Fqx \
    "CandidateCDHashFull sha256=$signature_cdhash_full" \
    || fail "official binary full CDHash mismatch"

  requirement_output=$(/usr/bin/codesign --display --requirements - "$binary" 2>&1) \
    || fail "official binary designated requirement is unavailable"
  printf '%s\n' "$requirement_output" | /usr/bin/grep -Fqx \
    "$signature_requirement" \
    || printf '%s\n' "$requirement_output" | /usr/bin/grep -Fqx \
      'designated => identifier "org.openclaw.wacli" and anchor apple generic and certificate leaf[subject.OU] = "FWJYW4S8P8"' \
    || fail "official binary designated requirement mismatch"

  if ! /usr/bin/codesign --verify --strict --check-notarization \
    -R=notarized "$binary" >/dev/null 2>&1; then
    fail "official binary notarization constraint is not satisfied"
  fi
}

verify_binary() {
  binary=$1
  require_regular_file "$binary" "$binary_sha256" "official binary"
  if [ "$(/usr/bin/lipo -archs "$binary")" != "arm64" ]; then
    fail "official binary architecture mismatch"
  fi
  verify_signature "$binary"
  if [ "$("$binary" version)" != "$version" ]; then
    fail "official binary version mismatch"
  fi
}

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  fail "the pinned official archive currently supports macOS arm64 only"
fi
if [ ! -x /usr/bin/codesign ] || [ ! -x /usr/bin/lipo ]; then
  fail "Apple code-signing tools are required"
fi
if [ ! -f "$state_home_resolver" ] || [ -L "$state_home_resolver" ]; then
  fail "state-home resolver is not a real file"
fi

if [ -n "${WRENCH_BUN:-}" ]; then
  bun_path=$WRENCH_BUN
elif [ -n "${OH_BUN:-}" ]; then
  bun_path=$OH_BUN
elif command -v bun >/dev/null 2>&1; then
  bun_path=$(command -v bun)
elif [ -x "${HOME:?HOME is required}/.bun/bin/bun" ]; then
  bun_path="$HOME/.bun/bin/bun"
else
  fail "Bun 1.3.14 was not found; set WRENCH_BUN to its absolute executable path"
fi
case "$bun_path" in
  /*) ;;
  *) fail "Bun path must be absolute" ;;
esac
if [ ! -x "$bun_path" ] || [ "$("$bun_path" --version)" != "1.3.14" ]; then
  fail "Bun path must name an executable Bun 1.3.14"
fi

state_home=$("$bun_path" run --no-install "$state_home_resolver" "$version")
runtime_parent=$state_home/tools/wacli/$version
target_directory=$runtime_parent/$transport_version
target=$target_directory/wacli
require_owned_private_directory "$runtime_parent" "runtime version directory"
if [ -e "$target_directory" ] || [ -L "$target_directory" ]; then
  require_owned_private_directory "$target_directory" "official runtime directory"
else
  /bin/mkdir -m 0700 -- "$target_directory"
fi
if [ -e "$target" ] || [ -L "$target" ]; then
  if [ ! -f "$target" ] || [ -L "$target" ]; then
    fail "official runtime target is not a real file"
  fi
  if [ "$(/usr/bin/stat -f '%u' "$target")" != "$(/usr/bin/id -u)" ]; then
    fail "official runtime target is not owned by the current user"
  fi
  if [ "$(/usr/bin/stat -f '%Lp' "$target")" != "700" ]; then
    fail "official runtime target must have mode 0700"
  fi
  verify_binary "$target"
  printf '%s\n' "Pinned official WhatsApp runtime is already installed"
  exit 0
fi

umask 077
temporary_directory=$(/usr/bin/mktemp -d \
  "${TMPDIR:-/tmp}/wrench-wacli-official-install.XXXXXX")
cleanup() {
  if [ -n "${temporary_target:-}" ]; then
    case "$temporary_target" in
      "$target_directory"/.wacli-install.*) /bin/rm -f -- "$temporary_target" ;;
    esac
  fi
  case "$temporary_directory" in
    "${TMPDIR:-/tmp}"/wrench-wacli-official-install.*)
      /bin/chmod -R u+w "$temporary_directory" 2>/dev/null || true
      /bin/rm -rf -- "$temporary_directory"
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM

archive=$temporary_directory/$archive_name
/usr/bin/curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$archive" "$release_url"
require_regular_file "$archive" "$archive_sha256" \
  "official release archive for commit $release_commit"
archive_entries=$(/usr/bin/tar -tzf "$archive") \
  || fail "official release archive could not be listed"
expected_entries='LICENSE
README.md
wacli'
if [ "$archive_entries" != "$expected_entries" ]; then
  fail "official release archive inventory mismatch"
fi

extracted=$temporary_directory/extracted
/bin/mkdir -m 0700 -- "$extracted"
/usr/bin/tar -xzf "$archive" -C "$extracted"
for entry in LICENSE README.md wacli; do
  if [ ! -f "$extracted/$entry" ] || [ -L "$extracted/$entry" ]; then
    fail "official release archive contains an unsafe $entry"
  fi
done
verify_binary "$extracted/wacli"

temporary_target=$target_directory/.wacli-install.$$
if [ -e "$temporary_target" ] || [ -L "$temporary_target" ]; then
  fail "temporary publication target already exists"
fi
/bin/cp -- "$extracted/wacli" "$temporary_target"
/bin/chmod 0700 "$temporary_target"
verify_binary "$temporary_target"
if ! /bin/ln -- "$temporary_target" "$target"; then
  fail "official runtime publication target already exists"
fi
/bin/rm -f -- "$temporary_target"
temporary_target=
verify_binary "$target"

printf '%s\n' "Installed pinned official WhatsApp runtime $version"
