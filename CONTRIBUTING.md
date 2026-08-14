# Contributing

Thanks for taking a look. This is a small extension maintained by one person, so the most useful thing you can do is keep changes focused and easy to review.

## Getting set up

```bash
git clone https://github.com/mustafakbaser/port-authority.git
cd port-authority
npm install
npm run check
```

`npm run watch` starts the esbuild watcher. Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

Node 20 or newer. The unit tests use the built in test runner, so there is no test framework to learn.

## How the code is laid out

There is one architectural rule and everything else follows from it:

**`src/core` must never import `vscode`.**

The parsers, the port inference rules, the ownership logic and the kill guard are all plain TypeScript modules in there. They take their side effects as injected functions, which is why they can be unit tested against recorded output from real machines instead of needing an editor. A lint rule enforces the boundary, so you will find out quickly if you cross it.

```
src/core     domain logic, no editor API, fully unit tested
src/node     the two real side effects: running a command, reading the file system
src/vscode   the adapter layer that talks to the editor
```

If you are adding something and it feels awkward to test, that is usually a sign the logic belongs in `core` and only the wiring belongs in `vscode`.

## Things that must not get weaker

This extension terminates processes, so a few properties are not up for negotiation in a pull request:

- The target is re-identified immediately before every signal, comparing PID and start time. A confirmation dialog can stay open indefinitely and PIDs get recycled.
- `evaluateKill` can refuse, and no setting overrides a refusal.
- Force killing is a separate decision made after a graceful attempt.
- Nothing that could carry a credential goes into the log. `.env` values and process command lines are shown in the UI where the user asked for them, and never written to the output channel.
- No telemetry, no network requests.

If a change needs to touch one of these, say so explicitly in the pull request and explain why. It is not a blocker, it is just something that deserves a conversation rather than a quiet diff.

## The two most likely contributions

### Adding a port inference rule

If your dev server declares its port in a way Port Authority misses, the rules live in `src/core/workspace/expectations.ts`.

Before adding one, work out whether it can produce a false positive. A missed port is a minor annoyance. An invented one puts a permanently red row in someone's sidebar, and that is what makes people turn the feature off. `docker run -p 8080:80` is the canonical example: it looks exactly like a port flag and is not one.

Add both kinds of test to `src/test/unit/expectations.test.ts`: one that your new pattern matches, and one nearby shape that it must not.

### Adding an EADDRINUSE pattern

Runtime specific patterns live in `src/core/terminal/eaddrinuse.ts`. A pattern is only useful if a port number can be extracted from it, so messages like Django's "That port is already in use" are deliberately left out.

There is a false positive corpus in `src/test/unit/eaddrinuse.test.ts` and it is the more important half of that file. It contains real lines that used to match and should not, including a timestamp that was being read as port 30 and a documentation URL that was being read as port 8443. Add your new true positive, then think about what nearby text your pattern would also catch and add that to the corpus too.

## Tests

```bash
npm run test:unit          # fast, no editor needed
npm run test:integration   # downloads VS Code and runs against a real instance
npm run check              # lint, typecheck, unit tests
```

Unit tests cover `src/core`. Integration tests cover activation, contributions and a real scan against a socket the test opens itself.

Platform specific code paths are the easy thing to break. The parsers are all tested against recorded output, so if you are changing one, paste the real output from your machine into the fixture rather than writing what you think the format looks like. The `lsof` field format in particular is not what most people assume.

CI runs the whole thing on Linux, macOS and Windows.

## Reporting a bug

The useful details for this extension are:

- Operating system and version, and whether you are in a devcontainer, WSL or over Remote SSH
- VS Code version
- What the *Port Authority* output channel says. Set `Port Authority` to `Debug` level in the Output panel, reproduce, and paste the log. It never contains credentials.
- For a wrong or missing port: the output of `lsof -nP -iTCP -sTCP:LISTEN` on macOS, `ss -ltnp` on Linux, or `Get-NetTCPConnection -State Listen` on Windows

For anything involving process termination going wrong, please include the exact confirmation dialog you saw.

## Commit messages

This repository follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>): <subject in the imperative mood>

<optional body explaining why, not what>

<optional footer, e.g. Closes #12 or BREAKING CHANGE: ...>
```

Types in use here:

| Type | When |
|---|---|
| `feat` | New behaviour a user can see |
| `fix` | A defect in shipped behaviour |
| `docs` | Readme, contributing guide, changelog, code comments |
| `test` | Adding or correcting tests only |
| `refactor` | Restructuring with no behaviour change |
| `perf` | A measurable performance change |
| `build` | Bundling, packaging, tsconfig, dependencies |
| `ci` | Workflows and automation |
| `chore` | Anything else that touches no shipped behaviour |

Useful scopes: `scanner`, `guard`, `terminate`, `inference`, `eaddrinuse`, `tree`, `config`, `deps`.

```
feat(eaddrinuse): detect the nginx bind failure message
fix(guard): match macOS helper names with a parenthesised suffix
test(inference): add a false positive case for docker run -p
```

Keep the subject under about 72 characters, in the imperative mood ("add nginx bind pattern", not "added" or "adds"), and with no trailing full stop. The body is for explaining why the change was needed; the diff already shows what changed.

A commit template is included. Turn it on once per clone:

```bash
git config commit.template .gitmessage
```

CI checks the subject line of every commit in a pull request against this format.

## Pull requests

Small and focused is better than complete. If you are planning something large, open an issue first so we can agree on the shape before you spend time on it.

Please run `npm run check` before pushing.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
