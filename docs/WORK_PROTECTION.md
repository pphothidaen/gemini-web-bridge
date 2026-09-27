# Protecting Uncommitted Work

> **Incident:** 2026-09-27. A `git reset` discarded a concurrent agent's
> uncommitted edits to four files. No commit, no stash, no branch — unrecoverable.

## The root cause

Not "someone forgot to commit". The repo had three guards against a *bad commit*
(secret scanning, `KAN-` ticket enforcement, and CI) and **zero** against
*destroying work that never became a commit*. The most expensive mistake available
had no protection at all; the cheapest had three.

That inversion is the actual bug, and it is why "just commit more often" is not
the fix — an agent blocked mid-task, or one whose output another agent reverted,
still loses everything.

## What git can and cannot enforce

This was verified empirically, not assumed:

| Attempt | Result |
|---|---|
| `pre-reset` / `pre-checkout` hook | **does not exist in git** |
| `git config alias.reset '!f()'` | ignored — built-ins cannot be shadowed |
| `post-checkout` hook | fires, but only *after* the loss |
| `post-merge` hook | same limitation |

So destructive loss is **not hook-interceptable**. The design follows from that:

- **`scripts/safe-git.sh`** — the enforcement point. Wraps the operations that
  actually destroy work and refuses them when the tree is dirty.
- **`.githooks/post-checkout`** — the passive half. Silent by default (a clean
  tree after a checkout is normal, so warning there would cry wolf on every
  branch switch). Set `HERMES_POST_HOOK_VERBOSE=1` to get the diagnostic.

## Using it

```bash
scripts/safe-git.sh reset --hard origin/main   # refused if the tree is dirty
scripts/safe-git.sh reset --hard origin/main --force
scripts/safe-git.sh clean -fd                  # refused if untracked files exist
scripts/safe-git.sh stash drop                # refused; stashes are often the only copy
scripts/safe-git.sh status                    # pass-through
```

When refused, you are told how to keep the work instead:

```bash
git stash push -u -m "wip before reset"
git switch -c scratch/wip && git add -A && git commit -m "wip"
```

## Rules for agents working in this repo

1. **Do not run bare `git reset --hard` or `git clean -fd`.** Use
   `scripts/safe-git.sh`. A `reset --hard` issued by one agent destroys another
   agent's in-flight work with no trace — reflog only records commits.
2. **Commit or stash before handing off.** Uncommitted work is invisible to
   reflog, `git stash list`, and `git fsck`.
3. **Never revert another agent's uncommitted edits** to "clean up". Ask, or use
   a worktree.
4. **Prefer a dedicated worktree** for parallel work:
   `git worktree add ../repo-<name> <branch>` — it isolates the working tree so
   one agent's `reset` cannot touch another's files at all.
