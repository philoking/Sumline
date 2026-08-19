# Sumline

A notepad calculator you run yourself, in the browser.

<img width="2900" height="1792" alt="Sumline-08-19-2026_01_17_PM" src="https://github.com/user-attachments/assets/704b0aac-74bb-4c97-9873-687a66dac65c" />

Type in plain language on the left; answers appear in a column on the right, updating as you
type. Units, currencies, percentages, dates, variables and running totals all work the way you'd
write them on paper.

```
groceries $86.40 #home              $86.40
train fare $12.80 #travel           $12.80
electricity $94.10 #home            $94.10
sum                                $193.30
sum #home                          $180.50
```

Nothing above is a special mode. A line the engine doesn't recognize is left as plain text with
no answer, so notes, headings and sums mix freely in one sheet.

## Quick start

```bash
git clone https://github.com/philoking/Sumline.git sumline
cd sumline
docker compose up -d --build
```

Open <http://localhost:8422>. Sheets live in the `sumline-data` volume and survive restarts and
rebuilds. Date math resolves in **your browser's** timezone, so `today` is your today wherever
the instance is hosted.

That is the whole installation. Everything below is why it works that way.

## What it does

Press `?` in the app for the full syntax reference — every example in it is a passing test, so it
cannot claim behavior the engine lacks. A taste of what that covers (dates relative to a Saturday
in August 2026):

| You type | You get |
| --- | --- |
| `12 * 34` | `408` |
| `20% of 250` | `50` |
| `10 km in miles` | `6.2137119224 miles` |
| `100 USD in EUR` | `€80.00` |
| `5 hours 30 minutes in minutes` | `330 minutes` |
| `next friday` | `Fri 21 Aug 2026` |
| `today + 3 weeks` | `Sat 5 Sep 2026` |
| `3 workdays from today` | `Wed 19 Aug 2026` |

Plus variables (`day rate = 550`), references to earlier lines (`prev`, `line 3`), tags that
subtotal across a sheet (`#home`), per-line formatting written into the line (`1/3 to 2 dp`), and
a running total in the corner that cycles between total, average, count and median.

## Why it exists

Soulver is the app that worked this idea out, and it is a good one. Sumline exists because a
notepad calculator that lives on one Mac is a document, and some of us wanted a *service* — one
instance on the network, every browser reaching the same sheets, no syncing and no per-device
license. That single decision is where nearly every difference below comes from.

### How it differs from Soulver

|  | Sumline | Soulver |
| --- | --- | --- |
| Runs on | Any browser, against a container you host | Native apps for Mac, iPhone and iPad |
| Where sheets live | On the server, in one SQLite volume | In a `.sheetbook` file on the device |
| Between devices | Every browser reaches one instance, so there is nothing to sync | iCloud sync across your own Apple devices |
| More than one person | What it is built for | One person, across their own devices |
| The engine | math.js, evaluated in the browser | Soulver's own |

Because it is a server rather than a document, it gains things a single-user app has no reason
to have: **spaces** (separate sets of sheets, settings and global variables, for two people or
for one person keeping Work and Personal apart), **live updates** over an event stream, an
**editing lock** with a conflict panel that shows which lines differ rather than picking a
winner, **share links** where every slug a sheet has ever held keeps working, and an
**HTTP API and CLI** so a launcher and a sheet agree about what `day rate * 3` means.

<img width="2900" height="1792" alt="Sumline Spaces" src="https://github.com/user-attachments/assets/564d8037-11c8-434f-a1ea-f13e2cdd293e" />

And it loses things a native app can do: no conditionals or branching, no live weather or stock
prices, nothing that needs an API key, and nothing native — no Alfred, no Services, no iOS. The
engine accepts the phrasings Soulver documents; inventing more was a decision, not an oversight,
because every guess is a rule to maintain and rules collide.

### Why a sheet is plain text

Everything in a sheet is text you typed, its formatting included: `1/3 to 2 dp` and
`100,000 in full` are written **into** the line rather than stored invisibly against it.

This is the constraint the rest of the design answers to. Hidden per-line state would not survive
a copy, an export, a search, or a line being moved — and plain text is what makes diffing two
versions of a sheet possible, which is what the conflict panel needs to exist at all. It is also
why some features are absent: marking a line as a "time point" through a menu would be state
living outside the text.

