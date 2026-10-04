# Claude Code mod for GitHub issues

A [Claude Code](https://claude.com/claude-code) mod that keeps a live count of
the open GitHub issues in whatever repo you are working in, colour-coded by
**issue type** and by **who they are assigned to**.

```
214 open issues                 [ Refresh ]
acme/widgets · updated 14:02

By type
████████████████████████████████████████████████
■ Task     38  18%
■ Bug      61  29%
■ Feature  70  33%
■ No type  45  21%

By person
████████████████████████████████████████████████
■ alice         52 ███████████████
■ bob           31 █████████
■ carol         12 ████
■ Unassigned   119 █████████████████████████████████
```

Types use GitHub's own colours (Bug red, Feature blue, Task yellow, and so on);
each person gets a colour of their own, and their bar is split by issue type.

## What you need

- **Claude Code 2.1.289 or later.** This is a mod built on Claude Code's
  function-hook plugin API, which is marked early access: a future Claude Code
  release may change it and break the mod.
- **The GitHub CLI, [`gh`](https://cli.github.com/), logged in** (`gh auth status`
  should say so). The mod asks `gh` for the issues, so it sees exactly the
  repos your `gh` login can see, private ones included, and needs no token of
  its own.

## Install

Inside Claude Code, run these **one at a time** (paste one, press Enter, then
the next; pasted together they arrive as a single command):

1. Add this repo as a plugin source:

   ```
   /plugin marketplace add https://github.com/no1cromo/claude-code-mod-for-github-issues
   ```

2. Install the mod from it:

   ```
   /plugin install repo-issues@repo-issues
   ```

3. Type `/issues`. If Claude Code does not know it yet, run `/reload-plugins`
   or start a new session.

If step 2 says `Plugin "repo-issues" not found in marketplace "repo-issues"`,
step 1 has not run yet.

The same two steps from a terminal, outside Claude Code:

```
claude plugin marketplace add https://github.com/no1cromo/claude-code-mod-for-github-issues
claude plugin install repo-issues@repo-issues
```

Or from a clone, for one session:

```
claude --plugin-dir /path/to/claude-code-mod-for-github-issues
```

## Use

- **`/issues`** opens the pane and fetches fresh numbers.
- In a GitHub repo, the pane also opens by itself at start when the terminal is
  wide enough to dock it (144 columns); it stays shut in folders that are not
  GitHub repos.
- It refreshes every 5 minutes; press **r** in the pane (or click Refresh) to
  refresh now. The status line shows the total too.

## How it counts

- **Type** is the issue's GitHub issue type. An issue without one counts as a
  Bug if it has a `bug` label, or a Feature if it has an `enhancement` label
  (GitHub's default labels); otherwise it is "No type". So the numbers can be
  higher than GitHub's own issue-type filter shows.
- **People**: an issue with two assignees counts once for each. The eight people
  with the most issues get a row and a colour; everyone else shares one
  "others" row.
- **Large repos**: the headline is always the true total, but the breakdown
  covers the 1,000 most recently updated open issues, so a repo with tens of
  thousands of issues still refreshes in seconds.
- **Forks**: `gh` picks the repo, which for a fork with an `upstream` remote is
  usually the upstream one. The pane shows which repo it counted.
- Pull requests are not counted.

## Limits

- github.com only (not GitHub Enterprise Server).
- Nothing leaves your machine except the `gh` calls to GitHub's API.

## Develop

```
claude plugin validate .
claude plugin test .
```

`hooks/register.tsx` fetches and draws the pane; `hooks/summary.ts` does the
counting and bar widths; `tests/` runs against a fake `gh`, so tests never call
GitHub.

## License

MIT
