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
git clone https://gitea.pkprivate.net/philoking/WebCalc.git webcalc
cd webcalc
docker compose up -d --build
```

Open <http://localhost:8422>. Sheets are stored in the `webcalc-data` volume and survive
restarts and rebuilds.

Set `TZ` so date maths resolves in your own timezone:

```bash
TZ=America/New_York docker compose up -d
```

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
the way Soulver does. Currency is always written out in full. The toggle in the top bar turns
abbreviation off if you'd rather see every digit.

Number conventions follow a region setting — `1.234,56` is read correctly under Western Europe,
and underscores group digits everywhere.

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
| `180 lbs in kg` | `81.646627 kg` |
| `meters in 10 km` | `10,000 meters` |
| `seconds in a day` | `86,400 seconds` |
| `5 hours 30 minutes to seconds` | `19,800 seconds` |
| `km m` | `1,000 m` |
| `300 + 20 km` | `320 km` |
| `1km + 1,000m` | `2 km` |

A bare number takes on the unit beside it, which Soulver calls unit assimilation.

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
| `100 USD in EUR` | `€86.45` |
| `20% of $250` | `$50.00` |
| `$100 + €80` | `€160.00` |

The figures above use the rates bundled with the image (14 August 2026); a running instance uses
whatever it last fetched, so your answers will differ.

Mixed currencies answer in the **last** one named, matching Soulver. Rates come from
[Frankfurter](https://frankfurter.dev/) (European Central Bank data, no API key), refreshed on
start and every 12 hours and cached to disk. A container with no internet access falls back to
the rates bundled in the image and marks them stale in the header.

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

A range answers in calendar components; `days between` answers in whole days. A date written
without a year picks whichever year puts it nearest today, so in December `January 12` is next
January. ISO dates (`2026-08-15`) are unambiguous; slashes read as month/day/year and dots as the
European day.month.year.

### Workdays

| You type | You get |
| --- | --- |
| `workdays in 3 weeks` | `15 workdays` |
| `10 March to 17 March in workdays` | `5 workdays` |
| `workdays from April 12 to June 15` | `45 workdays` |
| `today + 5 business days` | `Fri 21 Aug 2026` |

Public holidays are excluded. The list comes from [Nager.Date](https://date.nager.at/), refreshed
weekly and cached, with `HOLIDAY_COUNTRY` selecting the country. With no network it falls back to
a small bundled set of fixed-date holidays.

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

### Timestamps

| You type | You get |
| --- | --- |
| `April 1, 2019 to timestamp` | a Unix timestamp |
| `1559740303 to date` | `5 Jun 2019 at 6:11 am` |
| `1733823083000 to date` | milliseconds are detected by magnitude |
| `current timestamp` | now, in seconds |
| `April 1, 2019 3:30pm as iso8601` | `2019-04-01T15:30:00-07:00` |

Timestamps are absolute but the dates they render as are not: both the time shown and the offset
written by `as iso8601` follow the container's `TZ`. The examples above assume
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

### The total

The figure in the corner cycles between **total, average, count and median** when clicked, and
can be hidden. Both choices persist across sheets and browsers.

### Sheets

Sheets can be grouped into folders, searched by title or content, and are moved to a **trash**
when deleted rather than destroyed — restore them, or empty the trash to remove them for good.
Deleting a folder keeps its sheets and returns them to the top level. An untitled sheet names
itself from its first line.

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

Reordering inside a folder, and reordering while searching, only shuffle what you can see:
sheets outside the filter keep their positions exactly. Search results and the trash cannot be
reordered, since neither is a list whose order means anything.

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

### Global variables

Variables available to every sheet, set through `PUT /api/settings`:

```bash
curl -X PUT http://localhost:8422/api/settings \
  -H 'content-type: application/json' \
  -d '{"globals": {"day rate": "$550", "vat": "20%"}}'
