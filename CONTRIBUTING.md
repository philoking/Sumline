# Contributing

Sumline is a small project with a strong opinion about what it is. Small changes and bug fixes
are welcome as pull requests; for anything larger, open an issue first, because some of what
looks missing is missing on purpose.

The one most likely to catch you out: **new syntax is drawn from Soulver's own documented
behaviour rather than invented.** Guessing at what someone might type means a rule to maintain
for every guess, and rules that collide with each other. If Soulver documents a phrasing, it is
fair game; if nobody does, it needs an issue before it needs a patch.

## Getting set up

Node 22.5 or newer, because the server stores sheets through the built-in `node:sqlite` module.

```bash
npm install
npm run dev        # API on :8080, UI on :5173 with hot reload
npm test           # engine, server and web suites
npm run typecheck  # all three workspaces
npm run build
```

`npm run coverage -w @sumline/engine` prints which branches the tests have never reached. It is
not part of `npm test` and is not gated on a number — it is a reading list, not a bar.

Everything also runs the way CI runs it, inside the image, with no Node on your machine at all:

```bash
docker build --target test .
```

## The rules that are actually enforced

**A documented example is a passing test.** [`engine/src/examples.ts`](engine/src/examples.ts) is
the single source for both the in-app reference panel and
[`examples.test.ts`](engine/test/examples.test.ts), which evaluates every entry against a pinned
context and asserts the answer shown.

So documenting new behaviour and testing it are the same act. If you add a phrasing, add its
example; if the example is wrong, the suite says so.

**New syntax lands in three places.** The rewriters in
[`preprocess.ts`](engine/src/preprocess.ts), a case in the golden table, and — if it introduces a
new kind of token — [`tokenize.ts`](engine/src/tokenize.ts), which is what the editor colours from.
A rule the tokenizer does not know about shows up as a sheet coloured as though it meant something
it does not.

**A sheet is plain text.** Per-line formatting is written _into_ the line (`1/3 to 2 dp`) rather
than stored against it, because hidden state would not survive a copy, an export, a search, or a
line being moved. A change that needs invisible per-line state is a change to that decision, and
belongs in an issue first.

**The engine touches no DOM and no Node APIs.** It runs in the browser and in the server process,
and both have to give the same answer.

## Style

The comments in this codebase explain _why_, not _what_ — why a rule exists, what it would break,
what was tried instead. Match that. A comment restating the line below it is noise; a comment
recording the reason someone will otherwise undo is the most valuable thing in the file.

Commit messages are written in the imperative and read as sentences about behaviour —
"Do a duration in the sheet's zone, not the reader's" rather than "fix tz bug".

TypeScript is strict everywhere, including `noUncheckedIndexedAccess`. There is no formatter or
linter config to run; follow the surrounding file.

## Pull requests

Say what changes and why. Keep `npm test` and `npm run typecheck` green — CI runs both, plus the
full build.

Security problems go to [SECURITY.md](SECURITY.md) rather than to a public pull request.
