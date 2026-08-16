'use client';

import { useRef } from 'react';
import { useServerInsertedHTML } from 'next/navigation';

/** Apply day/night before paint to avoid theme flash / hydration mismatch noise. */
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var pref = localStorage.getItem('summitThemePref') || 'auto';
    if (pref !== 'day' && pref !== 'night' && pref !== 'auto') pref = 'auto';
    var hour = new Date().getHours();
    var mode =
      pref === 'day'
        ? 'day'
        : pref === 'night'
          ? 'night'
          : hour >= 19 || hour < 7
            ? 'night'
            : 'day';
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.style.colorScheme = mode === 'night' ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'day');
    document.documentElement.style.colorScheme = 'light';
  }
})();
`;

/**
 * Injects the theme boot script into the SSR HTML stream so it is not part of
 * the client React tree (React 19 never executes <script> inside components).
 */
export default function ThemeInit() {
  const inserted = useRef(false);
  useServerInsertedHTML(() => {
    if (inserted.current) return null;
    inserted.current = true;
    return (
      <script
        id="summit-theme-init"
        dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
      />
    );
  });
  return null;
}