```

A sheet can use them like any other variable, and can shadow one by declaring the same name.

## Spaces

Each person has their own space: their own sheets, folders, trash, settings and global
variables. The initial at the right-hand end of the top bar shows whose space you are in;
clicking it offers the others. The choice is kept in a cookie, so a machine stays on whoever
used it last. Every space gets its own Welcome sheet when it is created.

**This is not a login.** There are no passwords, and anyone who can reach the app can switch to
any space — the same footing as an instance with no authentication at all. It exists to keep two
people's sheets from piling up in one list, not to keep anyone out.

### Adding and removing people

From the space menu: **Add space…** creates one, and **Rename or remove…** turns the list into
an editable one. There is no limit on how many there are, and a fresh instance starts as a
one-person app called "Me" rather than assuming a second person exists.

`SPACES` **seeds** an instance that has none, which is the only thing it does — spaces then live
in the database, so one added in the app is not undone by the next deploy, and one removed does
not come back because the variable still names them:

```bash
SPACES="Jason,Kim"                   # ids derived from the names
SPACES="jason:Jason,kim:Kimberley"   # ids stated outright
```

Every sheet, folder and setting is stamped with a space's **id**, not its name, which is why the
two are separable. Renaming someone in the app changes only what is displayed. The `id:Name`
form matters when seeding an instance whose database already uses particular ids.

**Removing a space keeps its sheets.** They are not deleted — no space owns them any more, so
they drop out of every list, and adding a space back under the same id shows them again. The
app says how many went out of sight when you remove one, and the server logs any owner id it
finds with no space at startup. The last space cannot be removed, since every request has to
resolve to one.

Sheets that existed before spaces belong to the first space the instance ever had. An instance
upgraded from a version without them adopts the ids already stamped on its data, so nobody opens
the app to find their sheets gone.

A share link crosses spaces — that is the point of it. Opening someone else's link shows their
sheet, marked with a badge saying whose it is, and you can edit it under the usual lock. What
you cannot do from the other side is destroy it: trashing, purging, restoring, and renaming or
deleting a folder are refused unless the thing is yours, so following a link never puts you one
mis-click from deleting work that is not.

## Sharing and concurrent editing

Sheets live on the server, so any browser on your network sees the same set of *your* sheets.
When you open a sheet your browser takes a short-lived editing lock; anyone else who opens it
gets a read-only view naming who has it, plus a **Take over editing** button. With spaces in
play that banner names the person — "Kim is editing this sheet" — rather than their browser.

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
while you were editing, the save is refused and you're shown both versions to choose between,
rather than one of them being silently lost.

There is no authentication. Run it on a trusted network, or behind a reverse proxy that handles
auth.

## What's deliberately not here

Soulver does several things WebCalc does not, and their absence is a decision rather than an
oversight:

| Not included | Why |
| --- | --- |
| Sales tax, compound interest, loan repayments, inflation | Out of scope for how this instance is used. |
| Conditionals, number bases, bitwise operators, degree-mode trigonometry | Same. Worth knowing if that changes: math.js already returns `hex(256)` as `0x100` and parses `0x9F31`, so most of it is formatting rather than new maths. |
| Live stock prices, weather, knowledge lookups | Every usable provider needs an API key, which would compromise the guarantee that the container works with no internet access. |
| Trip planning (time points) | Soulver marks these outside the text. Sheets here are plain text — the property that makes copy, export, search and conflict-diffing work — so it would have needed invented syntax. |

Each has a closed milestone in the repository recording the reasoning.

The same principle explains a design choice you'll notice in the app: per-line formatting is
written **into** the line (`1/3 to 2 dp`, `100,000 in full`) rather than stored against it.
Hidden per-line state would not survive a copy, an export, or a line being moved.

## Development

Requires Node 22.5 or newer.

```bash
npm install
npm run dev     # API on :8080, UI on :5173 with hot reload
npm test        # 695 engine tests, 138 server tests
npm run build   # build all three workspaces
```

| Workspace | What it is |
| --- | --- |
| [engine/](engine/) | The calculation engine. Pure TypeScript, no DOM or Node APIs, covered by a golden table of `input → answer` cases in [engine/test/](engine/test/). |
| [web/](web/) | React + CodeMirror 6. Evaluation runs in the browser, so answers never wait on the network. |
| [server/](server/) | Fastify. Sheets in SQLite (through Node's built-in `node:sqlite` — no native modules), exchange rates, public holidays, settings, and static hosting of the built UI. |

### How the engine fits together

A line is classified, rewritten from natural phrasing into something math.js can parse,
evaluated, and formatted. Three parts sit outside that pipeline because math.js cannot express
what they need:

| Module | Why it exists |
| --- | --- |
| [`values.ts`](engine/src/values.ts) | Percentages, multipliers and rates as real types. `15%` reduced to `0.15` forgets it was a percentage, so `10% + 20%` could not answer `30%`. Also holds the unit-precedence rules — a bare number adopting the unit beside it, and mixed currencies answering in the last one named. |
| [`temporal/`](engine/src/temporal/) | Dates, clock times, durations, zones and timecode. math.js has no calendar type at all, so these are recognised and evaluated before the expression parser is reached. |
| [`numberFormat.ts`](engine/src/numberFormat.ts) | Region conventions and large-number notation, on both input and output. |

If you're adding syntax, the rewriters live in
[`preprocess.ts`](engine/src/preprocess.ts) and every phrasing needs a case in the golden table.

### Adding to the reference

[`examples.ts`](engine/src/examples.ts) is the single source for both the in-app reference and
[`examples.test.ts`](engine/test/examples.test.ts), which evaluates every entry against a pinned
context and asserts the answer shown. An example cannot claim behaviour the engine lacks, because
the same line is a passing test — so adding to the documentation means adding a test.

## Deployment

Pushing to `main` deploys automatically via [Gitea Actions](.gitea/workflows/deploy.yml). The
job runs on a self-hosted runner on the target host, so there is no registry and no SSH:

1. **Test** — `docker build --target test` runs the whole suite inside the image, so the host
   needs no Node of its own and the tests run against the Node that actually ships. A failure
   here stops the deploy.
2. **Build** — the runtime image, reusing the layers the test stage just built.
3. **Deploy** — copies `docker-compose.prod.yml` to `~/webcalc` and brings the stack up with a
   pinned project name.
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
| `TZ` | `UTC` | Timezone for date calculations |
| `HOLIDAY_COUNTRY` | `US` | ISO country code for public holidays in workday maths |
| `SPACES` | one space, "Me" | Seeds [the people who get a space](#adding-and-removing-people) on an instance that has none. Ignored once it has any — they are managed in the app after that. |

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
the features listed under [What's deliberately not here](#whats-deliberately-not-here), and many
more — buy Soulver.

## License

MIT — see [LICENSE](LICENSE).
