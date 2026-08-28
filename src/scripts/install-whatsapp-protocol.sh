#!/bin/sh
set -eu

version=0.13.0
transport_version=wrench-private-v1
wacli_commit=1e15f646d23598ef5db2bdb4659ac39cc5188ad2
wacli_archive_sha256=0b6df982b3980f622df2c4aa38791a8918149d2d8fa096a3302cc9a9d3525c92
wacli_patch_sha256=ffa7fb2a6100bfff1a4cfed300fb0f854d0d3254058d8e33d87073ad0c0bac9f
whatsmeow_version=v0.0.0-20260716095330-85d99080dee8
whatsmeow_archive_sha256=5fcf5195593e4b3cec63ee9798e66369fa713fead6f55b3e8e717279fac02f9e
whatsmeow_patch_sha256=cbf6f0b72963b365ca4c81f86993cf8a77a7eec6ffcd973d13aa68fe7331fcdc
go_version=1.25.12
go_archive_sha256=fa2c88bbcf64bd3b2aef355f026cfec6d3a4a01c132f999c8f8c964eb767164f
binary_sha256=526eba2dce946afb6cefc852b9080245e0f03f79b5c0472879b17c145b24a667
wacli_source_url="https://codeload.github.com/openclaw/wacli/tar.gz/$wacli_commit"
whatsmeow_source_url="https://proxy.golang.org/go.mau.fi/whatsmeow/@v/$whatsmeow_version.zip"
go_source_url="https://go.dev/dl/go${go_version}.darwin-arm64.tar.gz"

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
source_root=$(CDPATH= cd -- "$script_directory/.." && pwd -P)
vendor_directory=$source_root/vendor/whatsapp-private-transport
state_home_resolver=$script_directory/resolve-state-home.ts
wacli_patch=$vendor_directory/wacli-${wacli_commit}-wrench-private.patch
whatsmeow_patch=$vendor_directory/whatsmeow-85d99080dee8-wrench-private.patch

fail() {
  printf '%s\n' "Wrench WhatsApp private transport installer: $1" >&2
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

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  fail "the reviewed source build currently supports macOS arm64 only"
fi
if ! command -v xcrun >/dev/null 2>&1 || ! /usr/bin/xcrun --find clang >/dev/null 2>&1; then
  fail "Apple Command Line Tools with clang are required"
fi
if ! /usr/bin/xcrun clang --version | /usr/bin/grep -Fq "Apple clang version 21.0.0 (clang-2100.1.1.101)"; then
  fail "this checked current-platform build requires Apple clang 21.0.0 (clang-2100.1.1.101)"
fi

require_regular_file "$wacli_patch" "$wacli_patch_sha256" "vendored Wacli patch"
require_regular_file "$whatsmeow_patch" "$whatsmeow_patch_sha256" "vendored Whatsmeow patch"
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
if [ ! -x "$bun_path" ] || [ "$($bun_path --version)" != "1.3.14" ]; then
  fail "Bun path must name an executable Bun 1.3.14"
fi

state_home=$($bun_path run --no-install "$state_home_resolver" "$version")
target_directory=$state_home/tools/wacli/$version/$transport_version
target=$target_directory/wacli
if [ -L "$target" ]; then
  fail "refusing symbolic-link target"
fi
if [ -e "$target" ]; then
  if [ ! -f "$target" ] || [ "$(file_sha256 "$target")" != "$binary_sha256" ]; then
    fail "existing private-transport target has unexpected contents"
  fi
  chmod 0700 "$target"
  printf '%s\n' "Pinned WhatsApp private transport is already installed at $target"
  exit 0
fi

umask 077
temporary_directory=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/wrench-wacli-private-install.XXXXXX")
cleanup() {
  if [ -n "${temporary_target:-}" ]; then
    case "$temporary_target" in
      "$target_directory"/.wacli-install.*) /bin/rm -f -- "$temporary_target" ;;
    esac
  fi
  case "$temporary_directory" in
    "${TMPDIR:-/tmp}"/wrench-wacli-private-install.*)
      /bin/chmod -R u+w "$temporary_directory" 2>/dev/null || true
      /bin/rm -rf -- "$temporary_directory"
      ;;
  esac
}
trap cleanup EXIT HUP INT TERM

wacli_archive=$temporary_directory/wacli.tar.gz
whatsmeow_archive=$temporary_directory/whatsmeow.zip
go_archive=$temporary_directory/go.tar.gz
/usr/bin/curl --fail --location --proto '=https' --tlsv1.2 --output "$wacli_archive" "$wacli_source_url"
/usr/bin/curl --fail --location --proto '=https' --tlsv1.2 --output "$whatsmeow_archive" "$whatsmeow_source_url"
/usr/bin/curl --fail --location --proto '=https' --tlsv1.2 --output "$go_archive" "$go_source_url"
require_regular_file "$wacli_archive" "$wacli_archive_sha256" "Wacli source archive"
require_regular_file "$whatsmeow_archive" "$whatsmeow_archive_sha256" "Whatsmeow source archive"
require_regular_file "$go_archive" "$go_archive_sha256" "Go toolchain archive"

