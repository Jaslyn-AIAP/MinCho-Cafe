// =============================================================================
// theme.js — light / dark switch (shared by the order page and admin page)
// -----------------------------------------------------------------------------
// Default: follow the phone's own light/dark setting.
// Tapping Light or Dark overrides it and is remembered on this device.
// Loaded in <head> WITHOUT `defer` so the saved choice applies before the page
// is drawn (no flash of the wrong theme). The colours themselves live in
// styles.css under :root[data-theme="light" | "dark"].
// =============================================================================
(() => {
  'use strict';
  const KEY = 'mincho_theme';
  const root = document.documentElement;
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const save = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode: ignore */ } };

  const saved = read();
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;

  // Which theme is showing right now (explicit choice, else the phone's setting)
  const current = () => root.dataset.theme
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  function sync() {
    document.querySelectorAll('[data-set-theme]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.setTheme === current()));
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-set-theme]').forEach((b) => {
      b.addEventListener('click', () => {
        root.dataset.theme = b.dataset.setTheme;
        save(b.dataset.setTheme);
        sync();
      });
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);
    sync();
  });
})();
