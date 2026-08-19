# What was left out, and why

Soulver does a number of things Sumline does not. None of them were forgotten. This file records
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

### Two people typing into one sheet at once

The app is live — the sheet list, the lock banner and the rate date all update as things happen,
and a read-only view follows the editor's typing keystroke by keystroke. It stops there. One
browser holds the sheet and the others read it, rather than every browser merging edits into a
shared document.

That boundary is where the cost changes shape rather than degree. Notice is a message saying what
moved, which each browser answers by refetching through the endpoints it already uses; a browser
that misses one is late, never wrong. Merging concurrent edits means CRDTs or operational
transforms, a per-character change log, and a second definition of what a sheet *is* that has to
agree with the plain text every other feature here depends on — copy, export, search, diffing the
conflict panel. A sheet is a working note, usually written by one person; a lock plus a version
check is honest about that, and the conflict panel already covers the case where two people did
write at once.

Server-sent events rather than a WebSocket for the same reason: every message goes one way, the
browser has a well-tested client for them with reconnection and backoff built in, and the
alternative would be a dependency and a protocol upgrade in order to send strictly less.

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

### Named financial functions, and cooking density conversions

What survives of an entry that used to cover sales tax and compounding as well; see
[Sales tax, compound interest and inflation](#sales-tax-compound-interest-and-inflation) below for
why those left. A loan repayment answers today —
`$250,000 * 0.05/12 / (1 - (1 + 0.05/12)^-360)` → `$1,342.05`, and it is now in the reference — but
writing it requires knowing it, which `pmt(0.05/12, 360, 250000)` would not. math.js supplies no
financial functions, so any would be Sumline's own.

That is a reason to wait rather than a reason to refuse. Every phrasing the engine accepts is one
with a worked example in Soulver's documentation, and Soulver has no PMT — inventing one means
naming its arguments, fixing their order and their sign convention, and then maintaining that
against no specification but this file. A formula in the reference costs nothing and can be copied.
If sheets turn out to carry the same formula by hand, that is the evidence to build on.

### A wall-clock time that does not exist in the space's zone

The morning the clocks go forward, 2:30 am never happens. A sheet pinned to New York can still be
asked about it — somebody types it, or a range lands on it — and which *existing* time it becomes
depends on who is reading:

| The reader's own zone | `2026-03-08 02:30` in a New York sheet |
| --- | --- |
| `UTC`, or anywhere without that transition | `1:30 am` |
| A zone that springs forward the same morning | `3:30 am` |

Both are real times either side of a gap, and there is no correct answer for a moment that does not
occur. What is wrong is that the answer is the *reader's* business at all.

The cause is one layer below where daylight saving is otherwise handled. The engine computes in
wall-clock space — a `Date` whose *local* fields read as the space's clock — and the parser builds
those with `new Date(y, m, d, h, min)`, so a time that does not exist **on the host** is normalised
by the host's own calendar before the engine can apply the space's. Everything downstream of the
parser was fixed: a duration now shifts the real instant in the space's zone, and the displayed
time, the timestamp and `as iso8601` agree with each other where they once named three different
moments.

Fixing the parser too means wall-clock space stops being local-field space — building and reading
every one of those dates through UTC fields instead, which reaches `startOfDay`, `addDays`,
`weekNumber` and the date parser. That is a large change to the part of the engine with the most
tests standing on it, and it buys one line shape, on two mornings a year, in a space pinned to a
zone that is not the reader's.

So it waits. A second symptom is the signal worth acting on: it would mean the local-field design
has a cost beyond this one case, which is the argument for the sweep that this case alone does not
make.

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

## Reversed

### A CLI, and a `POST /api/evaluate` surface

Deferred "for want of a use, not for want of a way", which was the right test — and three uses
turned up: a launcher front end onto the same engine *and the same globals*, scripting an instance
the way the README already documents doing with `curl`, and a deploy gate that asserts the engine
computes rather than that the port answers. Both are now built.

The design question was whether `/api/evaluate` should resolve the caller's globals from the space
cookie. It does. Otherwise `day rate * 3` means one thing in a launcher and another in a sheet,
which is the failure the endpoint exists to prevent rather than an inconvenience of it. For the same
reason the settings-to-options mapping moved into the engine: the browser and the server now read a
space's settings through [the same function](../engine/src/settings.ts), because two copies of that
mapping is two answers to what a space computes.

The CLI is a client of the endpoint rather than a second host for the engine, and that follows from
the same point. It could carry the engine — it is pure TypeScript — but then it would answer from
nothing while a sheet answered from the space, and the launcher case would be exactly wrong.

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

### Sales tax, compound interest and inflation

Deferred as "genuinely financial calculation, and out of scope for how this instance is used", which
mistook the subject for the mechanism. None of the three needs anything the engine does not already
do. A percentage applied to a currency amount *is* sales tax — `$50 + 8.25%` → `$54.13` — and the
reverse form recovers the price before it: `$120 is 20% on what` → `$100.00`. Percentages compose
with exponentiation, and that is compounding, so `$1,000 * (1 + 5%)^10` is compound interest and
`$100 * (1 + 3%)^25` is twenty-five years of inflation. They differ in what the rate is called.

Sales tax was in fact built twice, because a rate wants to live in one place rather than be retyped
on every line — and space globals already hold one. The README's own worked example of setting a
global is `"vat": "20%"`, after which `day rate * 3 + vat` answers. That is Soulver's sales-tax
preference, shipped and documented, while this file called the feature out of scope.

All three are now [documented and tested](../engine/src/examples.ts) as **Tax, interest and
repayments**. Loan repayments stay deferred, narrowed to the part that is genuinely missing:
[named financial functions](#named-financial-functions-and-cooking-density-conversions).

This is the number-bases lesson reached from the other side. That entry was wrong about what the
engine did; this one was wrong about what the feature *was*. Judging a feature out of scope is not
the same as it being absent, and only the second is a fact about the code — which is why both
mistakes survived so long in a file no test can fail.

## Reachable but not supported

A sweep of what math.js exposes through the expression parser turns up more that answers without
being documented. Each of these is deliberately left out of [`examples.ts`](../engine/src/examples.ts):

| Reachable | Why it stays undocumented |
| --- | --- |
| Comparisons returning booleans — `3 > 2` → `true` | Declined above; the first step towards branching. |
| Matrices and vectors — `[1, 2] + [3, 4]` → `[4, 6]`, `det([[1,2],[3,4]])` | Out of scope for a sheet of one-line sums, and the formatter renders them only incidentally. |
| `random()`, `pickRandom(...)` | Cannot be a golden test, and an answer that changes on every keystroke is wrong for a document you re-read. |
| Complex numbers — `sqrt(-1)` → `i`, `(1 + 2i) * 3` → `3 + 6i` | math.js has the type and the formatter prints it. Nothing here is built for it: there is no complex arithmetic in `values.ts`, no example, and no test. Its unit form does not answer at all — `20 VAR`, reactive power, is imaginary by definition and comes back "That does not work out to a number" rather than wrong. |

They are not blocked, because blocking means writing code to remove working behaviour and drawing an
arbitrary line around what counts as too much maths. They are simply not promised: absent from the
reference, absent from the tests, and liable to change with a dependency upgrade.

## Where this came from

These decisions were originally recorded as milestones and closed issues on the instance this
project was developed against. They are written down here so the reasoning travels with the code
rather than living somewhere only the author can reach.
