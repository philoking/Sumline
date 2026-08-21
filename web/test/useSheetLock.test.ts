// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useSheetLock, type Identity } from '../src/useSheetLock';
import { api, type Lock } from '../src/api';

/*
 * The first tests in this suite that render anything.
 *
 * Everything else here runs in `node` and is the better default: the editor
 * tests drive CodeMirror's state layer, which touches no DOM, and paying for
 * jsdom to prove that would be paying for nothing. Locking is different. It is
 * effects, timers and a `pagehide` listener, and it decides whether two people
 * can overwrite each other — the highest-stakes code in the browser and, until
 * now, the least covered. The environment is opted into per file rather than
 * switched on globally so the rest keeps running headless.
 */

const ME: Identity = { id: 'tab-1', name: 'Jason' };

/** A lock as the server reports one. */
function heldBy(clientId: string, clientName = clientId): Lock {
  return { sheetId: 'sheet-1', clientId, clientName, expiresAt: Date.now() + 45_000 };
}

function answer(granted: boolean, holder: Lock) {
  return { granted, lock: holder, ttlMs: 45_000 };
}

let acquire: MockInstance<typeof api.acquireLock>;
let release: MockInstance<typeof api.releaseLock>;

beforeEach(() => {
  acquire = vi.spyOn(api, 'acquireLock');
  release = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined as never);
});

afterEach(() => {
  // Explicit, because this config does not enable vitest globals and so the
  // library's own auto-cleanup never registers. Without it every hook stays
  // mounted for the rest of the file and its heartbeat keeps firing into the
  // next test, which is exactly how the pagehide case first "failed".
  cleanup();
  vi.restoreAllMocks();
});

/** The hook with a sheet already open, which is every case below. */
function open(activeId: string | null, live = true) {
  const onStatus = vi.fn();
  const view = renderHook(() => useSheetLock({ activeId, identity: ME, live, onStatus }));
  return { ...view, onStatus };
}

describe('claiming a sheet', () => {
  it('reports the grant and lets the app go about its business', async () => {
    acquire.mockResolvedValue(answer(true, heldBy('tab-1', 'Jason')) as never);
    const { result, onStatus } = open('sheet-1');

    await act(async () => {
      await result.current.claim('sheet-1');
    });

    expect(result.current.lock.granted).toBe(true);
    expect(onStatus).toHaveBeenCalledWith('idle');
  });

  it('reports a refusal as read-only, naming who has it', async () => {
    acquire.mockResolvedValue(answer(false, heldBy('tab-2', 'Kim')) as never);
    const { result, onStatus } = open('sheet-1');

    await act(async () => {
      await result.current.claim('sheet-1');
    });

    expect(result.current.lock.granted).toBe(false);
    expect(result.current.lock.holder?.clientName).toBe('Kim');
    expect(onStatus).toHaveBeenCalledWith('readonly');
  });

  it('drops an answer about a sheet that is no longer open', async () => {
    /*
     * The race this hook is most likely to get wrong. A claim is a round trip,
     * and the reader can pick a different sheet while it is in flight. Applying
     * the old sheet's answer would either grant an edit on a sheet somebody
     * else holds, or grey out one that is free.
     */
    let settle: (value: unknown) => void = () => {};
    acquire.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }) as never,
    );
    const onStatus = vi.fn();
    const { result, rerender } = renderHook(
      ({ activeId }: { activeId: string }) =>
        useSheetLock({ activeId, identity: ME, live: true, onStatus }),
      { initialProps: { activeId: 'sheet-1' } },
    );

    let claiming: Promise<void>;
    act(() => {
      claiming = result.current.claim('sheet-1');
    });

    // The reader moves on while the server is still answering.
    rerender({ activeId: 'sheet-2' });

    await act(async () => {
      settle(answer(true, heldBy('tab-1')));
      await claiming!;
    });

    // The answer was about sheet-1 and sheet-2 is open, so it is discarded.
    expect(result.current.lock.granted).toBe(false);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('forces the lock when told to, which is the take-over button', async () => {
    acquire.mockResolvedValue(answer(true, heldBy('tab-1')) as never);
    const { result } = open('sheet-1');

    await act(async () => {
      await result.current.claim('sheet-1', { force: true });
    });

    expect(acquire).toHaveBeenCalledWith('sheet-1', 'tab-1', 'Jason', true);
  });

  it('re-reads the sheet before handing over the editor', async () => {
    /*
     * `after` runs between the server's answer and this browser being told it
     * may edit. Taking over a sheet has to show the previous holder's saved
     * text, not the text this tab last saw, so the box is never editable while
     * it still shows something stale.
     */
    acquire.mockResolvedValue(answer(true, heldBy('tab-1')) as never);
    const order: string[] = [];
    const { result, onStatus } = open('sheet-1');
    onStatus.mockImplementation(() => order.push('status'));

    await act(async () => {
      await result.current.claim('sheet-1', {
        after: async () => {
          order.push('re-read');
        },
      });
    });

    expect(order).toEqual(['re-read', 'status']);
  });
});

