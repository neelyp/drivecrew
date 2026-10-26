// Small DOM helpers. No framework: screens render to HTML strings and events
// are delegated from one listener per screen.

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Delegated listener: one handler for a whole screen. */
export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const match = e.target.closest(selector);
    if (match && root.contains(match)) handler(e, match);
  });
}

let toastTimer = null;
export function toast(message, ms = 2600) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

/** Bottom sheet. Returns a close function. */
export function openSheet(innerHtml, { onMount } = {}) {
  const host = $('#sheet');
  host.innerHTML = `<div class="sheet-panel" role="dialog" aria-modal="true">${innerHtml}</div>`;
  host.hidden = false;
  const panel = $('.sheet-panel', host);

  const close = () => {
    host.hidden = true;
    host.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  host.onclick = (e) => {
    if (e.target === host) close();
  };
  on(panel, 'click', '[data-close]', close);
  onMount?.(panel, close);
  const focusable = panel.querySelector('input, select, textarea, button');
  focusable?.focus();
  return close;
}

export function confirmSheet({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, close) => {
      settled = true;
      close();
      resolve(value);
    };
    openSheet(
      `<h2>${esc(title)}</h2>
       <p class="muted">${body}</p>
       <div class="btn-row">
         <button class="btn" data-act="no">Cancel</button>
         <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="yes">${esc(confirmLabel)}</button>
       </div>`,
      {
        onMount(panel, close) {
          on(panel, 'click', '[data-act="yes"]', () => finish(true, close));
          on(panel, 'click', '[data-act="no"]', () => finish(false, close));
          const host = $('#sheet');
          const prior = host.onclick;
          host.onclick = (e) => {
            if (e.target === host && !settled) {
              settled = true;
              resolve(false);
            }
            prior?.(e);
          };
        },
      }
    );
  });
}

export function statRow(items) {
  return `<dl class="stats${items.length % 3 === 0 ? ' three' : ''}">${items
    .map(
      (it) => `<div class="stat">
        <dt>${esc(it.label)}</dt>
        <dd class="num">${it.value}${it.unit ? `<span class="u">${esc(it.unit)}</span>` : ''}</dd>
      </div>`
    )
    .join('')}</dl>`;
}

/** Scale a canvas for the device pixel ratio and return its 2D context. */
export function fitCanvas(canvas, cssHeight) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 320;
  const h = cssHeight || canvas.clientHeight || 120;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export function cssVar(name, fallback = '') {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Today", "Yesterday", "Tuesday", or a date for anything older. */
export function friendlyDay(ms) {
  const then = new Date(ms);
  const today = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(then)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return DAY_NAMES[then.getDay()];
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const clockTime = (ms) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export const fullDate = (ms) =>
  new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });

export function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
