# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A working software developer who uses a coding agent daily and runs Trackway on their own machine, in their own repository. They are alone, in a terminal and a browser, mid-project. Not a team lead reviewing others, not a manager reading reports.

The moment they open it: they have hit code whose shape they do not remember choosing, or they are about to propose an approach and want to know whether it was already ruled out. Days to weeks after the decision, not years.

## Product Purpose

Coding agents write every session to disk. The reasoning behind a decision is in there, along with hundreds of other sessions, with no way to search it. Trackway reads those files and turns them into a small, git-tracked, searchable record of what was asked, what was considered, what was chosen, and why.

Success is a developer answering "why is this like this?" faster from the record than by scrolling a transcript or reading the code.

## Positioning

Two things a neighbouring tool could not truthfully copy.

It reads the session files agents already write, so capture needs no hook, no vendor cooperation, and works retroactively on history that already exists.

It preserves the options that were **not** taken, with the reason each was dropped and the condition that made the rejection valid at the time. Commit history records what was built. Nothing else records what was considered and discarded.

## Operating Context

Runs from a terminal in a git repository. The explorer opens on localhost with no account and no network. Records are markdown committed alongside the code they explain, and appear in the developer's own diffs and pull requests.

The developer switches to it from an editor or terminal, spends a short time, and leaves. It is consulted, not inhabited.

## Capabilities and Constraints

Reads sessions from Claude Code, Codex, and OpenCode. Distillation runs the developer's own agent headless, so there is no second API key.

Five record types: question, discovery, decision, action, outcome. Every record carries who decided, distinguishing an agent recommendation, a developer decision, a developer override, and an agent acting with no approval.

Records carry a significance: business, technical, direction, or working. The default view shows the first three. On a real session that is 18 of 101 records.

Decisions carry the options not taken, each with its own reason, copied verbatim from the option lists a session recorded.

Everything is local. No account, no hosted backend, no telemetry. Model reasoning is stripped and credentials are redacted before anything reaches disk; redaction is best-effort and documented as such.

Extraction quality is measured, not gated: precision 0.57, recall 0.68 on sessions of 15 to 260 events. Recall on long sessions is unmeasured.

## Brand Commitments

Name: **Trackway**. Positioning line: "why your code is the way it is."

The pitch leads with the question a reader already has in front of a line they
did not write, rather than with the rejected options. Most decisions the tool
records were proposed by the agent and approved in passing, so the reader is
usually not remembering a choice. They are finding out what was chosen for them.

Prose avoids em dashes and comma-stacked sentences, in the interface as well as the documentation.

## Evidence on Hand

Real records from the session that built the tool: 101 records, 12 decisions with their rejected options, 6 topics, one open question. The tool's own history is the demonstration material and no part of it is invented.