### Why it works offline

Exchange rates and public holidays are the only two network dependencies. Both were picked for
needing no API key, and both fall back to bundled data, so the container works with no internet
at all. That rules out live weather and stock prices, which is a trade made on purpose.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port the server listens on inside the container |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `/data` | Directory holding `sumline.db` |
| `STATIC_ROOT` | `/app/web/dist` | Built UI to serve |
| `TZ` | `UTC` | The **container's** clock: log timestamps, and which years of public holidays get fetched. It does **not** decide how sheets do date math, which follows the reader's browser. |
| `HOLIDAY_COUNTRY` | `US` | ISO country code for public holidays in workday math |
| `SPACES` | one space, "Me" | Seeds the spaces on an instance that has none. Ignored once it has any. |
| `SUMLINE_PASSWORD` | unset | One shared password for the whole instance. Unset or blank means no authentication. |

### About that password

By default there is **no authentication**: anyone who can reach the port can read and edit every
sheet. For a trusted LAN that is the right default, and it stays the default.

Setting `SUMLINE_PASSWORD` turns on one shared password — a door, not a login. There are still no
accounts; a space says which sheets you are looking at, not whether you may. Ten wrong answers
from one address buys a five-minute wait. The cookie is deliberately not marked `Secure`, because
a self-hosted instance is usually plain HTTP and marking it would make signing in impossible
there — so on plain HTTP the password crosses the network in the clear. For more than that, put
it behind a reverse proxy that terminates TLS.

Found a hole? [SECURITY.md](SECURITY.md) says how to report it.

## Deployment

The Quick start above *is* the deployment: `docker compose up -d --build` on whatever machine
should host it.

[`.gitea/workflows/deploy.yml`](.gitea/workflows/deploy.yml) automates that for one particular
setup — [Gitea Actions](https://docs.gitea.com/usage/actions/overview) with a self-hosted runner
on the target host, which is why there is no registry and no SSH in it. Point `runs-on:` at your
own runner or delete the file; nothing else depends on it, and GitHub and GitLab ignore `.gitea/`
entirely. The shape worth copying whatever CI you use: run the suite inside the image, build,
bring the stack up, then poll `/api/health` and fail loudly with logs — a container that starts
is not the same as an app that serves.

`docker-compose.prod.yml` pins the compose project name to `sumline` so the sheets volume keeps
its name. **Renaming the project or the volume key would start the app on an empty database.**

## Development

Requires Node 22.5 or newer.

```bash
npm install
npm run dev     # API on :8080, UI on :5173 with hot reload
npm test
npm run build
```

| Workspace | What it is |
| --- | --- |
| [engine/](engine/) | The calculation engine. Pure TypeScript, no DOM or Node APIs, covered by a golden table of `input → answer` cases. |
| [web/](web/) | React + CodeMirror 6. Evaluation runs in the browser, so answers never wait on the network. |
| [server/](server/) | Fastify. Sheets in SQLite through Node's built-in `node:sqlite`, exchange rates, holidays, settings, and the `sumline` CLI. |

[CONTRIBUTING.md](CONTRIBUTING.md) covers what a change has to do to land — chiefly that a
documented example *is* a test, since [`examples.ts`](engine/src/examples.ts) is the single source
for both the in-app reference and the suite that pins it.

## Acknowledgment

The idea is [Soulver](https://soulver.app/)'s. Soulver created and refined the notepad
calculator, and most of what makes this pleasant to use was worked out there first: unit
assimilation, the last-currency-wins rule, `sum` closing a section, `prev` and `line N`, per-line
formatting written into the line, and a good deal of the natural phrasing the engine accepts.
Soulver's own [documentation](https://documentation.soulver.app/) was the specification this was
built against, and it is cited throughout the source where a rule came from there.

Sumline is an independent implementation, not a port: no Soulver code was used, and it is not
affiliated with or endorsed by Soulver's makers. If you want the polished native original, with
many features this deliberately leaves out, buy Soulver.

## License

MIT. See [LICENSE](LICENSE).
