import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Lock } from './api';

/**
 * Who this browser is, as far as the lock is concerned.
 *
 * A client id per tab and a name to show the other one, neither of which is a
 * login: the lock is advisory and the real protection is the version check on
 * every save.
 */
export interface Identity {
  id: string;
  name: string;
}

export interface LockState {
  granted: boolean;
  holder: Lock | null;
}

/**
 * How long a lock is assumed to last until the server says otherwise.
 *
 * The server's own default, and replaced by the `ttlMs` it reports with every
 * grant — because it is configurable there and a browser that guessed short
 * would ask about a lock that is still perfectly alive.
 */
const LOCK_TTL_GUESS_MS = 45_000;

/** How often the editing browser renews the lock it is holding. */
const LOCK_HEARTBEAT_MS = 15_000;

/**
 * A margin over the stated life, so a lock renewed a moment before it lapsed
 * is not asked about in the gap between the two.
 */
const EXPIRY_MARGIN_MS = 2_000;

export interface SheetLock {
  lock: LockState;
  /**
   * Asks for the lock on a sheet and records the answer.
   *
   * `after` runs between the server's answer and this browser being told what
   * it may do, which is what the take-over path needs: the sheet is re-read
   * first, so the box is never editable while it still shows the text the
   * previous holder was working on.
   */
  claim(
    sheetId: string,
    options?: { force?: boolean; after?: () => Promise<unknown> },
  ): Promise<void>;
  /** Lets a sheet go, on the way out of it. */
  release(sheetId: string): void;
  /** Believes what the server has just said about who is editing. */
  applyHolder(sheetId: string, holder: Lock | null): void;
}

/**
 * Everything that decides whether this browser may edit the open sheet.
 *
 * It was four effects, two refs and a callback spread across 220 lines of
 * `App.tsx`, each individually sound and each explaining itself in a paragraph
 * — and the combination was the hardest thing in the app to hold in your head,
 * in the one place where a mistake costs somebody an edit.
 *
 * Nothing here is new. The pieces are:
 *
 *  - **claim**, on opening a sheet, and **release** on the way out;
 *  - **release on `pagehide`**, through a bare `fetch` with `keepalive`,
 *    because the ordinary one will not outlive the page;
 *  - **a heartbeat** while this tab holds it, and — only when the event stream
 *    is down — while it does not;
 *  - **a one-shot re-ask** timed to the holder's expiry, for the tab that
 *    crashed, slept or lost its network and so never said it was letting go;
 *  - **applyHolder**, which claims a lock the stream says nobody holds.
 *
 * `onStatus` is how the lock speaks to the rest of the app, and it is
 * deliberately not called from everywhere. A grant is announced whenever it
 * arrives; a refusal only when the sheet was just opened or somebody else has
 * taken it. The heartbeat announces nothing at all, because it fires every
 * fifteen seconds while someone is typing and "idle" would wipe the unsaved
 * and saving states out from under them.
 */
