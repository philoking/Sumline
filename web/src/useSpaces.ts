import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { api, type User } from './api';

export interface Spaces {
  /** Every space on this instance, in switcher order. */
  users: User[];
  /** Which one this browser is working in, until the first load says. */
  space: string | null;
  setUsers: Dispatch<SetStateAction<User[]>>;
  setSpace: Dispatch<SetStateAction<string | null>>;
  /** The name shown on the badge, which is a space's and not a person's. */
  currentName: string;
  add(name: string): Promise<void>;
  rename(user: User, name: string): Promise<void>;
  remove(user: User): Promise<void>;
}

/**
 * Who has a space here, and the three things that can be done about it.
 *
 * A space is not necessarily a person — it may be Work, School, or one client
 * of several — which is why the switcher names spaces rather than users and
 * why removing one is not deleting anybody.
 *
 * Asking is left to the caller, as it is in `useSheetList`: `add` takes a name
 * and `remove` takes a decision already made. The wording of that decision is
 * the interesting part and belongs with the interface (#99), while what to do
 * once it is made belongs here.
 */
export function useSpaces(options: {
  onError: (cause: unknown) => void;
  onNotice: (message: string) => void;
}): Spaces {
  const { onError, onNotice } = options;

  const [users, setUsers] = useState<User[]>([]);
  const [space, setSpace] = useState<string | null>(null);

  const currentName = users.find((user) => user.id === space)?.name ?? '';

  const add = useCallback(
    async (name: string) => {
      try {
        const created = await api.createSpace(name);
        setUsers((current) => [...current, created]);
      } catch (cause) {
        onError(cause);
      }
    },
    [onError],
  );

  const rename = useCallback(
    async (user: User, name: string) => {
      if (name === '' || name === user.name) return;
      try {
        const renamed = await api.renameSpace(user.id, name);
        setUsers((current) =>
          current.map((entry) => (entry.id === user.id ? renamed : entry)),
        );
      } catch (cause) {
        onError(cause);
      }
    },
    [onError],
  );

  /**
   * Removes a space, and says plainly what became of its sheets.
   *
   * They are kept, not deleted, and adding the space back under the same name
   * brings them into view again — so what follows says that, rather than the
   * usual "cannot be undone", which would be untrue and would make this feel
   * more dangerous than it is.
   *
   * How much is affected is only known server-side: the sheet list in the
   * browser holds the current space's sheets and nobody else's, so the count
   * comes back with the deletion rather than being guessed at beforehand.
   */
  const remove = useCallback(
    async (user: User) => {
      try {
        const { hidden } = await api.deleteSpace(user.id);
        if (hidden > 0) {
          onNotice(
            `“${user.name}” is gone from the switcher. ${hidden} ${
              hidden === 1 ? 'sheet or folder is' : 'sheets and folders are'
            } still stored, and adding “${user.name}” back will show them again.`,
          );
        }
        if (user.id === space) {
          // Staying on a space that no longer exists would show someone else's
          // sheets under this person's name until the next reload.
          window.location.reload();
          return;
        }
        setUsers((current) => current.filter((entry) => entry.id !== user.id));
      } catch (cause) {
        onError(cause);
      }
    },
    [space, onError, onNotice],
  );

  return { users, space, setUsers, setSpace, currentName, add, rename, remove };
}
