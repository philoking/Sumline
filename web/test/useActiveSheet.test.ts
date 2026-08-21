// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useActiveSheet } from '../src/useActiveSheet';
import { api, ConflictError, type Sheet } from '../src/api';

/*
 * What happens when this browser writes.
 *
 * `useSheetLock` decides whether it *may*; this decides what a save does and
 * what the two refusals look like. Between them they are the pair the review
 * called the highest-stakes code in the app, and both had no tests at all.
 *
 * jsdom per file, as in the lock suite, so the headless default stands.
 */

function sheetOf(overrides: Partial<Sheet> = {}): Sheet {
  return {
    id: 'sheet-1',
    title: 'Kitchen',
    content: 'tiles $40',
    version: 3,
    owner: 'me',
    color: null,
    folderId: null,
    deletedAt: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as Sheet;
}

function mount(activeId: string | null = 'sheet-1', canEdit = true) {
  const onStatus = vi.fn();
  const onError = vi.fn();
  const onNotice = vi.fn();
  const refreshSheets = vi.fn().mockResolvedValue(undefined);
  const view = renderHook(() =>
    useActiveSheet({
      activeId,
      canEdit,
      refreshSheets,
      folderOf: () => 'folder-1',
      onStatus,
      onError,
      onNotice,
    }),
  );
  return { ...view, onStatus, onError, onNotice, refreshSheets };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('opening a sheet', () => {
  it('loads the text and starts from a settled state', async () => {
    vi.spyOn(api, 'getSheet').mockResolvedValue(sheetOf() as never);
    const { result, onStatus } = mount();

    await act(async () => {
      await result.current.open('sheet-1');
    });

    expect(result.current.content).toBe('tiles $40');
    expect(result.current.version).toBe(3);
    // What the server last confirmed, which is what decides there is nothing
    // to save yet.
    expect(result.current.savedContent.current).toBe('tiles $40');
    expect(onStatus).toHaveBeenLastCalledWith('idle');
  });
});

describe('saving', () => {
  it('advances the version and remembers what the server confirmed', async () => {
    vi.spyOn(api, 'saveSheet').mockResolvedValue(
      sheetOf({ version: 4, content: 'tiles $50' }) as never,
    );
    const { result, onStatus, refreshSheets } = mount();

    await act(async () => {
      await result.current.save({ content: 'tiles $50' });
    });

    expect(result.current.version).toBe(4);
    expect(result.current.savedContent.current).toBe('tiles $50');
    expect(onStatus).toHaveBeenCalledWith('saving');
    expect(onStatus).toHaveBeenLastCalledWith('saved');
    // The sidebar has to catch up, or a renamed sheet keeps its old name.
    expect(refreshSheets).toHaveBeenCalled();
  });

  it('does nothing at all when no sheet is open', async () => {
    const save = vi.spyOn(api, 'saveSheet');
    const { result, onStatus } = mount(null);

    await act(async () => {
      await result.current.save({ content: 'anything' });
    });

    expect(save).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalledWith('saving');
  });

  it('hands back the server’s copy when the save is refused', async () => {
    // The important half of a conflict: not that the save failed, but that
    // what it would have overwritten is available to show.
    const theirs = sheetOf({ version: 9, content: 'tiles $99' });
    vi.spyOn(api, 'saveSheet').mockRejectedValue(new ConflictError(theirs));
    const { result, onStatus, onError } = mount();

    await act(async () => {
      await result.current.save({ content: 'tiles $50' });
    });

    expect(result.current.conflict?.content).toBe('tiles $99');
    expect(onStatus).toHaveBeenLastCalledWith('error');
    // A conflict is a disagreement, not a failure, so it is not reported as one.
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports any other failure as an error', async () => {
    vi.spyOn(api, 'saveSheet').mockRejectedValue(new Error('network gone'));
    const { result, onStatus, onError } = mount();

    await act(async () => {
      await result.current.save({ content: 'tiles $50' });
    });

    expect(onError).toHaveBeenCalled();
    expect(result.current.conflict).toBeNull();
    expect(onStatus).toHaveBeenLastCalledWith('error');
  });
});

describe('autosave', () => {
  it('saves once after the typing stops, not once per keystroke', async () => {
    vi.useFakeTimers();
    const save = vi
      .spyOn(api, 'saveSheet')
      .mockResolvedValue(sheetOf({ version: 4 }) as never);
    const { result, onStatus } = mount();

    act(() => {
      result.current.setContent('t');
    });
    act(() => {
      result.current.setContent('ti');
    });
    act(() => {
      result.current.setContent('til');
    });

    expect(onStatus).toHaveBeenCalledWith('unsaved');
    expect(save).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[1]).toEqual({ content: 'til' });
  });

  it('does not save while this browser is read-only', async () => {
    vi.useFakeTimers();
    const save = vi.spyOn(api, 'saveSheet');
    const { result } = mount('sheet-1', false);

    act(() => {
      result.current.setContent('typed while locked out');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(save).not.toHaveBeenCalled();
  });

  it('stops saving while a conflict is unresolved', async () => {
    // Autosaving into an unresolved conflict would overwrite the copy the
    // panel is offering to keep.
    vi.useFakeTimers();
    const save = vi
      .spyOn(api, 'saveSheet')
      .mockRejectedValue(new ConflictError(sheetOf({ version: 9 })));
    const { result } = mount();

    act(() => {
      result.current.setContent('mine');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(save).toHaveBeenCalledTimes(1);
    // Flushed by advancing rather than by `waitFor`, which waits on real timers
    // and would sit here until the test timed out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.conflict).not.toBeNull();

    act(() => {
      result.current.setContent('mine again');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('resolving a conflict', () => {
  it('copies the server’s version before overwriting it', async () => {
    /*
     * The order is the whole point. The copy is made first, so a failure to
     * create it leaves the server's version where it is rather than destroying
     * it on the way to preserving it.
     */
    const order: string[] = [];
    vi.spyOn(api, 'saveSheet').mockImplementation(async () => {
      order.push('overwrite');
      return sheetOf({ version: 10 }) as never;
    });
    vi.spyOn(api, 'createSheet').mockImplementation(async () => {
      order.push('copy');
      return sheetOf({ id: 'copy-1', title: 'Kitchen (conflicted copy)' }) as never;
    });
    vi.spyOn(api, 'saveSheet');

    const { result, onNotice } = mount();
    await act(async () => {
      await result.current.save({ content: 'mine' }).catch(() => undefined);
    });
    // Put it into conflict directly, which is what a refused save does.
    vi.spyOn(api, 'saveSheet').mockRejectedValueOnce(
      new ConflictError(sheetOf({ version: 9, content: 'theirs' })),
    );
    await act(async () => {
      await result.current.save({ content: 'mine' });
    });
    await waitFor(() => expect(result.current.conflict).not.toBeNull());

    vi.spyOn(api, 'saveSheet').mockImplementation(async () => {
      order.push('overwrite');
      return sheetOf({ version: 10 }) as never;
    });

    await act(async () => {
      await result.current.keepBoth();
    });

    expect(order.indexOf('copy')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('copy')).toBeLessThan(order.lastIndexOf('overwrite'));
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Nothing was lost'));
  });
});
