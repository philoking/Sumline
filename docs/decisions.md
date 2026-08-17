# What was left out, and why

Soulver does a number of things WebCalc does not. None of them were forgotten. This file records
which were **declined** — decided against, and not wanted — and which were **deferred**, meaning
the reasoning still holds but the answer could change. Two later sections cover what has since been
**reversed**, and what is **reachable but not supported** — behaviour that answers without being
promised.

The distinction matters if you are thinking of contributing: a deferred item is an open door, a
declined one is a decision you would need to argue with first, and a reachable one is neither — it
works today and may stop working tomorrow.

## Declined

### Conditionals and booleans

A notepad calculator is for arithmetic you would otherwise do on paper. Conditionals and booleans
push it towards being a programming language, and a sheet that can branch is no longer something
you can read top to bottom and trust.

A comparison written on its own does answer — `3 > 2` renders as `true`, because math.js evaluates it
and the formatter can print a boolean. That is *reachable* rather than supported; see
[Reachable but not supported](#reachable-but-not-supported) below. Branching is the thing being
declined, and a comparison is the first step towards it.

### Natural-language maths phrases beyond what is already supported

The phrasings the engine accepts are the ones with worked examples in Soulver's own documentation.
Inventing further ones means guessing at what a user might type, and every guess is a rule that has
to be maintained and can collide with something else. The line is drawn at documented behaviour.

### Trip planning, and time points generally

Soulver marks these up outside the text of the sheet. Sheets here are **plain text** — the
property that makes copy, export, search, and conflict-diffing work at all — so supporting time
points would have meant inventing a syntax with no precedent in Soulver's docs.

The same principle explains a design choice visible throughout the app: per-line formatting is
written **into** the line (`1/3 to 2 dp`, `100,000 in full`) rather than stored invisibly against
it. Hidden per-line state would not survive a copy, an export, or a line being moved.

## Deferred

### Sales tax, compound interest, loan repayments, inflation, cooking density conversions

Genuinely financial calculation, and out of scope for how this instance is used. Nothing about the
engine makes it hard — rate quantities (`$/hour`, `km/day`) were deliberately kept, because those
are unit maths rather than finance.

### Live stock prices, weather, knowledge lookups

Every usable provider needs an API key. That would compromise the guarantee that the container
works with no internet access at all, which is a property worth more here than the features would
be. The app's two network dependencies — exchange rates and public holidays — were both chosen
because they need no key and both fall back to bundled data.

Historical exchange rates were grouped with these and are now built, because Frankfurter serves them
with no key either — so they cost nothing the current rates were not already costing.

They degrade differently, though, and deliberately. Everything else here falls back to bundled data
on the reasoning that stale data is still roughly true. A 2020 conversion performed at this
morning's rate is not roughly true, it is wrong, so a date that cannot be fetched is **reported**
rather than filled in. It is the one place in the app that prefers a blank answer to a plausible
one.

### A CLI, and a `POST /api/evaluate` surface

This one needs no third-party provider and could be built on its own merits. It is deferred for
want of a use, not for want of a way.

## Reversed

### Number bases, bitwise operators and degree-mode trigonometry

Originally declined alongside conditionals, on the grounds that a notepad calculator does not need
them. The reasoning was wrong about the facts rather than about the principle: these were never
*absent*. math.js supplies `hex`/`bin`/`oct`, `0x`/`0b`/`0o` literals, the bitwise operators, and
trigonometry that takes `deg` as an ordinary unit — so every one of them already answered correctly,
undocumented, from the first release. This file said they were declined while the engine did them.

Because [`examples.ts`](../engine/src/examples.ts) is both the reference and the golden table,
behaviour missing from it is invisible in the app and unprotected by tests: users found these by
accident, and nothing would have caught a math.js upgrade breaking them. They are now documented and
tested, in three groups — **Named functions and constants**, **Trigonometry**, and **Number bases and
bitwise operators**.

The lesson is the one recorded elsewhere in this repository: write down what the code *should* do,
then check it against what it actually does.

## Reachable but not supported

A sweep of what math.js exposes through the expression parser turns up more that answers without
being documented. Each of these is deliberately left out of [`examples.ts`](../engine/src/examples.ts):

| Reachable | Why it stays undocumented |
| --- | --- |
| Comparisons returning booleans — `3 > 2` → `true` | Declined above; the first step towards branching. |
| Matrices and vectors — `[1, 2] + [3, 4]` → `[4, 6]`, `det([[1,2],[3,4]])` | Out of scope for a sheet of one-line sums, and the formatter renders them only incidentally. |
| `random()`, `pickRandom(...)` | Cannot be a golden test, and an answer that changes on every keystroke is wrong for a document you re-read. |

They are not blocked, because blocking means writing code to remove working behaviour and drawing an
arbitrary line around what counts as too much maths. They are simply not promised: absent from the
reference, absent from the tests, and liable to change with a dependency upgrade.

## Where this came from

These decisions were originally recorded as milestones and closed issues on the instance this
project was developed against. They are written down here so the reasoning travels with the code
rather than living somewhere only the author can reach.
