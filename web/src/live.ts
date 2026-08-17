import { useEffect, useRef, useState } from 'react';
import type { Lock } from './api';

/**
 * Something that changed on the server, as `GET /api/events` reports it.
 *
 * The mirror of the union in `server/src/events.ts`. Two copies rather than a
 * shared package because this is a wire format between two workspaces that
 * already exchange JSON over a dozen endpoints without sharing their types —
 * and the shape is checked where it arrives, in `parseLiveEvent`, which is what
 * actually protects this end from a server that says something else.
 */
export type LiveEvent =
  | { type: 'beat' }
  | { type: 'hello'; rateDate: string }
  | { type: 'list'; owner: string }
  | { type: 'sheet'; id: string; owner: string; version: number }
  | { type: 'lock'; sheetId: string; holder: Lock | null }
  | { type: 'rates'; date: string; stale: boolean }
  | { type: 'settings'; owner: string | null };

/**
 * How long the stream may say nothing before it is treated as not flowing.
 *
 * Two heartbeats and a bit, so one late beat on a slow connection does not
 * count as a failure while a genuinely stalled stream is noticed inside a
 * minute. See `EVENT_HEARTBEAT_MS` on the server for the other half.
 */
export const STALE_MS = 45_000;

/**
 * Reads one event off the wire, or nothing.
 *
 * Nothing rather than a throw for anything unrecognised: a server one deploy
 * ahead may send an event this build has never heard of, and the right response
 * to that is to ignore it rather than to tear down the stream. The shape of
 * each known kind is checked, because everything the caller does with one of
 * these — refetch this sheet, believe this lock holder — is only as sound as
 * the fields being what they claim.
 */
export function parseLiveEvent(data: string): LiveEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const event = value as Record<string, unknown>;

  switch (event['type']) {
    case 'beat':
      return { type: 'beat' };
    case 'hello':
      return typeof event['rateDate'] === 'string'
        ? { type: 'hello', rateDate: event['rateDate'] }
        : null;
    case 'list':
      return typeof event['owner'] === 'string'
        ? { type: 'list', owner: event['owner'] }
        : null;
    case 'sheet':
      return typeof event['id'] === 'string' &&
        typeof event['owner'] === 'string' &&
        typeof event['version'] === 'number'
        ? {
            type: 'sheet',
            id: event['id'],
            owner: event['owner'],
            version: event['version'],
          }
        : null;
    case 'lock':
      return typeof event['sheetId'] === 'string'
        ? {
            type: 'lock',
            sheetId: event['sheetId'],
            // Null is the meaningful case here — it says nobody is editing —
            // so anything that is not a lock-shaped object is read as none.
            holder: isLock(event['holder']) ? event['holder'] : null,
          }
        : null;
    case 'rates':
      return typeof event['date'] === 'string'
        ? { type: 'rates', date: event['date'], stale: event['stale'] === true }
        : null;
    case 'settings':
      return typeof event['owner'] === 'string' || event['owner'] === null
        ? { type: 'settings', owner: event['owner'] as string | null }
        : null;
    default:
      return null;
  }
}

function isLock(value: unknown): value is Lock {
  if (typeof value !== 'object' || value === null) return false;
  const lock = value as Record<string, unknown>;
  return typeof lock['sheetId'] === 'string' && typeof lock['clientId'] === 'string';
}

/**
 * Watches the server for changes, and says whether it is actually hearing them.
 *
 * The return value is the point of the hook as much as the events are. A
 * connection that opened proves nothing — a proxy that buffers responses will
 * accept one happily and then hold every event until the stream ends, which for
 * a stream designed never to end is forever. So "flowing" means a message has
 * arrived recently, not that a socket exists, and a caller that gets `false`
 * knows to fall back to asking.
 *
 * `onEvent` is read through a ref, so a handler rebuilt on every render — which
 * is the normal case, since it closes over the sheet that is open — does not
 * tear down and reopen the stream underneath it.
 */
export function useLive(enabled: boolean, onEvent: (event: LiveEvent) => void): boolean {
  const [flowing, setFlowing] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    // Absent in a non-browser environment, and in a browser old enough that the
    // rest of this app would not run either. Falling back to the polls costs
    // liveness rather than function.
    if (typeof EventSource === 'undefined') return;

    const source = new EventSource('/api/events');
    let lastMessage = Date.now();

    source.onmessage = (message: MessageEvent<string>) => {
      lastMessage = Date.now();
      setFlowing(true);
      const event = parseLiveEvent(message.data);
      // `beat` has done its whole job by arriving.
      if (event && event.type !== 'beat') handler.current(event);
    };

    // EventSource reconnects on its own, so this is a report rather than a
    // decision: the caller starts polling until messages come back.
    source.onerror = () => setFlowing(false);

    const watchdog = setInterval(() => {
      if (Date.now() - lastMessage > STALE_MS) setFlowing(false);
    }, STALE_MS / 3);

    return () => {
      clearInterval(watchdog);
      source.close();
      setFlowing(false);
    };
  }, [enabled]);

  return flowing;
}
