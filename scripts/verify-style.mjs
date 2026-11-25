// Machine check for the editor's design system.
//
// v3. Widened by T-08 after T-07 found the offence v2 could not see:
// `src/styles/_global.css` drew `*:focus-visible { outline: 2px solid
// var(--color-accent) }` with `--color-accent: #caff3a`, a lime ring around
// every focused control in Creator, Production, Templates and the nav — and
// v2 reported "neutral grayscale" throughout, because its scan was two
// hardcoded directory names under `src/labels`. Everything the starter
// template loaded on every screen was outside the check.
//
// The fix is not a longer list of directories. A list goes stale the moment
// someone adds a page, which is how the hole opened in the first place. v3
// computes WHAT SHIPS: it walks the import graph from src/main.jsx through
// JS/JSX imports and CSS @imports, and checks exactly the files that reach a
// browser. Anything under src/ the walk does not reach is dead, listed by
// name, and frozen — reviving a dead file fails the check rather than
// quietly re-admitting whatever colour it carries.
//
// v2's refutation, kept because the hole was the exact class of bug the check
// exists to prevent:
//
//   * It found selectors with `css.split('}')` and dropped any chunk
//     starting with '@'. That made the FIRST rule inside every at-rule
//     invisible, so appending `@media print { div { padding: 3mm } }` to
//     editor.css passed all six assertions - while actually turning a
//     one-page print into two pages and wiping every barcode bar.
//   * It read exactly two hardcoded source files, so a third stylesheet,
//     a JSX inline style, or a hardcoded colour in the element model was
//     invisible. A lime #caff3a on every rect element lived there
//     undetected while the check reported "neutral grayscale" green.
//   * It looked only for `#hex`, so rgb()/hsl()/named colours slipped past.
//
// v3 walks braces properly, unwraps :is()/:where(), and scans every SHIPPED
// stylesheet, every shipped JS/JSX file and every shipped SVG asset. Run it
// against the source AND, with --dist, against the built CSS.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';

const ENTRY = 'src/main.jsx';
const SRC = 'src';
const DIST = 'dist/assets';

// ---------------------------------------------------------------- graph --
// Resolve one relative specifier the way Vite would: exact file, then the
// usual extensions, then directory/index. Bare specifiers (react, zustand)
// are dependencies, not our code, and are ignored.
const EXTS = ['', '.jsx', '.js', '.css', '.svg', '.json'];

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const clean = spec.split('?')[0];
  const base = resolve(dirname(fromFile), clean);
  for (const e of EXTS) {
    const p = base + e;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  for (const i of ['index.jsx', 'index.js']) {
    const p = join(base, i);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

function specsIn(file, src) {
  const out = [];
  if (file.endsWith('.css')) {
    // url(...) imports point at fonts on a CDN, not at our files.
    for (const m of src.matchAll(/@import\s+['"]([^'"]+)['"]/g)) out.push(m[1]);
  } else {
    for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
    for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g))
      out.push(m[1]);
    for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))
      out.push(m[1]);
  }
  return out;
}

const shipped = new Set();
(function walk(file) {
  const abs = resolve(file);
  if (shipped.has(abs)) return;
  shipped.add(abs);
  if (!/\.(jsx?|css)$/.test(abs)) return; // an asset is a leaf
  const src = readFileSync(abs, 'utf8');
  for (const spec of specsIn(abs, src)) {
    const next = resolveSpec(abs, spec);
    if (next) walk(next);
  }
})(ENTRY);

const rel = (p) => relative(process.cwd(), p).split(sep).join('/');

// Everything under src/ that the walk did not reach.
const onDisk = [];
(function scan(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) scan(p);
    // Test files are entered by vitest, not by main.jsx. They are not dead
    // code and listing them as such would make the dead list meaningless.
    else if (/\.(jsx?|css|svg)$/.test(e.name) && !/\.test\.jsx?$/.test(e.name))
      onDisk.push(resolve(p));
  }
})(SRC);

const dead = onDisk
  .filter((p) => !shipped.has(p))
  .map(rel)
  .sort();

const shippedOf = (re) =>
  [...shipped]
    .filter((p) => re.test(p))
    .map(rel)
    .sort();

