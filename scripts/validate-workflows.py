"""Validate GitHub Actions workflows for the failures that hide themselves.

Motivation: a malformed workflow does not produce a red job. GitHub refuses
to load the file, the run lists ZERO jobs, and the only signal is a generic
"This run likely failed because of a workflow file issue" banner. There is
no step to click and nothing in the logs names the offending line, so the
cause has to be found by bisecting commits.

The check here is for the cause actually hit in this repo: the `secrets`
context is not available in a job-level `if:`. Referencing it makes GitHub
reject the entire workflow, so the run shows zero jobs rather than one
failed step. Move such a condition to the step level, where `secrets` is
available.

Deliberately NOT included: a rule about quote-leading lines in `run:`
blocks. That was the original suspect here, but it does not reproduce —
the known-good ci.yml at c481285 has nine such lines and every run on it
was green, and the genuinely broken file parsed cleanly under both PyYAML
and ruamel's YAML 1.2 loader. A rule that cannot be shown to fail on a
real defect is worse than no rule, so it was dropped rather than shipped.

Usage: python3 validate-workflows.py [file ...]
Exit 0 = all good, 1 = at least one problem found.
"""
import sys
import yaml

# Contexts that are not available in a job-level `if:`.
FORBIDDEN_IN_JOB_IF = ("secrets.", "inputs.", "vars.")


def check_job_level_if(job_name, expr, problems):
    text = str(expr)
    for ctx in FORBIDDEN_IN_JOB_IF:
        if ctx in text:
            problems.append(
                "job %r: job-level `if:` references %s — that context is not "
                "available there and GitHub rejects the whole workflow file "
                "(the run lists zero jobs, not a failed step). Move the check "
                "to a step-level `if:`, or expose it as a job `env:` and test "
                "that env var."
                % (job_name, ctx.rstrip("."))
            )
            return


def check(path):
    problems = []
    raw = open(path, encoding="utf-8").read()

    if "\t" in raw:
        problems.append("file contains a TAB character (illegal in YAML)")

    try:
        doc = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        return ["YAML does not parse: %s" % str(exc).splitlines()[0]]

    if not isinstance(doc, dict):
        return ["top level is not a mapping"]

    # `on:` is a YAML 1.1 boolean, so accept either spelling.
    if not ("on" in doc or True in doc):
        problems.append("no `on:` trigger block")

    for name, job in (doc.get("jobs") or {}).items():
        if not isinstance(job, dict):
            problems.append("job %r is not a mapping" % name)
            continue
        if "if" in job:
            check_job_level_if(name, job["if"], problems)
    return problems


def main(argv):
    files = argv[1:] or [
        ".github/workflows/ci.yml",
        ".github/workflows/cd.yml",
        ".github/workflows/token-rotation.yml",
    ]
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
