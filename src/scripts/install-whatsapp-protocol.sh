#!/bin/sh
set -eu

version=0.13.0
archive_sha256=9e6c1ddbe9e4163960689526b714213867533bc4b2eb656c345a4411b70ccdd5
binary_sha256=b9ce58668cb0a1ed60115cfe4d59df02b99c876c8ee5671515fce3425aae520b
release_url="https://github.com/openclaw/wacli/releases/download/v${version}/wacli_${version}_darwin_arm64.tar.gz"
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
state_home_resolver=$script_directory/resolve-state-home.ts

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  printf '%s\n' "Wrench WhatsApp runtime installer: the reviewed binary pin currently supports macOS arm64 only" >&2
  exit 1
fi

if [ ! -f "$state_home_resolver" ] || [ -L "$state_home_resolver" ]; then
  printf '%s\n' "Wrench WhatsApp runtime installer: state-home resolver is not a real file: $state_home_resolver" >&2
  exit 1
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
  printf '%s\n' "Wrench WhatsApp runtime installer: Bun 1.3.14 was not found; set WRENCH_BUN to its absolute executable path" >&2
  exit 1
fi

case "$bun_path" in
  /*) ;;
  *)
    printf '%s\n' "Wrench WhatsApp runtime installer: Bun path must be absolute: $bun_path" >&2
    exit 1
    ;;
esac

if [ ! -x "$bun_path" ]; then
  printf '%s\n' "Wrench WhatsApp runtime installer: Bun is not executable: $bun_path" >&2
  exit 1
fi

bun_version=$("$bun_path" --version)
if [ "$bun_version" != "1.3.14" ]; then
  printf '%s\n' "Wrench WhatsApp runtime installer: expected Bun 1.3.14, found $bun_version at $bun_path" >&2
  exit 1
fi

state_home=$("$bun_path" run --no-install "$state_home_resolver" "$version")

target_directory=$state_home/tools/wacli/$version
target=$target_directory/wacli

file_sha256() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

if [ -L "$target" ]; then
  printf '%s\n' "Wrench WhatsApp runtime installer: refusing symbolic-link target $target" >&2
  exit 1
fi
if [ -e "$target" ]; then
  if [ ! -f "$target" ] || [ "$(file_sha256 "$target")" != "$binary_sha256" ]; then
    printf '%s\n' "Wrench WhatsApp runtime installer: existing pinned-version target has unexpected contents: $target" >&2
    exit 1
  fi
  chmod 0700 "$target"
  printf '%s\n' "Pinned WhatsApp protocol runtime is already installed at $target"
  exit 0
fi

umask 077
temporary_directory=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/wrench-wacli-install.XXXXXX")
archive=$temporary_directory/wacli.tar.gz
signature=$temporary_directory/codesign.txt
cleanup() {
  /bin/rm -f -- "$archive" "$signature" "$temporary_directory/wacli" "$temporary_directory/LICENSE" "$temporary_directory/README.md"
  if [ -n "${temporary_target:-}" ]; then
    case "$temporary_target" in
      "$target_directory"/.wacli-install.*) /bin/rm -f -- "$temporary_target" ;;
    esac
  fi
  /bin/rmdir -- "$temporary_directory" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

/usr/bin/curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$archive" "$release_url"
if [ "$(file_sha256 "$archive")" != "$archive_sha256" ]; then
  printf '%s\n' "Wrench WhatsApp runtime installer: release archive SHA-256 mismatch" >&2
  exit 1
fi

/usr/bin/tar -xzf "$archive" -C "$temporary_directory"
if [ ! -f "$temporary_directory/wacli" ] || [ -L "$temporary_directory/wacli" ]; then
  printf '%s\n' "Wrench WhatsApp runtime installer: release omitted a real wacli binary" >&2
  exit 1
fi
if [ "$(file_sha256 "$temporary_directory/wacli")" != "$binary_sha256" ]; then
  printf '%s\n' "Wrench WhatsApp runtime installer: extracted binary SHA-256 mismatch" >&2
  exit 1
fi

/usr/bin/codesign --verify --strict --verbose=2 "$temporary_directory/wacli"
/usr/bin/codesign -d --verbose=4 "$temporary_directory/wacli" 2>"$signature"
if ! /usr/bin/grep -Fqx "Identifier=org.openclaw.wacli" "$signature" \
  || ! /usr/bin/grep -Fqx "TeamIdentifier=FWJYW4S8P8" "$signature"; then
  printf '%s\n' "Wrench WhatsApp runtime installer: Developer ID identity did not match the reviewed release" >&2
  exit 1
fi

if [ ! -d "$state_home/tools" ] || [ ! -d "$state_home/tools/wacli" ] || [ ! -d "$target_directory" ] \
  || [ -L "$state_home/tools" ] || [ -L "$state_home/tools/wacli" ] || [ -L "$target_directory" ]; then
  printf '%s\n' "Wrench WhatsApp runtime installer: refusing symbolic-link installation directory" >&2
  exit 1
fi
temporary_target=$target_directory/.wacli-install.$$
if [ -e "$temporary_target" ] || [ -L "$temporary_target" ]; then
  printf '%s\n' "Wrench WhatsApp runtime installer: temporary publication target already exists" >&2
  exit 1
fi
/bin/cp -- "$temporary_directory/wacli" "$temporary_target"
chmod 0700 "$temporary_target"
if [ "$(file_sha256 "$temporary_target")" != "$binary_sha256" ]; then
  /bin/rm -f -- "$temporary_target"
  printf '%s\n' "Wrench WhatsApp runtime installer: staged binary changed before publication" >&2
  exit 1
fi
/bin/mv -- "$temporary_target" "$target"
temporary_target=

printf '%s\n' "Installed pinned WhatsApp protocol runtime $version at $target"