const sheets = shippedOf(/\.css$/).map((p) => ({
  path: p,
  css: readFileSync(p, 'utf8'),
}));
const codeFiles = shippedOf(/\.jsx?$/).map((p) => ({
  path: p,
  src: readFileSync(p, 'utf8'),
}));
const svgFiles = shippedOf(/\.svg$/).map((p) => ({
  path: p,
  src: readFileSync(p, 'utf8'),
}));

if (process.argv.includes('--dist') && existsSync(DIST)) {
  for (const f of readdirSync(DIST).filter((x) => x.endsWith('.css'))) {
    sheets.push({
      path: join(DIST, f),
      css: readFileSync(join(DIST, f), 'utf8'),
    });
  }
}

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Walk the stylesheet by brace depth and return every STYLE RULE selector,
// including rules nested inside @media / @supports / @layer. This is the
// fix for the hole that let a bare `div` inside @media print through.
function selectorsOf(css) {
  const s = strip(css);
  const out = [];
  let buf = '';
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      const head = buf.trim();
      buf = '';
      if (head.startsWith('@')) {
        // A conditional group rule still CONTAINS style rules - descend.
        stack.push('at');
      } else {
        stack.push('rule');
        for (const sel of head.split(',')) if (sel.trim()) out.push(sel.trim());
      }
    } else if (ch === '}') {
      stack.pop();
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

// Every style rule as { selector, body }, so a check can ask what a rule
// DECLARES and not only what it matches.
function rulesOf(css) {
  const s = strip(css);
  const out = [];
  let buf = '';
  const stack = [];
  let bodyStart = -1;
  let heads = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      const head = buf.trim();
      buf = '';
      if (head.startsWith('@')) stack.push({ kind: 'at' });
      else {
        stack.push({ kind: 'rule', depthAtOpen: stack.length });
        if (stack.filter((x) => x.kind === 'rule').length === 1) {
          heads = head
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
          bodyStart = i + 1;
        }
      }
    } else if (ch === '}') {
      const top = stack.pop();
      if (
        top &&
        top.kind === 'rule' &&
        stack.filter((x) => x.kind === 'rule').length === 0 &&
        heads
      ) {
        const body = s.slice(bodyStart, i);
        for (const h of heads) out.push({ selector: h, body });
        heads = null;
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return out;
}

// `:is(img)` / `:where(svg)` reach exactly as far as a bare element would.
const unwrap = (sel) => sel.replace(/:(?:is|where)\(([^)]*)\)/g, '$1');

const NAMED = [
  'red',
  'green',
  'blue',
  'lime',
  'orange',
  'purple',
  'yellow',
  'pink',
  'teal',
  'cyan',
  'magenta',
  'brown',
  'navy',
  'olive',
  'maroon',
  'aqua',
  'fuchsia',
  'gold',
  'coral',
  'salmon',
  'crimson',
  'indigo',
  'violet',
];

function rgbOf(value) {
  let m = value.match(/#([0-9a-fA-F]{3,8})\b/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4)
      h = h
        .slice(0, 3)
        .split('')
        .map((c) => c + c)
        .join('');
    return [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((x) =>
      parseInt(x, 16),
    );
  }
  m = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  m = value.match(/hsla?\(\s*([\d.]+)[deg]*[\s,]+([\d.]+)%/);
  if (m) return +m[2] === 0 ? [0, 0, 0] : null; // saturation 0 is grey; anything else is a hue
  return null;
}

const assertions = [];
const check = (name, pass, detail) => assertions.push({ name, pass, detail });

// --- 0. what ships is what is checked -----------------------------------
// The frozen dead list. These files exist under src/ and no import reaches
// them, so nothing they contain can appear on a screen. They are the starter
// template's demo pages and its React logo. Reviving one puts its CSS and
// its colours back into the bundle, so the revival has to be a deliberate,
// reviewed act - this assertion makes it one.
const DEAD_EXPECTED = [
  // Empty in the public copy: the starter template's unused demo pages,
  // hooks and store scaffolding were deleted rather than frozen.
];
const revived = DEAD_EXPECTED.filter((f) => !dead.includes(f));
const newlyDead = dead.filter((f) => !DEAD_EXPECTED.includes(f));
check(
  'the import graph from src/main.jsx still reaches the same files, and no dead file has been revived',
  revived.length === 0 && newlyDead.length === 0,
  {
    entry: ENTRY,
    shippedSheets: sheets
      .filter((s) => !s.path.startsWith(DIST))
      .map((s) => s.path),
    shippedCode: codeFiles.length,
    shippedSvg: svgFiles.map((s) => s.path),
    dead,
    revived,
    newlyDead,
  },
);

// --- 1. every colour in every shipped stylesheet is a true neutral -------
// --brand-accent / --brand-accent-hover are the declared brand-accent exceptions
// (brand.css), and --lbl-danger is the design system's destructive token.
const EXCEPT = ['--lbl-danger', '--brand-accent', '--brand-accent-hover'];
const nonNeutral = [];
let colourCount = 0;
for (const { path, css } of sheets) {
  for (const m of strip(css).matchAll(
    /(--[a-z0-9-]+\s*:|[a-z-]+\s*:)\s*([^;{}]*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))[^;{}]*)/g,
  )) {
    const prop = m[1].replace(/:$/, '').trim();
    if (EXCEPT.includes(prop)) continue;
    const rgb = rgbOf(m[2]);
    if (!rgb) continue;
    colourCount++;
    const [r, g, b] = rgb;
    if (!(r === g && g === b))
      nonNeutral.push(`${path} :: ${prop}: ${m[2].trim()}`);
  }
  for (const n of NAMED) {
    if (new RegExp(`:\\s*${n}\\b`).test(strip(css)))
      nonNeutral.push(`${path} :: named colour "${n}"`);
  }
}
check(
  'every colour in every shipped stylesheet is a true neutral (R=G=B)',
  nonNeutral.length === 0,
  {
    stylesheets: sheets.map((s) => s.path),
    coloursParsed: colourCount,
    exceptions: EXCEPT,
    offenders: nonNeutral,
  },
);

// --- 2. no hardcoded colour in any shipped JS/JSX ------------------------
// This is where the lime #caff3a hid: a default fill in elements.js, which
// no stylesheet check could ever have seen - and it PRINTS.
const codeColours = [];
for (const { path, src: raw } of codeFiles) {
  // `var(--lbl-danger, #b42318)` is the ONE declared exception wearing its
  // CSS fallback. The token is the source of truth; the fallback repeating
  // its value is not a second colour. Everything else is fair game.
  const src = raw.replace(
    /var\(\s*--lbl-danger\s*,[^)]*\)/g,
    'var(--lbl-danger)',
  );
  // 3- and 4-digit hex too. `#0f0` is exactly as green as `#00ff00`, and a
  // reviewer proved the previous pattern could not see it: setting the rect
  // default to '#0f0' in elements.js passed all six assertions.
  // Longest alternatives first so `#00ff00` never matches as `#00f`.
  for (const m of src.matchAll(
    /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g,
  )) {
    const rgb = rgbOf(m[0]);
    if (rgb && rgb[0] === rgb[1] && rgb[1] === rgb[2]) continue;
    codeColours.push(`${path} :: ${m[0]}`);
  }
}
check(
  'no non-grey colour hardcoded in any shipped component or model file',
  codeColours.length === 0,
  { filesScanned: codeFiles.length, offenders: codeColours },
);