export function useSheetLock(options: {
  activeId: string | null;
  identity: Identity;
  /** Whether the event stream is flowing, which decides what needs polling. */
  live: boolean;
  onStatus: (status: 'idle' | 'readonly') => void;
}): SheetLock {
  const { activeId, identity, live, onStatus } = options;

  const [lock, setLock] = useState<LockState>({ granted: false, holder: null });
  const ttl = useRef(LOCK_TTL_GUESS_MS);

  /**
   * Which sheet is open, readable from a callback that has already resolved.
   *
   * These handlers start requests and act on what comes back, by which time
   * the selection may have moved on — and applying an answer about the
   * previous sheet to the current one is worse than not answering at all.
   */
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  /**
   * The latest `onStatus`, so the effects below do not restart when the
   * component rebuilds it — which is every render.
   */
  const announce = useRef(onStatus);
  announce.current = onStatus;

  /** What the server just said, and who should hear about it. */
  const record = useCallback(
    (result: { granted: boolean; lock: Lock; ttlMs: number }, say: 'both' | 'granted') => {
      ttl.current = result.ttlMs;
      setLock({ granted: result.granted, holder: result.lock });
      if (result.granted) announce.current('idle');
      else if (say === 'both') announce.current('readonly');
    },
    [],
  );

  const claim = useCallback(
    async (
      sheetId: string,
      { force = false, after }: { force?: boolean; after?: () => Promise<unknown> } = {},
    ) => {
      const result = await api.acquireLock(sheetId, identity.id, identity.name, force);
      if (after) await after();
      // The selection can move while the server is answering, and a lock
      // belonging to the sheet that was open a moment ago says the wrong thing
      // about the one that is open now.
      if (sheetId !== activeRef.current) return;
      record(result, 'both');
    },
    [identity.id, identity.name, record],
  );

  const release = useCallback(
    (sheetId: string) => {
      void api.releaseLock(sheetId, identity.id).catch(() => undefined);
    },
    [identity.id],
  );

  /**
   * Believes what the server says about who is editing the open sheet.
   *
   * Nobody holding it is not a neutral fact to note. This browser has the
   * sheet on screen and is sitting read-only in front of it, so a lock that
   * has just been let go is claimed — which is what turns "another browser is
   * editing this sheet" back into an editable sheet the moment the other tab
   * closes, rather than at the next thing you tried to do.
   */
  const applyHolder = useCallback(
    (sheetId: string, holder: Lock | null) => {
      if (sheetId !== activeRef.current) return;
      if (holder === null) {
        void api
          .acquireLock(sheetId, identity.id, identity.name)
          .then((result) => {
            if (sheetId !== activeRef.current) return;
            record(result, 'granted');
          })
          .catch(() => undefined);
        return;
      }
      const mine = holder.clientId === identity.id;
      setLock({ granted: mine, holder });
      if (!mine) announce.current('readonly');
    },
    [identity.id, identity.name, record],
  );

  /*
   * Letting go when the page goes away.
   *
   * `pagehide` rather than `unload`, and `keepalive` rather than the ordinary
   * request, because a request started as the page is torn down does not
   * otherwise survive long enough to be sent.
   */
  useEffect(() => {
    const letGo = () => {
      if (!activeId) return;
      const url = `/api/sheets/${activeId}/lock?clientId=${encodeURIComponent(identity.id)}`;
      void fetch(url, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    };
    window.addEventListener('pagehide', letGo);
    return () => window.removeEventListener('pagehide', letGo);
  }, [activeId, identity.id]);

  /*
   * Hold the lock while this tab is the editor — and, when the event stream is
   * not flowing, watch for it while this tab is not.
   *
   * Holding it means renewing it before it lapses, always: the stream can say
   * that someone else has taken the lock, but nothing can renew it on this
   * browser's behalf. *Not* holding it is the case that had no poll at all,
   * which is why a banner about a tab closed ten minutes ago stayed up until
   * you tried to type. The stream now answers that in a moment, so this runs
   * only as its fallback.
   */
  useEffect(() => {
    if (!activeId) return;
    if (!lock.granted && live) return;
    const timer = setInterval(() => {
      void api
        .acquireLock(activeId, identity.id, identity.name)
        .then((result) => {
          // Silently: this fires while someone is typing, and telling the app
          // it is idle would erase what the save status was saying.
          ttl.current = result.ttlMs;
          setLock({ granted: result.granted, holder: result.lock });
        })
        .catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [activeId, lock.granted, live, identity.id, identity.name]);

  /*
   * Ask again at the moment the lock being waited on would have lapsed.
   *
   * A tab that closes properly says so, and the stream passes that straight on
   * — which is what makes the read-only banner clear itself in a moment rather
   * than at the next thing you tried to do. A tab that crashes, sleeps or
   * loses its network says nothing at all, and then the only thing that frees
   * the sheet is the lock ageing out, quietly, in the store, with nobody to
   * tell.
   *
   * So a read-only tab asks once, timed to that expiry, rather than polling.
   * If the holder is still there the answer carries a fresh lock and this
   * schedules itself again; if it is gone, the sheet becomes editable here.
   */
  useEffect(() => {
    if (!activeId || lock.granted || !lock.holder) return;
    const timer = setTimeout(() => {
      void api
        .acquireLock(activeId, identity.id, identity.name)
        .then((result) => {
          if (activeId !== activeRef.current) return;
          record(result, 'granted');
        })
        .catch(() => undefined);
    }, ttl.current + EXPIRY_MARGIN_MS);
    return () => clearTimeout(timer);
  }, [activeId, lock.granted, lock.holder, identity.id, identity.name, record]);

  return { lock, claim, release, applyHolder };
}
