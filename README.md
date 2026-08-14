# Port Authority

Something is already listening on port 3000. Port Authority tells you what it is, where it was started from, and how long it has been running, then lets you stop it without leaving the editor.

![The Port Authority view in the sidebar](https://raw.githubusercontent.com/mustafakbaser/port-authority/main/media/screenshot.png)

## Why I wrote it

`EADDRINUSE` is not a hard problem. It is an annoying one. You know how it goes: the server fails to start, you switch to a terminal, run `lsof -i :3000`, squint at a PID, and try to remember whether that was yesterday's dev server or something Docker started. Thirty seconds each time, several times a week.

There are already a dozen extensions that kill a port. They all solve the last five seconds of that problem. The part that actually costs time is the middle bit, working out whose process it is and whether you can safely stop it, and none of them help with that.

So this one is built around identification. Killing the process is the easy part and comes last.

## What it does

### It knows which ports your project expects

Port Authority reads the `scripts` in your `package.json` and your local `.env` files, and works out which ports this workspace is supposed to be using. Those get their own section at the top of the view:

```
This workspace (2/3 up)
  ● 3000  dev (next)      node (91204) · ~/proj/web · 2m ago · this workspace
  ⚠ 5432  DATABASE_URL    postgres (884) · ~/other-proj · FOREIGN
  ○ 6379  REDIS_PORT      not running
```

That middle row is the interesting one. Port 5432 is up, but it belongs to a different project you left running last week. Without that distinction, "the port is in use" and "the port is in use by the right thing" look identical.

Every expectation is traceable. Hover a row and it will tell you it came from `scripts.dev` in `apps/web/package.json`, not just that it exists.

The rules for reading those files are narrow on purpose. `-p` counts as a port flag for `next`, `vite`, `serve` and about thirty other dev servers, and not for `mkdir -p 1234`. A `DATABASE_URL` pointing at `localhost` counts, one pointing at your production host does not. `.env.example` and `.env.production` are skipped entirely. I would rather miss a port than invent one, because a workspace section full of things that will never be running is worse than no workspace section.

### It comes to you when a port conflict happens

When `EADDRINUSE` shows up in a terminal or in the debug console, you get a notification that already knows the answer:

> Port 3000 is held by node (PID 91204), started 6h ago, in `~/old-project`.
> **[Terminate…] [Show Details] [Ignore This Port]**

A match in terminal text is only a hint, so the notification is only raised after a real scan confirms that a process is genuinely holding that port. Grepping your logs for `EADDRINUSE` will not produce a popup.

The patterns cover Node, Go, nginx, Kestrel, Puma, Docker, Vite and Spring Boot. Messages that name no port, like Django's "That port is already in use", are ignored, because there is nothing useful to offer without one.

### Stopping a process is treated as dangerous

It is a one way operation, so:

The target is re-identified immediately before every signal. Not once at the start. A confirmation dialog can sit on screen for an hour, and the PID that was your dev server when it opened can belong to something else entirely by the time you answer. Identity here means PID *and* start time, so a recycled PID reads as a different process and the whole thing stops.

Some processes are refused outright and no setting changes that: VS Code itself and its parent processes, PID 1, the Windows system PIDs, and the per platform list of OS critical processes. Shared infrastructure like `dockerd` or `postgres`, processes owned by another user, and processes whose name could not be read all require a second confirmation.

`SIGTERM` first, always. Force killing is a separate decision you make afterwards, and the dialog spells out what you lose by skipping the process's shutdown handlers.

"Port released" only appears after a rescan confirms nothing is listening. A process exiting does not always free the port, and I would rather say nothing than say something untrue.

Everything gets written to the *Port Authority* output channel, through a filter that strips credentials out of connection strings and token arguments.

## Installing

From the Marketplace, or:

```
code --install-extension mkbaser.port-authority
```

## Settings

Every feature can be switched off on its own.

| Setting | Default | |
|---|---|---|
| `portAuthority.autoRefresh.enabled` | `true` | Periodic rescans. Only while the view is open or the status bar item is on, and only while the window has focus. |
| `portAuthority.autoRefresh.intervalSeconds` | `10` | How often, while the view is visible. The status bar on its own never polls faster than every 30 seconds. |
| `portAuthority.showAllInterfaces` | `false` | Also list ports bound to a specific LAN address. |
| `portAuthority.portRange` | `[1, 65535]` | Restrict the listing to a range. |
| `portAuthority.ignorePorts` | `[]` | Ports that are never listed and never notified about. |
| `portAuthority.statusBar.enabled` | `true` | The `2/3` summary of expected ports. |
| `portAuthority.workspaceExpectations.enabled` | `true` | Read `package.json` and `.env` to infer expected ports. |
| `portAuthority.workspaceExpectations.additionalPorts` | `[]` | Extra ports, for example `[{ "port": 9229, "label": "debugger" }]`. |
| `portAuthority.eaddrinuse.enabled` | `true` | Watch terminal output for port conflicts. |
| `portAuthority.eaddrinuse.watchDebugConsole` | `true` | Watch debug session output too. |
| `portAuthority.eaddrinuse.cooldownSeconds` | `60` | Minimum gap before the same port notifies again. |
| `portAuthority.terminate.confirmation` | `"always"` | `"unexpectedOnly"` skips the dialog only for a normal risk process holding a port this workspace expects and provably owns. |
| `portAuthority.terminate.gracePeriodMs` | `3000` | How long to wait for a graceful exit before offering to force. |
| `portAuthority.protectedProcessNames` | `[]` | Names this extension must never terminate. |
| `portAuthority.scan.timeoutMs` | `5000` | Timeout for one scan. |

In a multi root workspace the safest value wins: if any folder asks for confirmation it becomes mandatory, the longest grace period applies, and protected names are combined.

## How ports are read

| Platform | Method |
|---|---|
| macOS | `lsof` for the sockets, `ps` and `lsof -d cwd` for the details |
| Linux | `/proc/net/tcp` and `/proc/*/fd`, falling back to `ss -ltnp` |
| Windows | `Get-NetTCPConnection` and `Win32_Process` through `powershell.exe` |

Linux uses `/proc` first rather than `ss` because minimal devcontainer images often ship neither `ss` nor `lsof`, and reading `/proc` spawns no child process at all.

Over Remote SSH, in WSL or in a devcontainer, the extension runs where your workspace is and shows that machine's ports, which is where your dev server actually listens. It does not run in the browser, since there is no process table there.

## Privacy

No telemetry. No network requests. The only outbound action anywhere in the extension is `Open in Browser`, and you have to click it.

`.env` files are read to find port numbers. Their values never leave the inference code, and nothing that could carry a credential is written to the log. In Restricted Mode no workspace file is read at all, and a port conflict notification offers no terminate button, because the terminal output driving it is controlled by the repository you have not trusted yet.

## What it does not do yet

- Container ports show up as the Docker backend process rather than the container that owns them. Mapping them properly is the main thing planned for 0.2.
- Nothing is probed over HTTP, so port 3000 is not labelled "Next.js dev server".
- Without elevation, macOS and Linux hide the details of processes you do not own. The port is still listed, with a row explaining why the owner is blank.
- Windows does not expose another process's working directory cheaply, so ownership there falls back to matching the workspace path inside the command line. That is shown as indirect evidence and is never enough to skip a confirmation.
- UDP is not listed. Every `EADDRINUSE` worth chasing is TCP.

## Development

```bash
npm install
npm run check      # lint, typecheck, unit tests
npm run watch      # then F5 to launch an Extension Development Host
npm test           # unit and integration tests
npm run package    # builds port-authority.vsix
```

`src/core` is plain TypeScript with no `vscode` import: the parsers, the port inference rules, the ownership logic and the kill guard all live there and are tested directly. `src/node` does the two side effects, running a command and reading the file system. `src/vscode` is the adapter. A lint rule keeps the boundary honest.

If you want to work on it, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