// --- 3. light theme only, across every shipped stylesheet ----------------
const dark = sheets
  .filter((s) => /prefers-color-scheme/.test(s.css))
  .map((s) => s.path);
check(
  'no prefers-color-scheme block in any shipped stylesheet',
  dark.length === 0,
  { offenders: dark },
);

// --- 4. nothing can reach into the printed label -------------------------
// print.css hides everything except .print-root, so any rule whose first
// simple selector is an ELEMENT still applies inside it. This now sees
// inside @media/@supports, which is exactly what v1 missed.
//
// The two starter-template global sheets are exempt HERE and answered by
// assertion 7 instead: a reset is bare element selectors by definition, so
// this rule would only ever report the fact that they exist. Assertion 7
// freezes WHICH elements they may style, which is the part that matters.
const GLOBAL_RESETS = ['src/styles/_normalize.css', 'src/styles/_global.css'];
const bare = [];
for (const { path, css } of sheets) {
  // print.css is the print system itself: its `body > *` is deliberate and
  // load-bearing - it takes the app chrome out of flow so one label prints
  // as one page. The rule being enforced here is that the DESIGN SYSTEM
  // must not reach into the print tree, so its own sheet is exempt.
  if (path.endsWith('print.css')) continue;
  if (GLOBAL_RESETS.includes(path)) continue;
  for (const raw of selectorsOf(css)) {
    const sel = unwrap(raw);
    if (sel === ':root' || sel.startsWith('%')) continue;
    const head = sel.split(/[\s>+~]/)[0].trim();
    if (!head) continue;
    if (head.startsWith('.') || head.startsWith('#') || head.startsWith('['))
      continue;
    if (head.startsWith(':') && !/^:(is|where)/.test(head)) continue; // :root-like, harmless
    bare.push(`${path} :: ${raw}`);
  }
}
check(
  'no rule outside the global resets - including inside @media/@supports - starts with a bare element selector',
  bare.length === 0,
  {
    offenders: bare,
    exempt: [...GLOBAL_RESETS, 'src/labels/styles/print.css'],
  },
);

