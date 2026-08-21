/**
 * A calculator on the command line, answering in one of an instance's spaces.
 *
 * A client of `POST /api/evaluate` rather than a second host for the engine,
 * and deliberately so. The engine is pure and this file could carry it — but
 * then `day rate * 3` would answer from nothing, while the same line in a sheet
 * answers from the space's globals. The point of a launcher front end is that
 * the two agree, and the globals live on the server.
 *
 * Which means this needs no dependencies at all: a URL, a POST, and a printer.
 */

/** The port `docker-compose.yml` publishes, which is what the README uses. */
const DEFAULT_URL = 'http://localhost:8422';

const USAGE = `sumline — evaluate a line in a Sumline space

Usage:
  sumline "day rate * 3"          evaluate one line
  sumline line one -- line two    evaluate several lines as one sheet
  echo "…" | sumline              evaluate what is piped in

Options:
  --url <url>     instance to ask (default $SUMLINE_URL, else ${DEFAULT_URL})
  --space <id>    space whose globals apply (default $SUMLINE_SPACE)
  --json          print the API's response instead of the answers
  --total         print the sheet total after the answers
  -h, --help      this

Environment:
  SUMLINE_URL, SUMLINE_SPACE, SUMLINE_PASSWORD

Exit status is 1 when any line could not be answered, so a script can tell a
wrong answer from no answer.`;

interface Options {
  url: string;
  space: string | undefined;
  json: boolean;
  total: boolean;
  help: boolean;
  lines: string[];
}

interface EvaluatedLine {
  index: number;
  kind: string;
  input: string;
  output: string;
  error?: string;
}

interface EvaluateResponse {
  results: EvaluatedLine[];
  total: string;
}

/**
 * Reads the arguments, with `--` separating lines rather than joining them.
 *
 * Everything that is not an option is one line of the sheet, so quoting is the
 * shell's business and not this parser's: `sumline "10 + 5" -- "prev * 2"` is
 * two lines, and `sumline 10 + 5` is one.
 */
export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    url: process.env['SUMLINE_URL']?.trim() || DEFAULT_URL,
    space: process.env['SUMLINE_SPACE']?.trim() || undefined,
    json: false,
    total: false,
    help: false,
    lines: [],
  };

  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '--url':
        options.url = argv[++i] ?? options.url;
        break;
      case '--space':
        options.space = argv[++i] ?? options.space;
        break;
      case '--json':
        options.json = true;
        break;
      case '--total':
        options.total = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--':
        // Ends this line and starts the next; an empty one is still a line, so
        // a sheet can have a blank in it.
        options.lines.push(words.join(' '));
        words.length = 0;
        break;
      default:
        words.push(arg);
    }
  }
  if (words.length > 0 || options.lines.length > 0) options.lines.push(words.join(' '));
  return options;
}

/** Everything on stdin, or null when nothing is piped in. */
async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() === '' ? null : text.replace(/\n$/, '');
}

/**
 * Signs in, if the instance asks for a password and the environment has one.
 *
 * Returns the cookie header to send with everything after it. An instance with
 * no password never reaches this, because nothing has 401'd.
 */
async function signIn(url: string, password: string): Promise<string> {
  const response = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new Error('SUMLINE_PASSWORD was not accepted');
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('The instance accepted the password but sent no session');
  return cookie.split(';')[0] as string;
}

function cookieHeader(
  space: string | undefined,
  session: string | null,
): string | undefined {
  const parts = [
    ...(session ? [session] : []),
    ...(space ? [`sumline_user=${encodeURIComponent(space)}`] : []),
  ];
  return parts.length > 0 ? parts.join('; ') : undefined;
}

async function evaluate(
  options: Options,
  lines: string[],
  session: string | null,
): Promise<Response> {
  const cookie = cookieHeader(options.space, session);
  return fetch(`${options.url}/api/evaluate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie && { cookie }),
    },
    body: JSON.stringify({ input: lines }),
  });
}

/**
 * How a sheet reads on a terminal.
 *
 * One line in, one line out, positionally — which is what makes the output
 * usable from a script without parsing anything. A single line prints bare, so
 * `sumline "2+2"` inside a command substitution is just `4`.
 *
 * A single line that could not be answered prints nothing at all on stdout: a
 * script capturing the output would otherwise receive the complaint where it
 * expected the number, and act on it as though it were one. The message goes to
 * stderr, and the exit status says which happened.
 */
export function render(results: readonly EvaluatedLine[]): {
  out: string[];
  err: string[];
} {
  if (results.length === 1) {
    const only = results[0] as EvaluatedLine;
    return only.error ? { out: [], err: [only.error] } : { out: [only.output], err: [] };
  }
  // Aligned against the longest line, so the answers form a column the way they
  // do in the app. Errors sit in that column too, marked rather than hidden.
  const width = Math.max(...results.map((line) => line.input.length));
  const out = results.map((line) => {
    const answer = line.error ? `! ${line.error}` : line.output;
    return answer === '' ? line.input : `${line.input.padEnd(width)}  ${answer}`;
  });
  return { out, err: [] };
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const piped = options.lines.length === 0 ? await readStdin() : null;
  const lines = piped !== null ? piped.split('\n') : options.lines;
  if (lines.length === 0 || lines.every((line) => line.trim() === '')) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  let session: string | null = null;
  let response: Response;
  try {
    response = await evaluate(options, lines, session);
    /*
     * The password is only used once the instance has actually asked for it.
     * Sending it unprompted would mean every call to an open instance posting a
     * credential at a URL that may not be the one it was set for.
     */
    if (response.status === 401) {
      const password = process.env['SUMLINE_PASSWORD'];
      if (!password)
        throw new Error(`${options.url} needs a password; set SUMLINE_PASSWORD`);
      session = await signIn(options.url, password);
      response = await evaluate(options, lines, session);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`sumline: ${reason}\n`);
    return 1;
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    process.stderr.write(
      `sumline: ${body?.error ?? `${options.url} answered ${response.status}`}\n`,
    );
    return 1;
  }

  const body = (await response.json()) as EvaluateResponse;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } else {
    const { out, err } = render(body.results);
    for (const line of out) process.stdout.write(`${line}\n`);
    for (const line of err) process.stderr.write(`sumline: ${line}\n`);
    if (options.total && body.total !== '') process.stdout.write(`total ${body.total}\n`);
  }

  return body.results.some((line) => line.error) ? 1 : 0;
}
