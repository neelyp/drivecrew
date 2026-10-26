// Checks on the HTML/CSS contract that the JavaScript relies on. These are not
// a substitute for using the app, but they catch the specific class of bug that
// shipped once: an element hidden with the `hidden` attribute while an author
// rule keeps it displayed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');

/** Selectors in the stylesheet that set a display other than none. */
function selectorsSettingDisplay() {
  const found = [];
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(css))) {
    const [, selector, body] = m;
    const display = /(?:^|;)\s*display\s*:\s*([^;!]+)/.exec(body);
    if (display && display[1].trim() !== 'none') {
      found.push({ selector: selector.trim(), display: display[1].trim() });
    }
  }
  return found;
}

test('the stylesheet forces the hidden attribute to win', () => {
  // Without this, `hidden` is silently ignored on anything with a display rule.
  assert.match(
    css,
    /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/,
    'css/app.css must contain [hidden] { display: none !important; }'
  );
});

test('the guard comes before any rule that sets display', () => {
  const guardAt = css.search(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.ok(guardAt >= 0, 'guard missing');
  // !important beats later rules regardless of order, but keeping it near the
  // top is what makes it findable; fail loudly if it drifts to the bottom.
  assert.ok(guardAt < css.length / 3, 'the guard should sit near the top of the file');
});

test('every element the markup hides is covered by the guard', () => {
  // Elements carrying the hidden attribute in the shipped HTML.
  const hiddenIds = [...html.matchAll(/<[^>]*id="([^"]+)"[^>]*\shidden[\s>]/g)].map((m) => m[1]);
  assert.ok(hiddenIds.includes('sheet'), 'expected #sheet to be hidden in the markup');

  // #sheet must either be covered by the global guard or carry its own rule.
  const guarded = /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css);
  assert.ok(guarded, `#sheet relies on the hidden attribute but nothing enforces it`);
});

test('the sheet overlay does set a display, which is why the guard is needed', () => {
  // This documents the trap rather than forbidding it: the overlay genuinely
  // needs display:flex to centre its panel.
  const sheetRule = selectorsSettingDisplay().find((r) => r.selector === '.sheet');
  assert.ok(sheetRule, '.sheet should still set a display');
  assert.equal(sheetRule.display, 'flex');
});

test('closing a sheet both hides it and empties it', () => {
  // Belt and braces: the overlay must not keep stale content around either.
  assert.match(ui, /host\.hidden = true/, 'close() must set hidden');
  assert.match(ui, /host\.innerHTML = ''/, 'close() must clear the panel');
});

test('the toast never intercepts taps', () => {
  // The toast is always in the layout, so it must not be clickable.
  const toastRule = /\.toast\s*\{([^}]*)\}/.exec(css);
  assert.ok(toastRule, '.toast rule missing');
  assert.match(toastRule[1], /pointer-events:\s*none/);
});