wacli_source=$temporary_directory/wacli
built_binary=$temporary_directory/wacli-built
whatsmeow_extract=$temporary_directory/whatsmeow-extract
toolchain=$temporary_directory/toolchain
/bin/mkdir -- "$wacli_source" "$whatsmeow_extract" "$toolchain"
/usr/bin/tar -xzf "$wacli_archive" -C "$wacli_source" --strip-components=1
/usr/bin/unzip -q "$whatsmeow_archive" -d "$whatsmeow_extract"
/usr/bin/tar -xzf "$go_archive" -C "$toolchain"
go_bin=$toolchain/go/bin/go
whatsmeow_source=$whatsmeow_extract/go.mau.fi/whatsmeow@$whatsmeow_version
if [ ! -x "$go_bin" ] || [ "$($go_bin env GOVERSION)" != "go$go_version" ]; then
  fail "extracted Go toolchain version mismatch"
fi
if [ ! -f "$wacli_source/go.mod" ] || [ -L "$wacli_source/go.mod" ]; then
  fail "Wacli source archive omitted go.mod"
fi
if [ ! -f "$whatsmeow_source/go.mod" ] || [ -L "$whatsmeow_source/go.mod" ]; then
  fail "Whatsmeow source archive omitted go.mod"
fi

/usr/bin/git -C "$wacli_source" apply --check --whitespace=nowarn "$wacli_patch"
/usr/bin/git -C "$wacli_source" apply --whitespace=nowarn "$wacli_patch"
/bin/chmod -R u+w "$whatsmeow_source"
/usr/bin/git -C "$whatsmeow_source" apply --check "$whatsmeow_patch"
/usr/bin/git -C "$whatsmeow_source" apply "$whatsmeow_patch"
/bin/mv -- "$whatsmeow_source" "$wacli_source/third_party-whatsmeow"
/bin/cp -- "$wacli_source/go.mod" "$wacli_source/wrench.mod"
/bin/cp -- "$wacli_source/go.sum" "$wacli_source/wrench.sum"

(
  cd "$wacli_source"
  env GOTOOLCHAIN=local "$go_bin" mod edit -modfile=wrench.mod -replace=go.mau.fi/whatsmeow=./third_party-whatsmeow
  (
    cd third_party-whatsmeow
    env GOTOOLCHAIN=local GOFLAGS=-modcacherw GOMODCACHE="$temporary_directory/go-mod-cache" GOCACHE="$temporary_directory/go-build-cache" \
      "$go_bin" test . -run TestWrenchReceiveBarrier -count=1
  )
  env GOTOOLCHAIN=local GOFLAGS=-modcacherw GOMODCACHE="$temporary_directory/go-mod-cache" GOCACHE="$temporary_directory/go-build-cache" \
    "$go_bin" test -modfile=wrench.mod -tags wrench_private_transport ./cmd/wacli ./internal/app ./internal/wa -count=1
  env GOTOOLCHAIN=local GOFLAGS=-modcacherw GOMODCACHE="$temporary_directory/go-mod-cache" GOCACHE="$temporary_directory/go-build-cache" \
    CGO_ENABLED=1 CGO_CFLAGS=-Wno-error=missing-braces \
    "$go_bin" build -modfile=wrench.mod -trimpath -buildvcs=false \
      -tags 'sqlite_fts5 wrench_private_transport' -o "$built_binary" ./cmd/wacli
)

if [ ! -f "$built_binary" ] || [ -L "$built_binary" ]; then
  fail "checked build omitted a real wacli binary"
fi
if [ "$(file_sha256 "$built_binary")" != "$binary_sha256" ]; then
  fail "checked Wacli binary SHA-256 mismatch"
fi
if [ "$($built_binary version)" != "$version" ]; then
  fail "checked Wacli binary version mismatch"
fi
if ! "$built_binary" wrench-private --help >/dev/null; then
  fail "checked Wacli binary omitted the private transport command"
fi

if [ ! -d "$state_home/tools/wacli/$version" ] || [ -L "$state_home/tools/wacli/$version" ]; then
  fail "refusing unexpected installation parent"
fi
/bin/mkdir -m 0700 -- "$target_directory"
temporary_target=$target_directory/.wacli-install.$$
if [ -e "$temporary_target" ] || [ -L "$temporary_target" ]; then
  fail "temporary publication target already exists"
fi
/bin/cp -- "$built_binary" "$temporary_target"
chmod 0700 "$temporary_target"
if [ "$(file_sha256 "$temporary_target")" != "$binary_sha256" ]; then
  fail "staged binary changed before publication"
fi
/bin/mv -- "$temporary_target" "$target"
temporary_target=

printf '%s\n' "Installed pinned WhatsApp private transport $version at $target"
