"""Validate GitHub Actions workflows for errors that make the file unloadable.

Why this exists: a workflow GitHub cannot parse does not produce a red job.
The run lists ZERO jobs and shows only a generic "This run likely failed
because of a workflow file issue" banner. There is no step to click and
nothing in the logs names the offending line, so the cause has to be found
by bisecting commits and pushing guesses.

The check here is for the cause actually hit in this repo. The `secrets`
context is not available in ANY `if:` — not job-level, not step-level.
Referencing it makes GitHub report

    Unrecognized named-value: 'secrets'

and refuse to load the file. The secret must be exposed through `env:`
and the condition must test that env var instead.

Deliberately dependency-free: this runs as CI job 0, and the runner's
Python has no PyYAML. A validator that cannot run where it is needed is
useless, so the narrow line-oriented scan below replaces yaml.safe_load.
The trade-off is that it checks text, not a parsed tree — acceptable
because the rule is lexical: `secrets.` inside an `if:` is illegal
regardless of how the surrounding YAML nests.

Not included: the quote-leading-line rule I first wrote. It did not
reproduce — the file that actually broke parsed cleanly, and the known-good
ci.yml at c481285 has nine such lines with every run green. A rule that
cannot be shown to catch a real defect only creates noise.

Usage: python3 validate-workflows.py [file ...]
Exit 0 = all good, 1 = at least one problem found.
"""
import sys

DEFAULT_FILES = [
    ".github/workflows/ci.yml",
    ".github/workflows/cd.yml",
    ".github/workflows/token-rotation.yml",
    ".github/workflows/keepalive-probe.yml",
]

# Contexts that may not appear inside an `if:` condition.
#
# `secrets` only. `inputs` and `vars` ARE legal in conditions — cd.yml has
# used `inputs.skip_doppler` in two `if:`s all along and every deploy has
# run, which is the evidence that keeps `inputs` off this list. Listing it
# would have failed a workflow that demonstrably works.
FORBIDDEN_IN_IF = ("secrets.",)


def indent_of(line):
    return len(line) - len(line.lstrip(" "))


def check(path):
    problems = []
    try:
        raw = open(path, encoding="utf-8").read()
    except OSError as exc:
        return ["cannot read: %s" % exc]

    if "\t" in raw:
        problems.append("file contains a TAB character (illegal in YAML)")

    lines = raw.split("\n")
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue

        # A step's keys are written as list items, so the line reads `- if:`
        # rather than `if:`. Both forms are conditions and both are illegal
        # with `secrets`, so strip an optional leading dash before matching.
        body = stripped[1:].strip() if stripped.startswith("- ") else stripped
        if body.startswith("if:"):
            cond = body[3:].strip()
            # Only a folded/multi-line scalar (`>-`, `|`, `>`) continues onto
            # following lines. A plain scalar is complete on its own, and
            # scanning past it would read the step's own `env:`/`run:` keys
            # and flag their (entirely legal) `secrets.` references.
            if cond in (">-", ">", "|", "|-"):
                base = indent_of(line)
                j = i
                while j < len(lines):
                    nxt = lines[j].strip()
                    if not nxt or nxt.startswith("#"):
                        j += 1
                        continue
                    if indent_of(lines[j]) <= base:
                        break
                    cond += " " + nxt
                    j += 1
            for ctx in FORBIDDEN_IN_IF:
                if ctx in cond:
                    problems.append(
                        "line %d: `if:` references %s — that context is not "
                        "available in any condition and GitHub rejects the "
                        "whole file (\"Unrecognized named-value\"), so the run "
                        "lists zero jobs. Expose it as `env:` and test "
                        "env.VAR instead." % (i, ctx.rstrip("."))
                    )
                    break
    return problems


def main(argv):
    files = argv[1:] or DEFAULT_FILES
    failed = False
    for path in files:
        problems = check(path)
        if problems:
            failed = True
            print("FAIL %s" % path)
            for p in problems:
                print("     - %s" % p)
        else:
            print("OK   %s" % path)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
