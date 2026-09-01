# Security

## Reporting a vulnerability

Report privately through [GitHub's advisory form](https://github.com/me-shaon/trackway/security/advisories/new). Please do not open a public issue for anything exploitable.

Trackway is maintained by one person, so treat any timeline as best effort rather than a commitment. You will get an acknowledgement, and if a report is valid you will be credited in the advisory unless you would rather not be.

Include the version (`trackway --version`), the agent whose sessions were involved, and the smallest reproduction you can manage. Please do not paste real credentials into a report, even a private one: describe the shape instead.

## Supported versions

Trackway is pre-1.0. Fixes go into the current release, and there are no backports. Upgrade with `npm install -g trackway@latest`.

## What Trackway touches

Worth knowing before deciding what counts as a vulnerability.

- **It reads your agent's session files.** Everything you typed and everything the agent read, including any file it opened.
- **It writes records into your repository.** `.trackway/records/` is tracked by git, so records are committed and pushed like anything else.
- **It runs your coding agent as a subprocess.** Distillation shells out to `claude`, `codex` or `opencode` using the credentials already on the machine. Trackway never asks for an API key and never sends your sessions anywhere itself.
- **It serves a local explorer.** `trackway graph` binds to `127.0.0.1` and is not reachable from the network.
- **It serves records over MCP.** Read-only. The server exposes five tools (`memory_search`, `memory_get`, `memory_context`, `memory_rejected`, `memory_recent`) and none of them write, edit or delete anything.

## The redaction pass is best effort

This is the part most likely to bite you, so it is stated plainly.

Everything read out of a session goes through a redaction pass before it becomes an event. That pass knows eleven credential shapes (Anthropic, OpenAI, GitHub, Slack, Google, AWS, Stripe, private key blocks, JWTs, bearer tokens, and credentials embedded in URLs) plus an assignment heuristic that looks for secret-ish names such as `password`, `token` or `apikey`.

The patterns are deliberately narrow. A loose pattern that redacts ordinary prose produces records nobody can read, which is its own kind of failure.

**So a credential in a shape the pass does not know can reach a git-tracked file.** Treat `.trackway/records/` the way you treat any other file you are about to commit, and read the diff.

If something does land in a record:

```bash
trackway forget <record-id>          # one record
trackway forget <session-id> -s      # everything from that session
```

Then rewrite the history if it was already committed, and rotate the credential. Assume anything pushed is public.

A credential shape the pass misses is a bug worth reporting, and a good one: send the shape, not the secret.

## Out of scope

- Secrets that were already in your repository or your shell history. Trackway reads sessions; it does not create the exposure.
- The security of the coding agents themselves, or of the models they call.
- Anything requiring an attacker who already has read access to your machine. Trackway's store, cache and records are all readable by whoever can read your home directory, and it is not designed to defend against that.
- Binding the explorer to a public interface on purpose. `--port` changes the port, not the interface, and the loopback binding is covered by a test.
