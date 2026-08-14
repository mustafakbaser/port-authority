# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead:

**[Report a vulnerability](https://github.com/mustafakbaser/port-authority/security/advisories/new)**

I will acknowledge within a few days and keep you updated while it is being worked on. If you would rather not use GitHub, email works too.

## What counts as a vulnerability here

This extension terminates operating system processes and reads files that routinely contain credentials, so the interesting classes are:

- Anything that causes a process to be signalled without the user confirming it, or that gets past `evaluateKill`'s refusals
- Anything that causes the wrong process to be terminated, for example by defeating the PID plus start time re-identification
- A credential from a `.env` file, a process command line or terminal output reaching the output channel, a notification, the clipboard or anywhere else it should not
- Command injection through a process name, a file path, a setting value or anything else that reaches a spawned command
- Anything a repository can trigger in an untrusted workspace that it should not be able to

## Design constraints

These are enforced in code rather than by convention, and a regression in any of them is a bug worth reporting:

- No child process is spawned through a shell. Privileged tools are invoked by absolute path rather than resolved through `PATH`.
- The Windows probe is passed as a base64 encoded command with no string interpolation in it.
- Everything written to the log passes through a redaction filter.
- No telemetry and no network requests. The only outbound action is `Open in Browser`, which the user triggers.
- In an untrusted workspace, no workspace file is read and port conflict notifications offer no destructive action.

## Supported versions

The latest published version is the supported one. This is a small project and I do not backport fixes.
