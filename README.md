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
git clone <this repo> webcalc
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

### Arithmetic

| You type | You get |
| --- | --- |
| `12 * 34` | `408` |
| `1,250 / 8` | `156.25` |
| `2^16` | `65,536` |
| `sqrt(144)` | `12` |
| `5k + 500` | `5,500` |
| `2 million / 4` | `500,000` |
| `10 plus 5 times 2` | `20` |
| `what is 6 * 7?` | `42` |

### Percentages

| You type | You get |
| --- | --- |
| `20% of 250` | `50` |
| `120 + 15%` | `138` |
| `200 - 10%` | `180` |
| `20% off 50` | `40` |
| `20% on 50` | `60` |
| `80 as a % of 200` | `40%` |

### Units

| You type | You get |
| --- | --- |
| `65 mph in km/h` | `104.60736 km/h` |
| `180 lbs in kg` | `81.646627 kg` |
| `2 hours + 45 minutes` | `2.75 hours` |
| `32 degF to degC` | `0 degC` |
| `1 GB in MB` | `1,000 MB` |

Any unit math.js knows works, plus everyday additions like `mph`, `kph`, `sqft` and `kcal`.

### Currency

| You type | You get |
| --- | --- |
| `$42.50 * 3` | `$127.50` |
| `100 USD in EUR` | `€86.45` |
| `£75 to USD` | `$101.53` |
| `20% of $250` | `$50.00` |

Rates come from [Frankfurter](https://frankfurter.dev/) (European Central Bank data, no API key),
refreshed on start and every 12 hours, and cached to disk. A container with no internet access
falls back to the rates bundled in the image and marks them stale in the header.

### Dates

| You type | You get |
| --- | --- |
| `today + 3 weeks` | `Sat 5 Sep 2026` |
| `2026-01-31 + 1 month` | `Sat 28 Feb 2026` |
| `next friday` | `Fri 21 Aug 2026` |
| `2026-01-01 to 2026-12-25` | `358 days` |
| `days until 2026-12-25` | `132 days` |
| `today + 5 business days` | `Fri 21 Aug 2026` |

Slash dates are read as month/day/year. ISO dates (`2026-08-15`) and written months
(`3 March 2026`) are unambiguous and preferred.

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
- `# Heading` starts a new section, `// comment` is ignored, and a label before a number is fine:
  `lunch $12` is twelve dollars.
- A running **Total** of every value line sits at the bottom of the answer column. It disappears
  when a sheet mixes things that can't be added, rather than showing a meaningless number.

## Sharing and concurrent editing

Sheets live on the server, so any browser on your network sees the same set. When you open a
sheet your browser takes a short-lived editing lock; anyone else who opens it gets a read-only
view naming who has it, plus a **Take over editing** button.

The lock is advisory — the real protection is a version check on every save. If a sheet changed
while you were editing, the save is refused and you're shown both versions to choose between,
rather than one of them being silently lost.

There is no authentication. Run it on a trusted network, or behind a reverse proxy that handles
auth.

## Development

Requires Node 22.5 or newer.

```bash
npm install
npm run dev     # API on :8080, UI on :5173 with hot reload
npm test        # engine golden tests + server API tests
npm run build   # build all three workspaces
```

| Workspace | What it is |
| --- | --- |
| [engine/](engine/) | The calculation engine. Pure TypeScript, no DOM or Node APIs, covered by a golden table of `input → answer` cases in [engine/test/](engine/test/). |
| [web/](web/) | React + CodeMirror 6 UI. Evaluation runs in the browser, so answers never wait on the network. |
| [server/](server/) | Fastify. Sheet storage in SQLite (via Node's built-in `node:sqlite` — no native modules), exchange-rate fetching, and static hosting of the built UI. |

The engine works by classifying each line, rewriting Soulver-style phrasing into an expression
math.js can parse, evaluating it, and formatting the result. If you're adding syntax, the
rewriters live in [engine/src/preprocess.ts](engine/src/preprocess.ts) and every phrasing gets a
case in the golden table.

Dates bypass math.js entirely — see [engine/src/dates.ts](engine/src/dates.ts).

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

## License

MIT — see [LICENSE](LICENSE).
