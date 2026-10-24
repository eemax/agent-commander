# Evaluating a skill

For skills that are used often or are costly when wrong. Two questions: does it get picked
when it should (triggering), and does following it give better results than not having it
(content)? Keep the material in the skill folder (`evals/`), so it can be rerun after changes.

## Triggering

1. Write about 10 requests that should use the skill and 10 that shouldn't, in
   `evals/triggers.json` as `[{"query": "…", "should_trigger": true}, …]`.
   - Should: vary the wording (formal, casual, a typo), how explicit it is (names the topic,
     or only describes the need), and the length (one line, or buried in a longer request).
     The most useful ones need the skill but don't say so.
   - Shouldn't: near-misses that share words with the skill but need something else (for a
     deploy skill: "run the tests locally", "what's deployed right now?"). Unrelated requests
     ("what's the weather") test nothing.
   - Make them real: paths, names, numbers, the way the user actually writes.
2. Judge each against the catalog entry alone (name and description, as you see it at the start
   of a conversation): would you pick it? For a real test, ask the user to try a few in a new
   conversation (/new) and see whether the skill's SKILL.md gets read.
3. Fix misses by changing the description, not by adding the missed request's words: find the
   kind of request it missed. False triggers: say what the skill is not for. Keep 4 or 5
   queries aside and check them only at the end, so you don't tune the description to the test.

## Content

1. Write 2-3 realistic tasks in `evals/evals.json` with what a good result looks like:
   `{"evals": [{"id": 1, "prompt": "…", "expected_output": "…", "files": ["evals/files/…"]}]}`.
   Include one edge case (bad input, an unusual request, missing access).
2. Do each task following the skill exactly as written, in a scratch directory. Note every
   point where you had to guess, look something up, or recover from an error: each is a gap.
3. After the first round, add checks you can verify (`"assertions": ["the output is valid
   JSON", "the report lists every failed endpoint"]`). Check them with commands where possible
   (`jq`, row counts, exit codes) rather than by eye, and count a check as passed only with
   evidence from the output.
4. Change the skill, run the tasks again, compare. Remove checks that always pass, fix checks
   that can never pass, and look hardest at the ones that only pass with the skill: that's
   what it's for.

Stop when the tasks pass and the user has nothing to add. A skill that doesn't do better than
working without it should be deleted.
