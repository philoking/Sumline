import type { Lock, UserId } from './db.js';

/**
 * Something that changed on the server, worth telling an open browser about.
 *
 * The set is deliberately small and carries identifiers rather than payloads:
 * an event says *what moved*, and the client refetches the part it cares
 * about through the same endpoints it already uses. Sending the new sheet down
 * the stream would mean a second way for a sheet to arrive — one that skips
 * every filter, ordering rule and permission check the list endpoint applies.
 */
export type LiveEvent =
  /**
   * A sign of life on an idle stream, sent on a timer by the endpoint itself.
   *
   * A real event rather than the SSE comment this would conventionally be,
   * because a comment reaches no handler in the browser — and the client's one
   * defence against a proxy that accepts the connection and then buffers it is
   * noticing that nothing has arrived for a while. Silence has to be
   * distinguishable from quiet, so the quiet has to say something.
   */
  | { type: 'beat' }
  /**
   * Sent to each subscriber the moment it connects, and never again on that
   * connection.
   *
   * It is what makes a reconnect self-healing: a stream that dropped may have
   * missed anything, so the client treats this as "resync everything" rather
   * than trying to replay a gap it cannot see the edges of. It also proves the
   * stream is actually flowing, which a proxy that buffers would otherwise hide
   * behind a successful-looking connection.
   */
  | { type: 'hello'; rateDate: string }
  /** The sheets or folders one space can see have changed shape. */
  | { type: 'list'; owner: UserId }
  /** One sheet's text or title moved on. */
  | { type: 'sheet'; id: string; owner: UserId; version: number }
  /** A sheet gained, lost or changed its editor. Null means nobody holds it. */
  | { type: 'lock'; sheetId: string; holder: Lock | null }
  /** The rate table was refreshed — or a refresh failed and it is now stale. */
  | { type: 'rates'; date: string; stale: boolean }
  /** A space's settings changed. Null owner means the instance-wide tier. */
  | { type: 'settings'; owner: UserId | null };

export interface Subscriber {
  /** Which space this connection is working in, for scoping list events. */
  owner: UserId;
  send(event: LiveEvent): void;
  /** Ends the connection. Called when the server shuts down. */
  close(): void;
}

/**
 * Whether an event is any of this subscriber's business.
 *
 * Only `list` and `settings` are scoped, because only those describe a space's
 * own collection. A sheet and its lock are not: a share link reaches across
 * spaces, so a reader in one space can be sitting on a sheet owned by another
 * and still needs to know when its editor changes. The client filters those
 * against the sheet it has open, which it knows and the server does not.
 */
export function concerns(subscriber: Subscriber, event: LiveEvent): boolean {
  switch (event.type) {
    case 'list':
      return event.owner === subscriber.owner;
    case 'settings':
      // The instance-wide tier is inherited by every space, so a null owner
      // reaches all of them.
      return event.owner === null || event.owner === subscriber.owner;
    default:
      return true;
  }
}

/**
 * Fans server-side changes out to the browsers watching.
 *
 * In-process and deliberately so: this is one Fastify process over one SQLite
 * file, so every write that could interest anyone passes through this object on
 * its way out. Nothing here is persisted — a browser that was not connected
 * when something happened learns about it from `hello` on its next connect,
 * not from a replayed log.
 */
export class Events {
  private readonly subscribers = new Set<Subscriber>();

  /** How many browsers are listening. Used by the tests, and worth logging. */
  get size(): number {
    return this.subscribers.size;
  }

  /** Registers a listener and returns the function that removes it. */
  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /**
   * Tells everyone whose business it is.
   *
   * A subscriber whose socket has already gone throws on write rather than
   * failing quietly, and one dead connection must not stop the others being
   * told — so a throw drops that subscriber instead of the event.
   */
  emit(event: LiveEvent): void {
    for (const subscriber of [...this.subscribers]) {
      if (!concerns(subscriber, event)) continue;
      try {
        subscriber.send(event);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  /**
   * Ends every stream.
   *
   * Without this a shutdown waits on connections that are, by design, never
   * going to end on their own — which in a test run means a suite that hangs
   * rather than a server that stops.
   */
  closeAll(): void {
    for (const subscriber of [...this.subscribers]) {
      this.subscribers.delete(subscriber);
      try {
        subscriber.close();
      } catch {
        // Already gone. There is nothing left to close and nobody to tell.
      }
    }
  }
}

/**
 * One event as the `text/event-stream` wire format wants it.
 *
 * Named so the framing is in one place and testable: the blank line is the
 * record separator, and an event missing it is one the browser holds onto
 * silently rather than an error anyone sees.
 *
 * No `event:` line, so every one of these arrives at the browser's single
 * `message` handler and the kind is read out of the payload. Naming them on the
 * wire would read better under `curl` and cost a second list of the type names
 * on the client — one that would have to be kept in step with this union, and
 * whose drift would show up as an event that silently reaches nobody.
 */
export function frame(event: LiveEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
