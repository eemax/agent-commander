# Scripts in a skill

A script belongs in `scripts/` when you'd otherwise retype the same logic each time the skill
runs, or when a sequence is fragile. A tested script is more reliable than a long command
in the body. Agents run scripts without a terminal and read their output to decide what's next.

## Rules

- **Never prompt.** Nothing can type an answer, so a prompt hangs until the timeout. Take
  input from flags, environment variables or stdin. A missing required input is an error that
  names it: `Error: --env is required (development, staging or production).`
- **`--help`** is how you'll learn the interface next time: one line on what it does, the
  flags, an example or two, the exit codes.
- **Errors that say what to do:** what went wrong, what was expected, what to try
  (`Error: --format must be json or csv, got "xml"`). Never just `invalid input`.
- **Data on stdout, everything else on stderr.** Prefer JSON or TSV for data a later step
  reads; plain sentences for results a person reads.
- **Bounded output.** Long output gets cut off (head and tail kept). Print a summary by
  default, with `--limit`/`--offset` or `--output FILE` for the rest.
- **Safe to run again:** "create if missing" rather than "fail if it exists". Destructive or
  costly steps get `--dry-run`, and ask for `--yes` before doing it for real.
- **Meaningful exit codes:** 0 done, non-zero failed, distinct codes for distinct failures
  (documented in `--help`).
- **Strict input:** reject ambiguous input with a clear error instead of guessing.

## Dependencies

- Prefer what's on the machine (bash, python3, jq, node). State anything else in the
  skill's `compatibility` field and in the body.
- Python with packages: inline them (PEP 723), so the script installs its own:

  ```python
  # /// script
  # requires-python = ">=3.11"
  # dependencies = ["httpx>=0.27,<1"]
  # ///
  ```

  and run it with `uv run scripts/fetch.py`.
- One-off tools: pin versions (`npx eslint@9`, `uvx ruff@0.8.0 check .`), never "latest".

## In SKILL.md

List each script with what it's for and the exact command:

```
## Scripts
- `scripts/check.sh <host>`: is the service up and on the expected version (exit 1 if not)
- `scripts/report.py --since 7d`: weekly numbers as JSON
```
