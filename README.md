# site-generator-speed — a faster drop-in for makefun-site 1.0.0

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/aryatrifebrian423/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/aryatrifebrian423/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

An original, dependency-free (Node stdlib only) fast reader that returns
exactly makefun-site 1.0.0's answer — the output tree of every page's
`index.html`, the index and tag pages, `build-report.txt` and each static
file — for every input, byte for byte, including its own front-matter
grammar, template dialect, Markdown subset, slug rule and report.

## How it is fast

The reference renders Markdown one character at a time (escaping per
character, string concatenation per token), builds a token object per block,
re-slugifies every title and tag name with a fresh normalisation and regex
pass, and renders templates by string concatenation through a scope chain.
This reader instead escapes with one native regex scan per string (returning
the input untouched when nothing needs escaping), renders Markdown in a
single fused pass over the lines with no token objects and long plain runs
sliced whole, memoises slugify per case with a pure-ASCII fast path that
skips Unicode normalisation, renders templates into an output array joined
once, and parses front matter by scanning line boundaries instead of
splitting and re-joining the whole body.

## Layout

- `solve.js` — the entry: `run(input)` returns makefun-site 1.0.0's answer.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json`.
