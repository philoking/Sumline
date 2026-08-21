// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMenuKeys } from '../src/Popover';

/*
 * The keyboard a `role="menu"` promises.
 *
 * Three of the four menus in this app declared the role and handled no keys.
 * A screen reader tells its user the widget is a menu and its user then presses
 * Down, so a menu that ignores Down is worse than one that never claimed to be
 * one. These are the keys the pattern actually owes.
 */

function Menu({
  onClose,
  disableSecond = false,
}: {
  onClose: () => void;
  disableSecond?: boolean;
}) {
  const ref = useRef<HTMLUListElement | null>(null);
  const onKeyDown = useMenuKeys(ref, true, onClose);
  return (
    <ul role="menu" aria-label="Test" ref={ref} onKeyDown={onKeyDown}>
      <li role="none">
        <button type="button" role="menuitem">
          First
        </button>
      </li>
      <li role="none">
        <button type="button" role="menuitem" disabled={disableSecond}>
          Second
        </button>
      </li>
      <li role="none">
        <button type="button" role="menuitem">
          Third
        </button>
      </li>
    </ul>
  );
}

const focused = () => document.activeElement?.textContent;
const press = (key: string) => fireEvent.keyDown(screen.getByRole('menu'), { key });

afterEach(cleanup);

describe('useMenuKeys', () => {
  it('puts focus on the first item when the menu opens', () => {
    // A menu raised from the keyboard is no use if focus stays on the button
    // that raised it.
    render(<Menu onClose={() => {}} />);
    expect(focused()).toBe('First');
  });

  it('walks down and back up', () => {
    render(<Menu onClose={() => {}} />);
    press('ArrowDown');
    expect(focused()).toBe('Second');
    press('ArrowDown');
    expect(focused()).toBe('Third');
    press('ArrowUp');
    expect(focused()).toBe('Second');
  });

  it('wraps at both ends, which is what the pattern asks for', () => {
    render(<Menu onClose={() => {}} />);
    press('ArrowUp');
    expect(focused()).toBe('Third');
    press('ArrowDown');
    expect(focused()).toBe('First');
  });

  it('reaches either end directly', () => {
    render(<Menu onClose={() => {}} />);
    press('End');
    expect(focused()).toBe('Third');
    press('Home');
    expect(focused()).toBe('First');
  });

  it('steps over a disabled item rather than stopping on it', () => {
    // The view menu greys out "Bigger text" at maximum size. Landing there
    // would be a dead key press with no way to tell why.
    render(<Menu onClose={() => {}} disableSecond />);
    press('ArrowDown');
    expect(focused()).toBe('Third');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Menu onClose={onClose} />);
    press('Escape');
    expect(onClose).toHaveBeenCalled();
  });

  it('leaves other keys to the browser', () => {
    const onClose = vi.fn();
    render(<Menu onClose={onClose} />);
    press('Tab');
    expect(onClose).not.toHaveBeenCalled();
    expect(focused()).toBe('First');
  });
});
