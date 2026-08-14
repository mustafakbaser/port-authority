# Changelog

Notable changes, newest first. This project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

Planned for 0.2:

- Map published container ports to the Docker container that owns them, instead of showing the Docker backend process.
- Probe open ports over HTTP so they can be labelled by whatever answers.
- Find dev servers still running from projects you closed days ago.

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
