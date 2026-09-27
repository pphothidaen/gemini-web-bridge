#!/usr/bin/env bash
# safe-git.sh — refuse to destroy uncommitted work.
#
# The problem this solves
# -----------------------
# On 2026-09-27 a `git reset` silently discarded a concurrent agent's uncommitted
# edits to four files. Nothing was recoverable: no commit, no stash, no branch.
# The commit-msg and pre-commit hooks would not have helped, because they run at
# the END of the pipeline — the work was gone before any hook could see it.
#
# Git provides no pre-reset or pre-checkout hook, so destructive commands cannot
# be intercepted the way commits can. This wrapper is the enforcement point for
# the operations that actually lose work:
#
#   safe-git.sh reset --hard <ref>    refuses if the tree is dirty, unless forced
#   safe-git.sh checkout <ref>        warns on a dirty tree, preserves nothing silently
#   safe-git.sh clean -fd             refuses to delete untracked files unconfirmed
#   safe-git.sh stash drop            refuses to drop a stash unconfirmed
#   safe-git.sh status                plain git status (pass-through)
#
# Usage:
#   scripts/safe-git.sh reset --hard origin/main     # blocked if dirty
#   scripts/safe-git.sh reset --hard origin/main --force
#   scripts/safe-git.sh --help
#
# Exit codes: 0 ran, 1 refused (dirty/unsafe), 2 usage error.

set -uo pipefail

FORCE=0
args=()

while (( $# )); do
  case "$1" in
    --force|-f) FORCE=1; shift ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    --) shift; args+=("$@"); break ;;
    *) args+=("$1"); shift ;;
  esac
done

if (( ${#args[@]} == 0 )); then
  echo "usage: safe-git.sh {reset|checkout|clean|stash|status|...} [args]" >&2
  exit 2
fi

cmd="${args[0]}"
rest=("${args[@]:1}")

# ── dirty-tree detection ────────────────────────────────────────────────
# Tracked modifications (staged or not) and untracked-but-unignored files all
# count. `git status --porcelain` is used rather than `git diff` because it also
# catches untracked files, which `git reset` keeps but `git clean` destroys.
dirty_files() {
  git status --porcelain 2>/dev/null | grep -q .
}

dirty_summary() {
  local n
  n="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  echo "$n"
}

warn_dirty() {
  local action="$1"
  # Drop a leading "--hard" from the suggested re-run: the caller already has to
  # type it, and echoing it twice reads as a typo and invites a wrong command.
  local hint="${action#--hard }"
  cat >&2 <<EOF

⚠️  REFUSING to $action

   This working tree has $(dirty_summary) uncommitted change(s):

$(git status --porcelain | head -20 | sed 's/^/     /')

   Uncommitted work that is discarded this way is generally NOT recoverable —
   reflog only tracks commits, and there is no commit yet.

   To proceed anyway (destroying the above), re-run with --force:
     scripts/safe-git.sh $hint --force

   To save it first instead:
     git stash push -u -m "wip before $hint"
   or commit it on a scratch branch:
     git switch -c scratch/wip && git add -A && git commit -m "wip"

EOF
}

case "$cmd" in
  reset)
    # Only --hard destroys tracked work. A soft/mixed reset is safe.
    hard=0
    for a in "${rest[@]}"; do [[ "$a" == "--hard" ]] && hard=1; done
    if (( hard )) && dirty_files && (( ! FORCE )); then
      warn_dirty "reset ${rest[*]}"
      exit 1
    fi
    exec git reset "${rest[@]}"
    ;;

  clean)
    if dirty_files && (( ! FORCE )); then
      warn_dirty "clean ${rest[*]}"
      exit 1
    fi
    exec git clean "${rest[@]}"
    ;;

  checkout|switch)
    # A checkout with a dirty tree keeps changes if they do not conflict, and
    # git refuses loudly if they do. It does not silently discard — so this
    # warns rather than blocks.
    if dirty_files && (( ! FORCE )); then
      cat >&2 <<EOF

⚠️  ${cmd} with an uncommitted working tree ($(dirty_summary) change(s))

   git will keep these if they do not conflict with the target, and refuse
   outright if they do. This is informational.

EOF
    fi
    exec git "$cmd" "${rest[@]}"
    ;;

  stash)
    if [[ "${rest[0]:-}" == "drop" || "${rest[0]:-}" == "clear" ]] && (( ! FORCE )); then
      cat >&2 <<EOF

⚠️  REFUSING to ${rest[0]} without --force

   Stashes are frequently the ONLY copy of work that was never committed.
   List them first:  git stash list
   Inspect one:       git stash show -p 'stash@{0}'

   To proceed anyway:  scripts/safe-git.sh ${cmd} ${rest[*]} --force

EOF
      exit 1
    fi
    exec git stash "${rest[@]}"
    ;;

  status|log|diff|show)
    exec git "$cmd" "${rest[@]}"
    ;;

  *)
    # Unknown subcommand: pass through to git untouched rather than guess.
    exec git "$cmd" "${rest[@]}"
    ;;
esac
