# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.1

### Changed

The preview flag is gone. It was there because the container integration had only ever run
against the daemon on the machine it was written on, and that is no longer true: CI now
starts a real container on the Linux runner and asserts the extension attributes the
published port to it, and separately proves the daemon is reachable over each platform's
own transport, which is the only coverage the Windows named pipe has ever had.

### Internal

The `/proc` scanner was verified against a real Linux kernel for the first time, inside a
container. Every part of it that had only been exercised with a fake file system, the
`/proc/net/tcp` hex decoding, the inode to pid mapping through `/proc/*/fd`, the clock tick
arithmetic in `/proc/<pid>/stat`, and the `exe` and `cwd` links, returned the right answer.

## Unreleased

Planned:

- Probe open ports over HTTP so they can be labelled by whatever answers.
- Find dev servers still running from projects you closed days ago.

## 0.2.0

### Added

Container awareness. Ports published by Docker are shown as the container that publishes
them, with its image and uptime, instead of several identical rows of the daemon process.
Ownership uses the Compose project directory, so a container started by a compose file in
one of your open folders is recognised as yours by the same containment rule that applies
to a process working directory.

Container rows offer **Stop Container** rather than terminate. The process behind them is
the Docker daemon, which holds every other published port, so signalling it is refused.
Stopping a container is reversible and the confirmation says so instead of borrowing the
irreversible warning used for processes.

Only a local socket or named pipe is used, and a remote `DOCKER_HOST` is refused. The
extension promises it makes no network requests, and a remote daemon does not own this
machine's ports.

The daemon is found the way the CLI finds it: `DOCKER_HOST`, then the active docker
context, then the socket locations used by Docker Desktop, rootless Docker, Docker Desktop
for Linux, Colima, OrbStack, Rancher Desktop and Podman. Each candidate must answer a real
request before it is used, because a socket file left behind by a stopped daemon is
indistinguishable from a live one by any cheaper test.

### Fixed

Ports published by a container used to be labelled FOREIGN on the strength of the Docker
daemon's own working directory, which says nothing about the container. The tooltip on a
container row described the daemon for the same reason.

The port conflict notification could still offer to terminate the Docker daemon, which
holds every published port on the machine. It now names the container and offers to stop
it. The rule that decides whether a container belongs to a row lives in one place, so the
tree, the palette and the notification cannot disagree about it again.

A process record with a pid but no name, which Windows produces for a process owned by
another account and Linux produces when `/proc` is unreadable, was read as evidence that
Docker was not the holder. Paused and restarting containers were treated as having
released their ports. Two containers sharing a host port on different addresses were
resolved by array order. Compose metadata was discarded entirely unless the service label
was present, which loses the project directory that ownership depends on.

### Notes

The container work was reviewed adversarially before release, the same way 0.1.0 was, and
six defects came out of it. The port conflict notification, which is the path users reach
most often, could still offer to terminate the Docker daemon and take every container down
with it. A process record carrying a pid but no name, which Windows produces for a process
owned by another account, was read as proof that Docker was not the holder. Endpoint
selection took the first path that was a socket file, so a socket left behind by a stopped
daemon permanently shadowed a live one. `DOCKER_HOST=unix://` produced an empty path, and
Node treats a falsy socket path as absent and dials `localhost:80`, which would have been a
real network request from an extension that promises none.

All of them are fixed, each with a regression test, and the layer they were found in went
from no tests to being covered against a real socket.

## 0.1.1

### Fixed

Ownership detection on Windows. A command line carries whichever slash the shell that
launched the process used, so `node C:/Users/me/app/server.js` never matched a workspace
folder that arrived as `C:\Users\me\app`. Both sides are normalised before comparing now,
which means a process started from your project is recognised as yours rather than
falling back to "owner unknown".

`.DS_Store` was being packaged into the extension. vsce applies every negation rule after
all ignore rules, wherever they appear in `.vscodeignore`, so `!media/**` was quietly
re-including the files Finder leaves in that folder.

### Changed

The readme now leads with a header block and a screenshot sized to fit, rather than a
646 pixel image that pushed the explanation below the fold on the marketplace listing.

### Internal

Unit tests built their fixtures from POSIX path literals, which resolve to a
drive-prefixed path on Windows while the command line in the same assertion kept its
forward slashes. That was the only job failing in CI on that platform, and it was hiding
the ownership bug above.

## 0.1.0

First release.

### Added

Port listing on macOS, Linux and Windows, with process name, PID, executable path, command line, owning user, working directory and start time. macOS reads `lsof` field output and enriches it with `ps` and an `lsof -d cwd` probe. Linux reads `/proc/net/tcp` and `/proc/*/fd` with no external binary, falling back to `ss`. Windows goes through `Get-NetTCPConnection` and `Win32_Process`.

A sidebar view that keeps the ports this workspace expects separate from everything else on the machine, and labels each one as belonging to this workspace, to something else, or unknown.

Port inference from `package.json` scripts and local `.env` files, with every expectation traceable back to the exact file and key it came from.

`EADDRINUSE` detection in terminal output through the shell integration API, and in debug console output. The notification is only raised once a scan confirms a process really is holding that port.

Termination that re-identifies its target before every signal, refuses editor and OS critical processes outright, asks twice for shared infrastructure, tries a graceful stop before offering to force, and writes an audit trail.

Status bar summary, per workspace ignored ports, and a setting for every feature.

### Security

No telemetry and no network requests. Log output passes through a redaction filter that strips credentials out of connection strings, `--token=` style arguments and `Bearer` headers. Terminal text that triggers a conflict notification is never logged.

Restricted Mode is honoured: no workspace file is read until the folder is trusted, and conflict notifications drop the terminate action, since the terminal output driving them comes from a repository you have not trusted.

Child processes are spawned without a shell, and privileged tools are invoked by absolute path.

### Notes

The extension was reviewed adversarially before release and several things changed as a result. The terminate flow originally verified its target once, at the start, which left the entire lifetime of a confirmation dialog open as a PID reuse window. A forced refresh used to join a scan that was already running, so "always work from a fresh scan" was not true. A failed scan was published with a fresh timestamp, which made stale data look current. The process name block lists were written against names that no platform actually emits, so `Code Helper (Plugin)` on macOS and kernel truncated names like `systemd-resolve` on Linux were slipping through. Ownership inferred from a command line could be satisfied by a sibling directory sharing a prefix, and that was enough to skip a confirmation.

All of those are fixed, and each has a regression test.