// --- 5. the chrome namespace is respected --------------------------------
const editorCss = sheets.find((s) => s.path.endsWith('editor.css'));
const classes = [
  ...new Set(
    [...strip(editorCss.css).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]),
  ),
];
const stray = classes.filter(
  (c) => !c.startsWith('lbl-') && !c.startsWith('labels-'),
);
check(
  'every class is namespaced lbl-* (chrome) or labels-* (canvas)',
  stray.length === 0,
  { classCount: classes.length, stray },
);

// --- 6. every class defined is actually used -----------------------------
// `.lbl-spacer` was written to stop the toolbar wrapping, defined, and then
// never referenced in any JSX - so the bug it was written for shipped. The
// corpus is now every shipped JS/JSX file, not only src/labels: a class used
// solely by a page under src/pages used to read as unused.
const allSrc = codeFiles.map((f) => f.src).join('\n');
const unused = classes.filter(
  (c) => c.startsWith('lbl-') && !new RegExp(`['"\\s]${c}['"\\s]`).test(allSrc),
);
check(
  'every lbl-* class defined in CSS is actually used in the components',
  unused.length === 0,
  { unused },
);

// --- 7. the global resets reach only the elements they always reached ----
// _normalize.css and _global.css are loaded on every screen and style bare
// elements by design. That is tolerable only while the SET of elements is
// the reviewed one: print.css hides everything except .print-root, so a new
// bare rule here lands inside the printed label. `img` is on this list and
// is load-bearing - Barcode.jsx relies on _global.css's img{max-width:100%}
// - which is exactly why the list is frozen rather than forbidden.
//
// Adding a selector here is not automatically wrong. It is automatically
// UNREVIEWED, and a label is printed on stock that costs EUR 0.5 a piece
// when it comes out wrong.
const RESET_ALLOWLIST = {
  'src/styles/_normalize.css': [
    '::-webkit-file-upload-button',
    '[hidden]',
    "[type='button']:-moz-focusring",
    "[type='button']::-moz-focus-inner",
    "[type='checkbox']",
    "[type='number']::-webkit-inner-spin-button",
    "[type='number']::-webkit-outer-spin-button",
    "[type='radio']",
    "[type='reset']:-moz-focusring",
    "[type='reset']::-moz-focus-inner",
    "[type='search']::-webkit-search-decoration",
    "[type='submit']:-moz-focusring",
    "[type='submit']::-moz-focus-inner",
    'a',
    'abbr[title]',
    'b',
    'body',
    'button',
    'button:-moz-focusring',
    'button::-moz-focus-inner',
    'code',
    'details',
    'fieldset',
    'h1',
    'hr',
    'html',
    'img',
    'input',
    'kbd',
    'legend',
    'main',
    'optgroup',
    'pre',
    'progress',
    'samp',
    'select',
    'small',
    'strong',
    'sub',
    'summary',
    'sup',
    'template',
    'textarea',
  ],
  'src/styles/_global.css': [
    '*',
    '*::after',
    '*::before',
    '*:focus-visible',
    'blockquote',
    'body',
    'dd',
    'dl',
    'figure',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'html',
    'img',
    "ol[role='list']",
    'p',
    "ul[role='list']",
  ],
};
const resetDrift = [];
for (const path of GLOBAL_RESETS) {
  const sheet = sheets.find((s) => s.path === path);
  if (!sheet) {
    resetDrift.push(
      `${path} :: sheet no longer ships - remove it from GLOBAL_RESETS`,
    );
    continue;
  }
  const heads = new Set();
  for (const raw of selectorsOf(sheet.css)) {
    const head = unwrap(raw)
      .split(/[\s>+~]/)[0]
      .trim();
    if (head && !/^[.#]/.test(head) && head !== ':root') heads.add(head);
  }
  const allowed = new Set(RESET_ALLOWLIST[path] ?? []);
  for (const h of heads)
    if (!allowed.has(h))
      resetDrift.push(
        `${path} :: new bare selector "${h}" reaches the print tree`,
      );
}
check(
  'the global resets style only the frozen, reviewed set of bare elements',
  resetDrift.length === 0,
  { allowlist: RESET_ALLOWLIST, drift: resetDrift },
);

// --- 8. the red budget ---------------------------------------------------
// The brandbook rule: the accent colour is the CTA colour; a decorative device is rejected
// there because at high alpha it "would eat the red budget and compete with
// the CTA". So: at most ONE red element per screen, and never a heading.
//
// The wordmark does not spend the budget - it is identity, not accent. If it
// did, no screen carrying the logo could ever have a red CTA, which is the
// opposite of what the styleguide describes. Owner confirmed the as-built
// spend on 25.08.2026 (Contract.md R-08-b).
//
// One stylesheet is taken as one screen. That holds here because each screen
// owns exactly one sheet, and shell.css - the nav, which is on every screen
// - must therefore spend nothing.
const RED_TOKENS = /--brand-accent\b|--brand-accent-hover\b/;
const HEADINGISH =
  /(^|[.-])(h[1-6]|title|heading|headline|label__text|legend)([.-]|$)/i;
const redSpends = {};
const redOffences = [];
for (const { path, css } of sheets) {
  if (path.startsWith(DIST)) continue;
  if (path.endsWith('brand.css')) continue; // where the tokens are DEFINED
  const spenders = new Set();
  for (const { selector, body } of rulesOf(css)) {
    const declaresRed =
      RED_TOKENS.test(body) ||
      [...body.matchAll(/:\s*([^;]*)/g)].some((m) => {
        const rgb = rgbOf(m[1]);
        return (
          rgb && rgb[0] > 120 && rgb[0] > rgb[1] * 1.6 && rgb[0] > rgb[2] * 1.6
        );
      });
    if (!declaresRed) continue;
    // A base class and its own :hover/:focus/:disabled are ONE element.
    const base = unwrap(selector)
      .split(/[\s>+~]/)
      .pop()
      .replace(/:[a-z-]+(\([^)]*\))?/g, '')
      .trim();
    spenders.add(base || selector);
    if (HEADINGISH.test(base))
      redOffences.push(
        `${path} :: red on a heading-like selector "${selector}"`,
      );
  }
  if (spenders.size) redSpends[path] = [...spenders];
  if (spenders.size > 1)
    redOffences.push(
      `${path} :: ${spenders.size} red elements on one screen (${[...spenders].join(', ')})`,
    );
}

// The hole R-03-a named: the wordmark's red lives inside an imported SVG,
// which no stylesheet check scans. Two wordmarks on one screen was two red
// elements, and the owner caught by eye what the guard could not see.
const WORDMARK = 'src/assets/Demo_Parts_Logo.svg';
const redSvgs = svgFiles
  .filter(({ src }) =>
    [...src.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].some((m) => {
      const rgb = rgbOf(m[0]);
      return rgb && !(rgb[0] === rgb[1] && rgb[1] === rgb[2]);
    }),
  )
  .map((s) => s.path);
if (redSvgs.length > 1 || (redSvgs.length === 1 && redSvgs[0] !== WORDMARK)) {
  redOffences.push(
    `coloured SVG assets ship other than the wordmark: ${redSvgs.join(', ')}`,
  );
}
// One <img>/<svg> use of the wordmark per screen. More than one is more than
// one red element, whatever the stylesheets say.
const wordmarkUses = codeFiles
  .filter((f) => /Demo_Parts_Logo/.test(f.src))
  .map((f) => f.path);
if (wordmarkUses.length > 1)
  redOffences.push(
    `the wordmark is imported by ${wordmarkUses.length} components (${wordmarkUses.join(', ')}); one screen can then carry two`,
  );

check(
  'at most one red element per screen, never on a heading, wordmark excluded',
  redOffences.length === 0,
  {
    spends: redSpends,
    colouredSvgAssets: redSvgs,
    wordmarkImportedBy: wordmarkUses,
    offences: redOffences,
  },
);

const ok = assertions.every((a) => a.pass);
console.log(JSON.stringify({ ok, assertions }, null, 2));
process.exit(ok ? 0 : 1);
