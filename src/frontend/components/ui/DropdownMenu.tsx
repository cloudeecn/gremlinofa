import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useOverlay } from '../../hooks/useOverlay';

const CloseMenuContext = createContext<() => void>(() => {});

const ITEM_SELECTOR = '[role^="menuitem"]:not(:disabled)';

interface DropdownMenuProps {
  /** Accessible name and tooltip of the trigger */
  label: string;
  /** Trigger glyph (⋯, 🔧) */
  icon: ReactNode;
  /** For a caller that hands focus back to the trigger later (ChatView after Chat Settings) */
  buttonRef?: RefObject<HTMLButtonElement | null>;
  /** Placement classes for the wrapper, e.g. a negative margin against the header edge */
  className?: string;
  children: ReactNode;
}

/**
 * Header action menu: an icon trigger and a right-aligned panel. Closes on
 * an item, a click outside, or Escape (through `useOverlay`, which returns
 * focus to the trigger). Arrow keys, Home and End move between items.
 */
export function DropdownMenu({ label, icon, buttonRef, className, children }: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const ownButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = buttonRef ?? ownButtonRef;

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  useOverlay({
    active: isOpen,
    onEscape: () => {
      setIsOpen(false);
      triggerRef.current?.focus();
    },
    containerRef: panelRef,
  });

  const close = useCallback(() => setIsOpen(false), []);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    // -1 while the panel itself has focus (just opened)
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = (current + 1) % items.length;
    else next = current <= 0 ? items.length - 1 : current - 1;
    items[next].focus();
  };

  return (
    <div ref={rootRef} className={`relative shrink-0 ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
      >
        <span className="text-xl">{icon}</span>
      </button>
      {isOpen && (
        // z-30: above sticky list bars and the chat scrubber (z-10/z-20),
        // below the mobile drawer (z-40) and modals
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          className="absolute top-full right-0 z-30 mt-1 w-52 rounded-lg border border-gray-200 bg-white py-1 shadow-lg outline-none"
        >
          <CloseMenuContext.Provider value={close}>{children}</CloseMenuContext.Provider>
        </div>
      )}
    </div>
  );
}

interface DropdownMenuItemProps {
  icon?: ReactNode;
  /**
   * Makes this a checkbox item: ✓ in the icon column, and the menu stays
   * open so several toggles can be flipped in a row. Action items close it.
   */
  checked?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  onSelect: () => void;
  children: ReactNode;
}

export function DropdownMenuItem({
  icon,
  checked,
  disabled,
  destructive,
  onSelect,
  children,
}: DropdownMenuItemProps) {
  const close = useContext(CloseMenuContext);
  const isCheckbox = checked !== undefined;
  const colors = destructive ? 'text-red-600 hover:bg-red-50' : 'text-gray-700 hover:bg-gray-100';

  return (
    <button
      type="button"
      role={isCheckbox ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={isCheckbox ? checked : undefined}
      disabled={disabled}
      onClick={() => {
        if (!isCheckbox) close();
        onSelect();
      }}
      className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm outline-none focus-visible:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${colors}`}
    >
      <span aria-hidden="true" className="w-5 shrink-0 text-center">
        {isCheckbox ? (checked ? '✓' : '') : icon}
      </span>
      <span>{children}</span>
    </button>
  );
}

export function DropdownMenuSeparator() {
  return <div role="separator" className="my-1 border-t border-gray-200" />;
}
