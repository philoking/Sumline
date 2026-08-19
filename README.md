# WebCalc

A notepad calculator you run yourself, in the browser.

Type in plain language on the left; answers appear in a column on the right, updating as you
type. Units, currencies, percentages, dates, variables and running totals all work the way you'd
write them on paper. It is an open-source take on the idea [Soulver](https://soulver.app/)
popularised — with the differences that it runs in Docker, is reachable from any browser on your
network, and keeps every sheet in one shared place instead of on one Mac.

```
groceries $86.40 #home              $86.40
train fare $12.80 #travel           $12.80
electricity $94.10 #home            $94.10
sum                                $193.30
sum #home                          $180.50
```

## Quick start

```bash
git clone <this-repository> webcalc
cd webcalc
docker compose up -d --build
```

Open <http://localhost:8422>. Sheets are stored in the `webcalc-data` volume and survive
restarts and rebuilds.

Date maths resolves in **your browser's** timezone, not the container's, so `today` is your today
wherever the instance is hosted. Nothing needs setting for that, though a space can pin a zone of
its own — see [Time zones and the clock](#time-zones-and-the-clock).

## Syntax

Everything below is a line you can type. Anything the engine doesn't recognise is left as plain
text with no answer, so a sheet can mix notes and sums freely.

The same reference is **built into the app** — press `?`, click the `?` button, or open
`/?help`. Clicking any example there drops it into your sheet.

### Arithmetic

| You type | You get |
| --- | --- |
| `12 * 34` | `408` |
| `1,250 / 8` | `156.25` |
| `2^16` or `2 ** 16` | `65,536` |
| `6 × 7`, `84 ÷ 2`, `50 − 8` | `42` |
| `3 to the power of 2` | `9` |
| `remainder of 21 divided by 5` | `1` |
| `√16`, `sqrt(16)` | `4` |
| `10 plus 5 times 2` | `20` |
| `what is 6 * 7?` | `42` |

### Numbers and notation

| You type | You get |
| --- | --- |
| `5k + 500` | `5,500` |
| `2 million / 4` | `500k` |
| `$3k`, `$9bn`, `€6M`, `£12tn` | full currency amounts |
| `100,000 + 200,000` | `300k` |
| `1_000_000 + 2_000` | `1M` |
| `1,700,000 as sci` | `1.7e6` |

Large plain numbers are abbreviated with SI-style symbols (`k`, `M`, `G`, `T`) above 100,000,
the way Soulver does. Currency is always written out in full. **View → Notation for large
numbers** turns abbreviation off if you'd rather see every digit.

Number conventions follow a **region**, set per space in Space settings:

| Region | Reads and writes |
| --- | --- |
| North America (default) | `1,234.56` |
| Western Europe | `1.234,56` |
| Eastern Europe | `1 234,56` |

Underscores group digits in every region, so `1_000_000` works wherever you are.

The region decides how a sheet is **read**, not only how its answers look. `1.234 + 1` is
`1.235` under Western Europe and `2.234` under North America — so changing it changes what
sheets you have already written compute, which is why it belongs to a space rather than to a
browser.

### Rounding

| You type | You get |
| --- | --- |
| `1/3 to 2 dp` | `0.33` |
| `pi to 5 digits` | `3.14159` |
| `5.5 rounded` / `rounded up` / `rounded down` | `6` / `6` / `5` |
| `37 to nearest 10` | `40` |
| `$490 rounded to nearest hundred` | `$500.00` |
| `21 rounded up to nearest 5` | `25` |

`to N dp` is cosmetic — totals and line references still use the unrounded value. `to nearest N`
genuinely changes the number.

### Functions and constants

These come from math.js, so they are spelled the way it spells them rather than in the natural
phrasing the rest of the engine accepts.

| You type | You get |
| --- | --- |
| `log(100, 10)`, `log10(1000)`, `log2(1024)` | `2`, `3`, `10` |
| `exp(1)` | `2.7182818285` |
| `nthRoot(27, 3)`, `hypot(3, 4)` | `3`, `5` |
| `abs(-5)`, `sign(-3)` | `5`, `-1` |
| `square(4)`, `cube(3)` | `16`, `27` |
| `5!`, `combinations(5, 2)`, `permutations(5, 2)` | `120`, `10`, `20` |
| `gcd(12, 18)`, `lcm(4, 6)` | `6`, `12` |
| `std(2, 4, 6)`, `variance(2, 4, 6)` | `2`, `4` |
| `e`, `tau`, `phi` | the constants |

### Trigonometry

Angles are radians unless you write `deg`, which is an ordinary unit here — so it converts and
composes like any other.

| You type | You get |
| --- | --- |
| `sin(30 deg)`, `cos(60 deg)` | `0.5` |
| `tan(45 deg)` | `1` |
| `sin(pi / 2)` | `1` |
| `asin(0.5)` | `0.5235987756` |
| `atan2(1, 1)` | `0.7853981634` |
| `45 deg in rad` | `0.7853981634 rad` |

### Number bases and bitwise operators

| You type | You get |
| --- | --- |
| `hex(255)`, `bin(5)`, `oct(64)` | `0xff`, `0b101`, `0o100` |
| `0xff`, `0b1011`, `0o777` | `255`, `11`, `511` |
| `0xff + 1` | `256` |
| `5 & 3`, `5 \| 3`, `bitXor(5, 3)` | `1`, `7`, `6` |
| `5 << 2`, `20 >> 2` | `20`, `5` |
| `~5` | `-6` |

A literal in another base reads back as a decimal; `hex`, `bin` and `oct` write one out. `255 in hex`
does **not** work — `in` is the unit-conversion word, so that line reads as inches.

### Percentages

| You type | You get |
| --- | --- |
| `20% of 250` | `50` |
| `120 + 15%` | `138` |
| `20% off 50` / `20% on 50` | `40` / `60` |
| `20 is 10% of what` | `200` |
| `180 is 10% off what` | `200` |
| `50 to 75 is what %` | `50%` |
| `180 is what % off 200` | `10%` |
| `20 as a % of 200` | `10%` |
| `10% + 20%` | `30%` |
| `30% + 0.4` | `70%` |
| `50% × 30` | `15` |
| `20% as dec` | `0.2` |

A percentage is a real value, so it survives arithmetic. Order matters and is not an accident:
`50 + 20%` grows fifty by a fifth, while `20% + 50` is percentage maths.

### Fractions and multipliers

| You type | You get |
| --- | --- |
| `2/10 as fraction` | `1/5` |
| `50% as fraction` | `1/2` |
| `2/3 of 600` | `400` |
| `20/5 as multiplier` | `4x` |
| `50 to 75 is what x` | `1.5x` |
| `1 as x off 2` | `0.5x` |

### Units

| You type | You get |
| --- | --- |
| `65 mph in km/h` | `104.60736 km/h` |
| `180 lbs in kg` | `81.6466266 kg` |
| `meters in 10 km` | `10,000 meters` |
| `seconds in a day` | `86,400 seconds` |
| `5 hours 30 minutes to seconds` | `19,800 seconds` |
| `km m` | `1,000 m` |
| `300 + 20 km` | `320 km` |
| `1km + 1,000m` | `2 km` |
| `100 km * 2 in miles` | `124.274238447 miles` |

A bare number takes on the unit beside it, which Soulver calls unit assimilation.

A conversion at the end of a line applies to the whole line, so `100 km * 2 in miles` converts the
product rather than the `2`. Arithmetic written *after* a conversion is the other way round —
`100 km in miles * 2` reads the `miles * 2` as the target and is refused, because there is no
reading of it that is obviously the one you meant. Bracket that case: `(100 km in miles) * 2`.

### Rates

| You type | You get |
| --- | --- |
| `3 hours / day` | `3 hours/day` |
| `$99 per week` | `$99.00/week` |
| `30 bottles / week` | `30/week` |
| `90 km / 3 day` | `30 km/day` |
| `$20/day + $300/week` | `$440.00/week` |
| `$50/week * 12 weeks` | `$600.00` |

### Currency

| You type | You get |
| --- | --- |
| `$42.50 * 3` | `$127.50` |
| `100 USD in EUR` | `€80.00` |
| `20% of $250` | `$50.00` |
| `$100 + €80` | `€160.00` |

The figures above use the same fixed table as the in-app reference, dated 14 August 2026; a
running instance uses whatever it last fetched, so your answers will differ.

Mixed currencies answer in the **last** one named, matching Soulver. Rates come from
[Frankfurter](https://frankfurter.dev/) (European Central Bank data, no API key), refreshed on
start and every 12 hours and cached to disk. A container with no internet access falls back to
the rates bundled in the image, and the reference panel behind `?` says which day they are from
and warns that they could not be refreshed.

#### On a past date

| You type | You get |
| --- | --- |
| `100 USD in EUR on 2020-01-01` | that day's rate, not today's |
| `$100 in GBP on 1 January 2020` | the same, written differently |
| `1,000 USD in JPY on 1/1/2020` | any date form the engine reads |

Add `on <date>` to a conversion and it uses the rate published that day. Every date form the
[Dates](#dates) section lists works here.

A weekend or a public holiday has no published rate, so the last day before it is used — which is
why `on 2020-01-01` answers with 31 December 2019 data. Each date is fetched once and kept for
good, since a past rate never changes; a date already asked about therefore keeps working with no
network at all.

**A date that cannot be answered says so** rather than quietly falling back to today's rate. With
no network and no cached copy, the line reports `No exchange rates available for 2020-01-01`. This
is the one place the app prefers a blank answer to a plausible one: converting a 2019 invoice at
this morning's rate, silently, is the mistake worth going out of the way to avoid.

### Dates

| You type | You get |
| --- | --- |
| `today + 3 weeks` | `Sat 5 Sep 2026` |
| `April 1, 2019 - 3 months 5 days` | `Thu 27 Dec 2018` |
| `3 weeks after March 14, 2019` | `Thu 4 Apr 2019` |
| `28 days before March 12` | `Thu 12 Feb 2026` |
| `4 days from now` / `3 days ago` | a date |
| `next friday` / `last monday` | a date |
| `3 March to 30 May` | `2 months 3 weeks 6 days` |
| `days between 3 March and 30 May` | `88 days` |
| `April 1 through April 30 in days` | `30 days` |
| `midpoint between March 12 and April 5` | `Tue 24 Mar 2026` |
| `week of year` / `week number on march 12, 2021` | `33` / `10` |
| `days in Q3` / `days in February 2020` | `92 days` / `29 days` |
| `day of the week on January 24, 1984` | `Tuesday` |

Answers involving today are written as of **Saturday 15 August 2026**, the day the in-app
reference pins, so a table can be read against a fixed calendar rather than the day you read it.

A range answers in calendar components; `days between` answers in whole days. A date written
without a year picks whichever year puts it nearest today, so in December `January 12` is next
January. ISO dates (`2026-08-15`) are unambiguous; slashes read as month/day/year and dots as the
European day.month.year.

A slash or dot date standing on its own needs a four-digit year — `12/25/2026` is Christmas,
where `3/4/5` stays chained division, because nothing distinguishes the two otherwise. A short
year is still read as one where the rest of the line has already established a date, as in
`12/25/26 + 3 days`.

### Workdays

| You type | You get |
| --- | --- |
| `workdays in 3 weeks` | `15 workdays` |
| `10 March to 17 March in workdays` | `5 workdays` |
| `workdays from April 12 to June 15` | `45 workdays` |
| `today + 5 business days` | `Fri 21 Aug 2026` |

Public holidays are excluded. The list comes from [Nager.Date](https://date.nager.at/), refreshed
weekly and cached. With no network it falls back to a small bundled set of fixed-date holidays.

**The country is instance-wide**, set by `HOLIDAY_COUNTRY` — a two-letter code like `DE`. Every
space on the instance does workday maths against the same calendar; a space cannot pin its own.
The reference panel reports how many holidays actually loaded, because a code the provider does
not cover would otherwise show up much later as workday maths quietly counting a holiday.

### Clock times, timespans and timecode

| You type | You get |
| --- | --- |
| `16:00 + 3 hours 12 minutes` | `Sat 15 Aug 2026 at 7:12 pm` |
| `7:30 to 20:45` | `13 hours 15 minutes` |
| `4pm to 3am` | `11 hours` |
| `4.54 hours as timespan` | `4 hours 32 minutes 24 seconds` |
| `72 days as timespan` | `10 weeks 2 days` |
| `3h 5m 10s in seconds` | `11,110 seconds` |
| `5.5 minutes as laptime` | `00:05:30` |
| `03:04:05 + 01:02:03` | `04:06:08` |
| `12.5 minutes in minutes and seconds` | `12 minutes 30 seconds` |
| `03:10:20:05 at 30 fps + 50 frames` | `03:10:21:25` |
| `00:30:10:00 @ 24 fps in frames` | `43,440 frames` |

A laptime needs two colons and a timecode three, which is how they are told apart from a clock
time. The compact `3h 5m 10s` form needs at least two components, so a lone `5m` stays five metres.

A timecode that names no frame rate is read at 24 fps. Writing `@ 30 fps` on the line changes it.

### Time zones

| You type | You get |
| --- | --- |
| `6pm Sydney in Chicago` | a clock time |
| `2am PST to GMT` | a clock time |
| `7:30am LAX to Japan` | a clock time |
| `time in Paris` / `Tokyo time` | the current time there |
| `date in Vancouver` | the current date there |
| `time difference between Seattle and Moscow` | `10 hours` |

Cities, countries, IATA airport codes, US abbreviations (`PST`, `eastern time`) and GMT offsets
all work. The place-name table is bundled so this keeps working offline; conversion itself uses
the platform's own timezone database.

#### Time zones and the clock

Anything that means "here" — `today`, `now`, `4pm`, `current timestamp`, and the offset in
`as iso8601` — resolves in **the browser's** timezone. Evaluation runs entirely client-side, so
the machine hosting the container never enters into it.

That is usually what you want, and it is why nothing needs configuring: two people in different
countries reading the same shared instance each get their own `today`, and a laptop that travels
follows along by itself.

It also means the container's `TZ` does **not** decide date maths, whatever it is set to. It sets
the container's own clock — log timestamps, and which years of public holidays get fetched — and
nothing else.

**A space can pin a zone** when that default is wrong for it — a client in another country whose
sheets should resolve there no matter who opens them. Set it in Space settings, as an IANA name
(`Europe/Berlin`) or any place name a line would accept (`Berlin`, `Tokyo`). Leave it empty and the
reader's own zone applies, which stays the default.

With a zone set, everything meaning "here" moves to it — `today`, `now`, `4pm`, week numbers,
workday counts. Three things deliberately do not:

- **Timestamps stay absolute.** `current timestamp` is the same number in every zone, because it
  names an instant rather than a wall clock. `today to timestamp` gives the moment that day begins
  *in the space's zone*, which is a different instant in Tokyo than in Los Angeles.
- **`as iso8601` carries the space's offset**, since writing Berlin's clock against a Los Angeles
  offset would name a different moment entirely.
- **A zone written in the line always wins.** `6pm Sydney in Chicago` means the same thing from
  anywhere; a space setting is a default, not an override.

#### A day and twenty-four hours are not the same thing

Twice a year they come apart, and the answers below are both right:

| You type | You get |
| --- | --- |
| `2026-03-08 00:00 + 1 day` | `Mon 9 Mar 2026 at 12:00 am` |
| `2026-03-08 00:00 + 24 hours` | `Mon 9 Mar 2026 at 1:00 am` |
| `2026-11-01 00:00 + 24 hours` | `Sun 1 Nov 2026 at 11:00 pm` |

A **day** is a calendar day: the same clock time on the next date, whatever happened to the clocks
in between. A **duration** is an amount of time, so it counts hours. The morning the clocks go
forward is 23 hours long and the evening they go back is 25, which is why twenty-four hours can
land at 1 am or at 11 pm the same evening.

Which zone's clocks is the space's, not the reader's — so a sheet pinned to New York does New York's
daylight saving from anywhere.

### Timestamps

| You type | You get |
| --- | --- |
| `April 1, 2019 to timestamp` | a Unix timestamp |
| `1559740303 to date` | `5 Jun 2019 at 6:11 am` |
| `1733823083000 to date` | milliseconds are detected by magnitude |
| `current timestamp` | now, in seconds |
| `April 1, 2019 3:30pm as iso8601` | `2019-04-01T15:30:00-07:00` |

Timestamps are absolute but the dates they render as are not: both the time shown and the offset
written by `as iso8601` follow **the browser's** timezone. The examples above assume a reader in
`America/Los_Angeles`.

### Statistics

| You type | You get |
| --- | --- |
| `total of 3, 4, 7 and 9` | `23` |
| `average of 36, 42, 19 and 81` | `44.5` |
| `median of 10, 20 and 30` | `20` |
| `count of 1, 2, 3, 4, 5` | `5` |

### Notes, labels and comments

Four ways to keep text out of the maths:

| Form | Example |
| --- | --- |
| Double slash | `1 + 2 // this is three` |
| Label | `Cost of 128 GB iPhone 16: $999` |
| Parentheses | `$999 (for iPhone 16)` |
| Quotes | `Boeing "747" is $386.8M` |

Loose prose around a sum is ignored too, so `I spent $128 + $45 on clothes` answers `$173.00`.
A colon marks a **label**, not a variable — use `=` to declare one.

### Variables, references and totals

```
monthly rent = 1500        1,500
monthly rent * 12         18,000
prev / 2                   9,000
line 1 + 100               1,600
```

- Variable names can be several words: `take home pay = 4200`.
- `prev` is the line above; `line N` is any line by number — the gutter numbers on the left tell
  you which is which. Click an answer to insert a reference to it.
- `sum` (or `total` / `subtotal`) adds every value line since the last heading, then closes that
  section so stacked totals don't double-count. `average` and `count` work the same way.
- Tag a line with `#food` and use `sum #food` to total just those lines, anywhere in the sheet.
- `# Heading` starts a new section and `// comment` is ignored.
- A running **Total** of every value line sits at the bottom of the answer column. It disappears
  when a sheet mixes things that can't be added, rather than showing a meaningless number.


## Using the app

### Keyboard

| Shortcut | Action |
| --- | --- |
| `Mod`+`\` | Insert a reference to the line above |
| `Mod`+`T` | Turn the current blank line into a subtotal |
| `Mod`+`/` | Comment the line out |
| `Mod`+`Shift`+`U` | Unlink — freeze this line's references at their values |
| `Mod`+`Shift`+`N` | New sheet |
| `Mod`+`F` | Search sheets |

Typing a variable name offers the names already declared in the sheet.

### The answer column

Click an answer to cite it, or drag it into a line. Right-click for a menu: copy, insert a
reference, set decimal places, write the number out in full, or reset formatting.
Double-clicking an empty answer slot turns that line into a subtotal.

Formatting chosen from that menu is **written into the line as text** (` to 2 dp`, ` in full`)
rather than stored invisibly against it. A sheet is plain text, and hidden per-line state would
not survive being copied, exported, or having its lines moved around.

### Highlighting

The sheet is coloured by what the engine makes of it, not by a set of patterns the editor keeps
of its own: numbers, units and currencies, variables and references, operators, tags, headings
and comments each get a shade, and anything left plain is text the engine is ignoring.

That makes the colour a **reading of the line**, which is the useful part. A word you meant as a
note but that turns out to be a unit is coloured as a unit. `128 GB` inside a label stays plain,
because a label is never evaluated. And a variable that shares a name with a unit shows you
which one won:

```
hours = 6.5                 6.5
hours * 2                    13          hours is the variable
2 hours + 30 minutes          2.5 hours  hours is the unit
```

The palette is deliberately quiet — five close-toned colours, with numbers keeping the blue the
sheet has always used for what you type. It follows the light and dark appearances, and prints
as plain black.

### The view menu

`👁` in the top bar holds everything about how a sheet is *shown*, rather than what it says:
text size, the sidebar, line numbers, the total and its options, and how numbers are written.
All of it is stored per space, so it follows you between browsers.

Under **Number format**:

- **Precision** — how many decimal places an answer may show: 0–5, 10 or 15, defaulting to 10.
  A ceiling rather than a width, so `20.50` still answers `20.5`. Large numbers spend the
  available digits on the whole part first, so `1,234,567.89` stays itself rather than
  becoming `1,234,567.8899999999`.
- **Thousands separators** — `1,234` against `1234`. The decimal point stays the region's own.
- **Notation for large numbers** — `300k` against `300,000`.
- **Currency rounding** — money held to its currency's usual decimals, so `$3.33` rather than
  `$3.3333333333`, and no fraction on yen. A line that asks for `to 4 dp` still gets it: what
  is written in the sheet outranks a preference set in a menu.

### The total

The figure in the corner cycles between **total, average, count and median** when clicked, and
can be hidden. Both choices persist across sheets and browsers.

Under **View → Total options** are the two questions of what feeds it, both counted by default:

- **Include variable declaration lines** — whether `monthly rent = 1500` counts like any other
  value. Untick it for a sheet that declares a few amounts and then works with them, where
  counting the declarations reads high by exactly the sum of the things the answer was built
  from. A sheet that *is* a list of named amounts needs them counted, which is why it is a
  setting rather than a rule.
- **Include referenced lines** — whether a line that a later line reads still counts on its own.
  Untick it and `10 / 20 / prev + 5` totals 35 rather than 55: the 20 counts once inside the 25
  instead of once there and once again by itself.

**Select more than one line** and the same figure appears beside the selection, for those lines
alone. It follows whichever statistic the corner is set to, so the two never disagree about what
"the figure" means, and the corner keeps showing the whole sheet — the point is to read one
against the other. Selecting inside a single line shows nothing: that line's answer is already
sitting beside it.

### Sheets

Sheets can be searched by title or content, and are moved to a **trash** when deleted rather
than destroyed — restore them, or empty the trash to remove them for good. An untitled sheet
names itself from its first line.

### Folders

Folders are part of the sheet list, not a filter beside it. A folder is a heading you can
collapse; its sheets sit inside it and go away with it, so filing something makes the list
shorter. A shut folder shows how many sheets are in it. Loose sheets follow the folders.

Which folders you keep shut is remembered per browser, like the appearance, since it depends on
the screen you are sitting at rather than on who you are.

Move a sheet in or out with the dropdown beside it. Deleting a folder keeps its sheets and
returns them to the top level.

**Searching flattens the list.** Matches appear as one run regardless of folder, each naming the
folder it lives in — a tree would hide matches inside collapsed folders, which would make search
lie about what it found. The trash is flat for the same kind of reason: it is not a place with
structure.

### Order

Sheets are listed with whatever changed last at the top. Drag one to put the list in your own
order instead — or use **Move up** / **Move down** in the ✎ menu, which do the same thing from a
keyboard, and are easier on a phone where the sidebar is an overlay.

The first drag switches that space to a custom order, seeded from the order that was already on
screen, so nothing jumps around the moment you touch it — the list simply stops rearranging
itself. A **Custom order** line then appears above the sheets with a way back to sorting by
recency, and switching back does not throw the arrangement away: flip to recent to find
something, flip back, and your order is still there.

A sheet made after you arranged things has no place in that arrangement yet, so it appears at
the top — the same place the recency order would have put it.

Each folder is its own run, and so is the top level: dragging inside a folder rearranges that
folder and leaves everything outside it exactly where it was. Search results and the trash
cannot be reordered, since neither is a list whose order means anything.

### Colour coding

The ✎ on a sheet or a folder opens a small menu: rename, or pick one of eight colours. The
colour shows as a bar down the leading edge of the row, and folders take the same eight.

Eight rather than more, because the point of a colour code is being read at a glance, and past
about eight the hues start needing a second look. A colour is stored as a name rather than a
value, so it follows the light and dark themes instead of being right in one and wrong in the
other.

Colouring a sheet does not count as changing it: it leaves the modified time and the version
alone, so a sheet does not jump to the top of the list for being filed, and tagging one cannot
collide with someone else editing it.

### Appearance

The ◐ button in the top bar cycles **system → light → dark**. It starts on
system, following your OS setting. The choice is stored per browser rather than
on the server, since which appearance suits you depends on the screen you are
sitting at. `?theme=light` (or `dark`, or `system`) sets it from a link.

### The reference panel

Press `?` for a searchable list of everything the calculator understands, grouped, with each
example's answer beside it. Clicking one inserts it into the sheet.

Its contents are **generated from the golden tests** — [`engine/src/examples.ts`](engine/src/examples.ts)
is imported both by [`engine/test/examples.test.ts`](engine/test/examples.test.ts), which asserts
every answer shown, and by the UI that renders them. An example cannot claim something the engine
doesn't do, because the same line is a passing test. Adding one to the docs means adding a test.

### Export

From the ⤓ menu: copy with answers, or download as text, Markdown or CSV. **Print / save as PDF**
uses a print stylesheet that lays the answer column beside the text on paper.

### Space settings and Global settings

Two panels behind the initial in the top bar, and which one you open says what you
are editing.

**Global settings** holds what is true of the whole instance: the number region,
the timezone, and the variables every space can use.

**\<Space\> settings** holds only that space: its name, its own variables, and an
override for the region or timezone where it needs to differ. Each override names
what it would otherwise inherit, so an unset field never leaves you guessing.

An override is a decision, not a copy. Change the global value afterwards and the
spaces that never overrode it follow along, while the one that did keeps what it
chose. Choosing the **Global —** option puts a space back on the global value.

Region and timezone are per space rather than per browser because they change what
a sheet *computes*: two browsers open on the same space must not disagree about
what `1.234` means. That is the opposite of the theme, which is per browser
precisely because it changes nothing.

Through the API, a space's own tier is `PUT /api/settings` and the global tier is
`PUT /api/settings/shared`; `null` clears an override:

```bash
# a region for the whole instance
curl -X PUT localhost:8422/api/settings/shared \
  -H 'content-type: application/json' -d '{"region": "western-europe"}'

# except in this one space
curl -X PUT localhost:8422/api/settings -H 'content-type: application/json' \
  -H 'cookie: webcalc_user=boston' -d '{"region": "north-america"}'

# and back to following the global value
curl -X PUT localhost:8422/api/settings -H 'content-type: application/json' \
  -H 'cookie: webcalc_user=boston' -d '{"region": null}'
```

`GET /api/settings` returns the space's own keys, `shared` (the global tier) and
`effective` (the two resolved) — computed server-side so the panel and the sheets
cannot disagree about which value is winning.

### Global variables

Variables every sheet can use without declaring them — a `day rate`, a `vat`, a mileage rate.

Set them in **Space settings**, from the menu behind the initial in the top bar. Each row is a
name and a value, with what it works out to shown beside it, so a typo is visible there rather
than discovered later in a sheet that quietly answers nothing.

**There are two scopes**, because some values belong to one space and some belong to all of them:

| Scope | For |
| --- | --- |
| **Everywhere** | Values true across the whole instance — a tax rate, a mileage rate, a home currency. Defined once instead of once per space. |
| **In this space** | Values that belong to this space alone, like a `day rate` that differs between Consulting and Teaching. |

They resolve most-specific-first, so a sheet beats its space and a space beats Everywhere:

```
a sheet's own declaration  >  the space's variables  >  the Everywhere variables
```

Overriding is by name and affects nothing else. Give one space its own `vat` and every other space
carries on with the Everywhere value; change the Everywhere value afterwards and the spaces that
never overrode it follow, while the one that did keeps what it chose. **An override is a decision,
not a copy that keeps tracking its source.**

The panel shows all of it rather than leaving you to work it out. A variable that displaces an
Everywhere value says so and names the value it displaced; the Everywhere variables a space has
*not* overridden are listed separately as still in effect, each with an **Override** button that
copies the value in as the space's own. Nothing about which value wins is hidden.

Two things worth knowing. The panel edits the space you are working in — to change another one's
own variables, switch to it first. And **Everywhere** reaches past your space, so on an instance with
no password anyone who can open it can change those — which is the main thing
[`WEBCALC_PASSWORD`](#the-password-if-you-want-one) exists to close.

Both scopes can also be set through the API, which is worth knowing for scripting an instance:

```bash
curl -X PUT http://localhost:8422/api/settings \
  -H 'content-type: application/json' \
  -H 'cookie: webcalc_user=work' \
  -d '{"globals": {"day rate": "$550", "vat": "20%"}}'
```

**The cookie decides which space you are writing to**, and it is not optional on an instance with
more than one: without it the request resolves to whichever space is listed first, so globals meant
for `school` land in `work` and nothing reports a problem. `webcalc_user` takes a space **id** —
the lowercase, dashed form of its name, which is what `SPACES="Work,Personal"` derives and what
the switcher sets in your browser.

That is what makes the same name mean different things in different places:

```bash
# day rate is $550 when working, $120 when teaching
curl -X PUT localhost:8422/api/settings -H 'content-type: application/json' \
  -H 'cookie: webcalc_user=consulting' -d '{"globals": {"day rate": "$550"}}'
curl -X PUT localhost:8422/api/settings -H 'content-type: application/json' \
  -H 'cookie: webcalc_user=teaching'   -d '{"globals": {"day rate": "$120"}}'
```

Read them back the same way, which is the quickest way to check a global landed where you meant
it to:

```bash
curl localhost:8422/api/settings -H 'cookie: webcalc_user=teaching'
```

The **Everywhere** scope has its own endpoint, and is deliberately *not* cookie-scoped — being
per-instance is the whole point of it:

```bash
curl -X PUT localhost:8422/api/settings/shared -H 'content-type: application/json' \
  -d '{"globals": {"vat": "20%", "mileage": "$0.68/mile"}}'
```

`GET /api/settings` returns three things: `globals`, this space's own; `sharedGlobals`, the
Everywhere set; and `effectiveGlobals`, the two resolved. The last two are computed, so precedence
is decided in one place rather than by each client. `PUT` **ignores** them — sending a GET response
straight back is safe, and cannot quietly promote every inherited value into one of the space's
own.

A `PUT` merges at the top level only — sending `statistic` leaves `globals` untouched — but
`globals` is a single value, so **sending it replaces every variable in it**. `{"globals": {"day
rate": "$600"}}` on a space that also had a `vat` leaves that space with no `vat` at all. Send the
whole set each time, or read it back first and edit what you get. The same is true of
`/api/settings/shared`.

## Spaces

A space is a separate set of sheets, with its own folders, trash, settings and global variables.
Nothing about it says a space has to be a person.

Two people sharing an instance is the obvious use, but one person with several spaces is just as
reasonable — **Work** and **Personal**, a space per client, a space per project, or one for
school and one for everything else. What a space gives you is a clean list and its own global
variables: a `day rate` that means one thing in Consulting and another in Teaching, without the
two ever seeing each other's sheets.

The initial at the right-hand end of the top bar shows which space you are in; clicking it offers
the others. The choice is kept in a cookie, so a browser stays where it was last left. Every
space gets its own Welcome sheet when it is created.

**This is not a login.** There are no passwords, and anyone who can reach the app can switch to
any space — the same footing as an instance with no authentication at all. Spaces keep unrelated
sheets from piling up in one list; they do not keep anyone out.

### Adding and removing spaces

From the space menu: **Add space…** creates one, and **Rename or remove…** turns the list into
an editable one. There is no limit on how many there are, and a fresh instance starts with a
single space called "Me" rather than assuming there is a second.

`SPACES` **seeds** an instance that has none, which is the only thing it does — spaces then live
in the database, so one added in the app is not undone by the next deploy, and one removed does
not come back because the variable still names them:

```bash
SPACES="Work,Personal"             # ids derived from the names
SPACES="ada:Ada,grace:Dr Hopper"   # ids stated outright
```

Every sheet, folder and setting is stamped with a space's **id**, not its name, which is why the
two are separable. Renaming a space in the app changes only what is displayed — "Work" can become
"Consulting" without a single sheet moving. The `id:Name` form matters when seeding an instance
whose database already uses particular ids.

**Removing a space keeps its sheets.** They are not deleted — no space owns them any more, so
they drop out of every list, and adding a space back under the same id shows them again. The
app says how many went out of sight when you remove one, and the server logs any owner id it
finds with no space at startup. The last space cannot be removed, since every request has to
resolve to one.

Sheets that existed before spaces belong to the first space the instance ever had. An instance
upgraded from a version without them adopts the ids already stamped on its data, so nothing opens
on an empty-looking list.

A share link crosses spaces — that is the point of it. Following a link into another space shows
that sheet, badged with the space it came from, and you can edit it under the usual lock. What
you cannot do from outside is destroy it or file it: trashing, purging, restoring, colouring, and
renaming or deleting a folder are refused unless the thing belongs to the space you are in, so
following a link never puts you one mis-click from deleting something you were only visiting.

Colour sits on that side of the line because it is filing rather than content: it changes how a
row looks in a sidebar you cannot see, and unlike an edit the lock does not serialise it.

## Sharing and concurrent editing

Sheets live on the server, so every browser reaching the same space sees the same sheets. When
you open one your browser takes a short-lived editing lock; anything else that opens it gets a
read-only view plus a **Take over editing** button.

The banner names the **space** holding the lock rather than the browser — "Work is editing this
sheet" — which is the useful thing to know when the other tab is your own, and reads as a person
when the spaces happen to be people.

### Everything is live

Nothing here waits for you to act. Each browser holds an event stream open to the server, and the
server says what changed as it changes:

- A sheet created, renamed, coloured, moved, trashed or restored anywhere appears in **everyone's**
  sidebar in the same space.
- Opening a sheet someone else has open puts the read-only banner up in *their* browser's terms
  straight away — and takes it down again the moment they close the tab, rather than at the next
  thing you tried to do.
- A read-only view **follows along** as the other person types, instead of showing the sheet as it
  stood when you opened it.
- The rate date in the reference panel updates when the server refreshes its rates, including when
  a failed refresh turns them stale.

A browser that has the sheet open but not the lock also watches for the lock to lapse, which is the
case nothing can announce: a tab that crashes, sleeps or loses its network never gets to say it has
let go, and the lock simply ages out.

The stream carries notice, not data. An event says *what* moved and each browser refetches through
the same endpoints it always used, so there is no second path by which a sheet can arrive. Missing
events therefore costs freshness rather than correctness — and a browser that reconnects is told to
re-read everything rather than trying to replay a gap it cannot see the edges of.

If a proxy in front of the instance buffers responses, the stream will connect and then deliver
nothing. The app notices that — it waits for messages, not for a socket — and falls back to asking
on a timer, which is how it behaved before any of this. `/api/events` sets `X-Accel-Buffering: no`,
which nginx reads; if yours needs something else, `proxy_buffering off` for that path does it.

### Links to a sheet

The address bar stays at `/` while you work. Which sheet is open is remembered per tab, so two
tabs left on different sheets each come back to their own after a refresh — something a single
URL cannot express.

The 🔗 button mints a link to the sheet you are on and copies it: `/s/kitchen-remodel`, named
from the title. Slugs are created the first time a sheet is shared rather than when it is
created, so the sheets you never send anyone — and every sheet still called "Untitled" — never
take a name. Two sheets with the same title get `budget` and `budget-2`.

Renaming a shared sheet mints a fresh link and **keeps the old one working**: every slug a sheet
has ever held stays pointed at it, so a link already sent to someone does not rot. A new sheet
can never be issued a retired slug, which would otherwise hijack that link.

Opening a share link loads that sheet and returns the address bar to `/`. The link is an input,
not a mirror of state — left up, it would start lying the moment the reader opened another sheet.

Copying needs a secure context. On an instance reached over plain HTTP the link is shown selected
for you to copy by hand instead.

The lock is advisory — the real protection is a version check on every save. If a sheet changed
while you were editing, the save is refused and you're shown **which lines differ**: what yours
has that the server's does not, and the other way round.

Three ways out. **Keep both** saves your version and puts the server's in a new sheet beside it,
so nothing is discarded — it leads because it is the only one that cannot lose work. **Keep
mine** and **Take the server's** each throw one version away, and say so.

### The password, if you want one

By default there is **no authentication**: anyone who can reach the port can read and edit every
sheet in every space. That remains the default, and for a trusted LAN it is the right one.

Setting `WEBCALC_PASSWORD` turns on one shared password for the whole instance:

```bash
WEBCALC_PASSWORD='something long' docker compose up -d
```

The app then asks for it before showing anything, and remembers the answer in a cookie for 30 days.
**Sign out** appears in the space menu. There are still no accounts — this is a door, not a login:
it says whether you may look at the sheets, while a space still only says which ones you are looking
at. Changing the password signs every browser out, since the password is what signs the cookie.

Two things it deliberately does not do. `/api/health` stays open, because the deploy's health gate
polls it and a check that needed a credential would fail every good deploy. And the cookie is not
marked `Secure`, because a self-hosted instance is usually reached over plain HTTP and marking it
would make signing in impossible there — so on plain HTTP the password crosses the network in the
clear. This raises the bar from "anyone who can reach the port" to "anyone who knows the password";
for more than that, put it behind a reverse proxy that terminates TLS and handles auth itself.

## Calculating outside the app

`POST /api/evaluate` answers a line the way a sheet would, without storing a sheet:

```bash
curl -X POST localhost:8422/api/evaluate -H 'content-type: application/json' \
  -d '{"input":"day rate * 3"}'
```

```json
{
  "results": [
    { "index": 0, "kind": "expression", "input": "day rate * 3", "output": "$1,650.00" }
  ],
  "total": "$1,650.00",
  "rateDate": "2026-08-14"
}
```

`input` is either a string, which is split on newlines, or an array of lines. Every line comes back
in order with its own answer, and a line that cannot be answered carries an `error` instead — the
request still succeeds, because one bad line in a sheet is not a bad sheet. Up to 1,000 lines per
call: evaluation is synchronous, so a longer one would hold the server up for everyone.

**It answers in a space.** The `webcalc_user` cookie picks the space, exactly as it does everywhere
else, and the globals, number region and time zone that apply are the ones that space's sheets
compute with. That is the point of the endpoint rather than a detail of it — `day rate * 3` has to
mean the same thing in a launcher, in a script and in a sheet, and it only can if all three read the
same settings. It also fetches any past exchange rates the lines ask for, which the browser cannot
do in one call.

### The `webcalc` command

The same thing from a shell, and the front end a launcher (Raycast, Alfred, Shortcuts) can call:

```bash
webcalc "5 hours 30 minutes in minutes"      # 330 minutes
webcalc 10 km in miles                       # 6.2137119224 miles — quoting optional
webcalc "subtotal = 480" -- "subtotal + 20%" --total
echo "100 USD in EUR" | webcalc
```

`--` separates one line from the next, so a several-line sheet is one invocation. One line prints
its answer bare, for `$(webcalc "…")`; several print in a column beside the lines they answer. A
line that could not be answered goes to stderr rather than stdout, and the exit status is 1 — so a
script can tell a wrong answer from no answer.

| Variable | Meaning |
| --- | --- |
| `WEBCALC_URL` | Instance to ask. Default `http://localhost:8422`; `--url` overrides. |
| `WEBCALC_SPACE` | Space whose globals apply. `--space` overrides. |
| `WEBCALC_PASSWORD` | Sent only after the instance has asked for it with a 401. |

It ships in the server workspace, so a deployed container already has it — asking itself on the
port it listens on inside the container rather than the one the host publishes:

```bash
docker exec -e WEBCALC_URL=http://127.0.0.1:8080 webcalc \
  node server/dist/webcalc.js "day rate * 3"
```

## Why a sheet is plain text

Everything in a sheet is text you typed, its formatting included: `1/3 to 2 dp` and
`100,000 in full` are written **into** the line rather than stored invisibly against it. Hidden
per-line state would not survive a copy, an export, a search, or a line being moved — and plain
text is what makes diffing two versions of a sheet possible at all.

That principle decided several things this does not do, which [docs/decisions.md](docs/decisions.md)
records along with the rest: which were **declined**, which are merely **deferred**, and which have
since been **reversed** on finding the reasoning was wrong.

## Development

Requires Node 22.5 or newer.

```bash
npm install
npm run dev     # API on :8080, UI on :5173 with hot reload
npm test        # 1,110 engine tests, 271 server tests, 53 web tests
npm run build   # build all three workspaces
```

`npm run coverage -w @webcalc/engine` prints which branches of the engine the tests have never
reached. Not part of `npm test` and not gated on a number: the list is worth reading now and again
and turning into cases, and instrumenting the fuzz sweep on every run costs more than it returns.

| Workspace | What it is |
| --- | --- |
| [engine/](engine/) | The calculation engine. Pure TypeScript, no DOM or Node APIs, covered by a golden table of `input → answer` cases in [engine/test/](engine/test/). |
| [web/](web/) | React + CodeMirror 6. Evaluation runs in the browser, so answers never wait on the network. Its tests cover the editor's *state* logic — CodeMirror keeps that separate from the view, so they run headlessly with no jsdom. |
| [server/](server/) | Fastify. Sheets in SQLite (through Node's built-in `node:sqlite` — no native modules), exchange rates, public holidays, settings, static hosting of the built UI, and the [`webcalc` command](#the-webcalc-command). It runs the engine too, behind `/api/evaluate`. |

### How the engine fits together

A line is classified, rewritten from natural phrasing into something math.js can parse,
evaluated, and formatted. Three parts sit outside that pipeline because math.js cannot express
what they need:

| Module | Why it exists |
| --- | --- |
| [`values.ts`](engine/src/values.ts) | Percentages, multipliers and rates as real types. `15%` reduced to `0.15` forgets it was a percentage, so `10% + 20%` could not answer `30%`. Also holds the unit-precedence rules — a bare number adopting the unit beside it, and mixed currencies answering in the last one named. |
| [`temporal/`](engine/src/temporal/) | Dates, clock times, durations, zones and timecode. math.js has no calendar type at all, so these are recognised and evaluated before the expression parser is reached. |
| [`numberFormat.ts`](engine/src/numberFormat.ts) | Region conventions and large-number notation, on both input and output. |
| [`historical.ts`](engine/src/historical.ts) | Converting money at a past date. Currency units are registered per math.js instance, so a table per date would mean an *instance* per date — too expensive to build per line. A dated conversion is self-contained, so it is done arithmetically instead. Evaluation is synchronous and fetching is not, so the engine reports which dates a sheet wants through `ratesNeeded` and the host supplies them. |

If you're adding syntax, the rewriters live in
[`preprocess.ts`](engine/src/preprocess.ts) and every phrasing needs a case in the golden table.

One thing sits beside that pipeline rather than in it.
[`tokenize.ts`](engine/src/tokenize.ts) answers *where* on a line each thing the engine
recognises is, which the pipeline cannot: it rewrites the text as it goes, so by the time a line
evaluates, the positions in the text the reader is looking at are gone. It reads a line through
the same predicates the classifier and the rewriters use — one rule for what a tag is, what an
aside is, what a label is — because the editor draws its
[highlighting](#highlighting) straight from the result, and a second opinion about what a token
is would show as a sheet coloured as though it meant something it does not. New syntax that
introduces a new kind of token belongs here as well as there.

### Adding to the reference

[`examples.ts`](engine/src/examples.ts) is the single source for both the in-app reference and
[`examples.test.ts`](engine/test/examples.test.ts), which evaluates every entry against a pinned
context and asserts the answer shown. An example cannot claim behaviour the engine lacks, because
the same line is a passing test — so adding to the documentation means adding a test.

## Deployment

The simplest deployment is the [Quick start](#quick-start) above: `docker compose up -d --build`
on whatever machine should host it. Everything below describes one *particular* way of automating
that, kept in the repository because it is what this project was built against — not because it
is the way you have to do it.

### The bundled pipeline

[`.gitea/workflows/deploy.yml`](.gitea/workflows/deploy.yml) deploys on every push to `main`. It
is written for [Gitea Actions](https://docs.gitea.com/usage/actions/overview) with a **self-hosted
runner on the target host itself**, which is why there is no registry and no SSH anywhere in it.

`runs-on:` names that runner's label. Change it to your own runner, or delete the file — nothing
else in the project depends on it. A fork on GitHub or GitLab will ignore it entirely, since
neither reads `.gitea/`.

The four steps are worth copying whatever CI you use:

1. **Test** — `docker build --target test` runs the whole suite inside the image, so the host
   needs no Node of its own and the tests run against the Node that actually ships. A failure
   here stops the deploy.
2. **Build** — the runtime image, reusing the layers the test stage just built.
3. **Deploy** — copies `docker-compose.prod.yml` to the deploy directory and brings the stack up
   with a pinned project name.
4. **Smoke test** — polls `/api/health` and fails the run with container logs if the app doesn't
   actually serve. A container that starts isn't the same as an app that works.

Docs-only pushes are skipped. The workflow can also be run by hand from the Actions tab.

`docker-compose.prod.yml` has no `build:` stanza — it only runs the image the runner built, so
the deploy directory never holds source. The compose project name is pinned to `webcalc` so the
sheets volume keeps its existing name; **renaming the project or the volume key would start the
app on an empty database.**

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port the server listens on inside the container |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `/data` | Directory holding `webcalc.db` |
| `STATIC_ROOT` | `/app/web/dist` | Built UI to serve |
| `TZ` | `UTC` | The **container's** clock: log timestamps, and which years of public holidays get fetched. It does **not** decide how sheets do date maths — that follows the reader's browser. See [Time zones and the clock](#time-zones-and-the-clock). |
| `HOLIDAY_COUNTRY` | `US` | ISO country code for public holidays in workday maths, for the whole instance |
| `SPACES` | one space, "Me" | Seeds [the spaces](#adding-and-removing-spaces) on an instance that has none. Ignored once it has any — spaces are managed in the app after that. |
| `WEBCALC_PASSWORD` | unset | One shared password for the whole instance. Unset — or blank — means no authentication, as before. See [The password, if you want one](#the-password-if-you-want-one). |

## Acknowledgement

The idea is [Soulver](https://soulver.app/)'s. Soulver created and refined the notepad
calculator — a sheet you type into line by line with the answers in a column beside it — and
most of what makes this app pleasant to use was worked out there first: unit assimilation, the
last-currency-wins rule, `sum` closing a section, `prev` and `line N`, per-line formatting
written into the line, and a good deal of the natural phrasing the engine accepts. Soulver's
own documentation was the specification this was built against, and it is cited throughout the
source where a rule came from there.

WebCalc is an independent implementation, not a port: no Soulver code was used, and it is not
affiliated with or endorsed by Soulver's makers. If you want the polished native original — with
the features [docs/decisions.md](docs/decisions.md) records as deliberately left out, and many
more — buy Soulver.

## License

MIT — see [LICENSE](LICENSE).
