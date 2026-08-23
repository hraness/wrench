# Install and diagnose Wrench

Use this reference only when `wrench` is unavailable or `wrench doctor`
reports a dependency needed by the requested workflow.

## Install the CLI

Wrench requires Bun 1.3.14 or newer and supports macOS and Linux. Check both
commands before changing the machine:

```sh
command -v bun
command -v wrench
```

If Bun is missing, stop and direct the user to the official
[Bun installation guide](https://bun.sh/docs/installation). Do not switch
package managers or pipe an unreviewed installer into a shell.

When the user asked to install or use Wrench, install the current immutable
release and its reviewed bundled adapter manifests:

```sh
bun add --global github:hraness/wrench#v0.13.2
wrench adapter sync-bundled --json
wrench --help
wrench doctor --json
```

Do not clone the repository merely to run the CLI. Importing the SDK is a
separate project dependency and does not install a global command:

```sh
bun add github:hraness/wrench#v0.13.2
```

## Add only required optional tools

Treat `wrench doctor --json` as the capability report. Install a browser,
`yt-dlp`, FFmpeg, a local transcription runtime, a provider-specific helper,
or another operating-system dependency only when the requested route needs
it and the user has authorized that machine change. Re-run doctor after the
install. Do not weaken a provider or archive boundary when an optional tool is
absent.
