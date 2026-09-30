import { useCallback, useEffect, useState } from 'react';

export interface ViewOptions {
  focusMode: boolean;
  expandMinions: boolean;
  disableMath: boolean;
  alwaysAutoScroll: boolean;
}

const STORAGE_KEY = 'chatViewOptions';

const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  focusMode: false,
  expandMinions: false,
  disableMath: false,
  alwaysAutoScroll: false,
};

function readViewOptions(): ViewOptions {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ViewOptions>;
    const options = { ...DEFAULT_VIEW_OPTIONS };
    for (const key of Object.keys(DEFAULT_VIEW_OPTIONS) as (keyof ViewOptions)[]) {
      if (typeof stored[key] === 'boolean') options[key] = stored[key];
    }
    return options;
  } catch {
    return { ...DEFAULT_VIEW_OPTIONS };
  }
}

/**
 * The chat's ⋯ view toggles, remembered across chats and reloads. Global on
 * purpose: they describe how you like to read, not a property of one chat.
 */
export function useViewOptions() {
  const [options, setOptions] = useState(readViewOptions);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    } catch {
      // Private mode or full storage: the toggles still work for this session
    }
  }, [options]);

  const toggle = useCallback((key: keyof ViewOptions) => {
    setOptions(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return { options, toggle };
}