describe('what the event stream says', () => {
  it('takes a sheet the moment the other tab lets it go', async () => {
    // Sitting read-only in front of a sheet, the holder closes their tab. The
    // stream says nobody holds it, and this browser must become editable then
    // rather than at the next thing the reader tries to do.
    acquire.mockResolvedValue(answer(true, heldBy('tab-1')) as never);
    const { result, onStatus } = open('sheet-1');

    await act(async () => {
      result.current.applyHolder('sheet-1', null);
    });

    await waitFor(() => expect(result.current.lock.granted).toBe(true));
    expect(onStatus).toHaveBeenCalledWith('idle');
    expect(onStatus).not.toHaveBeenCalledWith('readonly');
  });

  it('goes read-only when somebody else takes it', async () => {
    const { result, onStatus } = open('sheet-1');

    await act(async () => {
      result.current.applyHolder('sheet-1', heldBy('tab-2', 'Kim'));
    });

    expect(result.current.lock.granted).toBe(false);
    expect(onStatus).toHaveBeenCalledWith('readonly');
  });

  it('stays granted when the holder it names is this tab', async () => {
    const { result, onStatus } = open('sheet-1');

    await act(async () => {
      result.current.applyHolder('sheet-1', heldBy('tab-1', 'Jason'));
    });

    expect(result.current.lock.granted).toBe(true);
    expect(onStatus).not.toHaveBeenCalledWith('readonly');
  });

  it('ignores news about a sheet that is not open', async () => {
    const { result, onStatus } = open('sheet-1');

    await act(async () => {
      result.current.applyHolder('sheet-9', heldBy('tab-2', 'Kim'));
    });

    expect(onStatus).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe('letting go', () => {
  it('releases as the reader leaves the sheet', () => {
    const { result } = open('sheet-1');
    act(() => {
      result.current.release('sheet-1');
    });
    expect(release).toHaveBeenCalledWith('sheet-1', 'tab-1');
  });

  it('releases when the page goes away, in a request that outlives it', () => {
    // `pagehide` and `keepalive`, because an ordinary request started as the
    // page is torn down is never sent.
    const sent = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    open('sheet-1');

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(sent).toHaveBeenCalledWith(
      expect.stringContaining('/api/sheets/sheet-1/lock?clientId=tab-1'),
      expect.objectContaining({ method: 'DELETE', keepalive: true }),
    );
  });

  it('releases nothing on pagehide when no sheet is open', () => {
    const sent = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    open(null);
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    // Asserted against lock requests rather than against `fetch` being idle:
    // other things in a rendered tree may reach for it, and what matters is
    // that nothing was let go.
    const lockCalls = sent.mock.calls.filter(([url]) => String(url).includes('/lock'));
    expect(lockCalls).toEqual([]);
  });
});
