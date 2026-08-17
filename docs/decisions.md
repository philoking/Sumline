# What was left out, and why

Soulver does a number of things WebCalc does not. None of them were forgotten. This file records
which were **declined** — decided against, and not wanted — and which were **deferred**, meaning
the reasoning still holds but the answer could change.

The distinction matters if you are thinking of contributing: a deferred item is an open door, a
declined one is a decision you would need to argue with first.

## Declined

### Conditionals, booleans, number bases, bitwise operators, degree-mode trigonometry

A notepad calculator is for arithmetic you would otherwise do on paper. Conditionals and booleans
push it towards being a programming language, and a sheet that can branch is no longer something
you can read top to bottom and trust.

Worth knowing if this is ever revisited: math.js already returns `hex(256)` as `0x100` and parses
`0x9F31` literals, so number bases are largely a formatting job rather than new maths.

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

### A CLI, and a `POST /api/evaluate` surface

This one needs no third-party provider and could be built on its own merits. It is deferred for
want of a use, not for want of a way.

## Where this came from

These decisions were originally recorded as milestones and closed issues on the instance this
project was developed against. They are written down here so the reasoning travels with the code
rather than living somewhere only the author can reach.
