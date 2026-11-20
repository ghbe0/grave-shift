// Language switching. The game is written in English; with Hebrew chosen, every piece of text on
// the page is translated as it appears: a MutationObserver catches each text node and the
// placeholder, title, label and tooltip attributes the moment code writes them, and looks them
// up in the Hebrew dictionary (exact phrases first, then sentence patterns that carry numbers and
// names through). The page turns right-to-left. Switching back to English restores the original
// text in place. Text that must never change (party codes, key names, player-typed values) sits
// inside an element marked translate="no".
import { HE, HE_PATTERNS } from './he';

export type Lang = 'en' | 'he';

let current: Lang = 'en';
const cache = new Map<string, string>();
const compiled: [RegExp, string][] = HE_PATTERNS.map(([en, he]) => {
  // {0} stands for any text, {#0} for a number only.
  const re = '^' + en.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{#\d\}/g, '([\\d.,:/]+)').replace(/\{\d\}/g, '(.+?)') + '$';
  return [new RegExp(re), he];
});

/** The current language. */
export function lang(): Lang { return current; }

/** One piece of text in the current language (unchanged in English or when unknown). */
export function t(s: string): string {
  if (current === 'en') return s;
  const core = s.trim();
  if (!core || !/[A-Za-z]/.test(core)) return s;
  let out = cache.get(core);
  if (out === undefined) {
    out = lookup(core) ?? core;
    cache.set(core, out);
  }
  return out === core ? s : s.replace(core, out);
}

function lookup(s: string, depth = 0): string | undefined {
  const exact = HE[s];
  if (exact !== undefined) return exact;
  if (depth > 3) return undefined;
  for (const [re, he] of compiled) {
    const m = s.match(re);
    if (m) return he.replace(/\{#?(\d)\}/g, (_, i) => { const part = m[+i + 1]; return lookup(part, depth + 1) ?? part; });
  }
  // Lists and labels joined by a middle dot, a colon or a dash.
  for (const sep of [' · ', '. ', ': ', ' - ']) {
    if (!s.includes(sep)) continue;
    const parts = s.split(sep), done = parts.map(p => lookup(p, depth + 1) ?? p);
    if (done.some((p, i) => p !== parts[i])) return done.join(sep);
  }
  // A known phrase with a trailing mark (✓, …, !).
  const tail = s.match(/^(.*?)(\s*[✓…!?.:›‹]+)$/);
  if (tail && tail[1]) { const core = lookup(tail[1], depth + 1); if (core) return core + tail[2]; }
  return undefined;
}

// ---- The page ------------------------------------------------------------------------------

const ATTRS = ['placeholder', 'title', 'aria-label', 'data-tip', 'alt'];
/** For each text node and attribute we changed: the English original and what we wrote. */
const textOrig = new WeakMap<Text, { en: string; out: string }>();
const attrOrig = new WeakMap<Element, Map<string, { en: string; out: string }>>();
const touched = new Set<WeakRef<Node>>();
let observer: MutationObserver | null = null;

const frozen = (n: Node | null): boolean => {
  const el = n instanceof Element ? n : n?.parentElement;
  return !el || !!el.closest('[translate="no"], script, style, textarea, input');
};

function fixText(node: Text): void {
  const seen = textOrig.get(node);
  if (seen && seen.out === node.data) return;
  if (frozen(node)) return;
  const en = node.data, out = t(en);
  if (out === en) { textOrig.delete(node); return; }
  textOrig.set(node, { en, out });
  touched.add(new WeakRef(node));
  node.data = out;
}

function fixAttr(el: Element, name: string): void {
  const value = el.getAttribute(name);
  if (value === null || el.closest('[translate="no"]')) return;
  let map = attrOrig.get(el);
  const seen = map?.get(name);
  if (seen && seen.out === value) return;
  const out = t(value);
  if (out === value) { map?.delete(name); return; }
  if (!map) { map = new Map(); attrOrig.set(el, map); }
  map.set(name, { en: value, out });
  touched.add(new WeakRef(el));
  el.setAttribute(name, out);
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) { fixText(root as Text); return; }
  if (!(root instanceof Element) || root.closest('[translate="no"]')) return;
  for (const a of ATTRS) if (root.hasAttribute(a)) fixAttr(root, a);
  const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) fixText(n as Text);
    else for (const a of ATTRS) if ((n as Element).hasAttribute(a)) fixAttr(n as Element, a);
  }
}

function restore(): void {
  for (const ref of touched) {
    const n = ref.deref();
    if (!n) continue;
    if (n.nodeType === Node.TEXT_NODE) {
      const seen = textOrig.get(n as Text);
      if (seen && (n as Text).data === seen.out) (n as Text).data = seen.en;
      textOrig.delete(n as Text);
    } else if (n instanceof Element) {
      for (const [name, seen] of attrOrig.get(n) ?? []) if (n.getAttribute(name) === seen.out) n.setAttribute(name, seen.en);
      attrOrig.delete(n);
    }
  }
  touched.clear();
}

/** Switches the whole page to `l`: text, document direction and title. */
export function setLang(l: Lang): void {
  if (l === current && (l === 'en' || observer)) return;
  current = l;
  const root = document.documentElement;
  root.lang = l;
  root.dir = l === 'he' ? 'rtl' : 'ltr';
  root.classList.toggle('rtl', l === 'he');
  observer?.disconnect();
  observer = null;
  if (l === 'en') { restore(); document.title = 'Grave Shift'; return; }
  document.title = t('Grave Shift');
  walk(document.body);
  observer = new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'characterData') fixText(m.target as Text);
      else if (m.type === 'attributes') fixAttr(m.target as Element, m.attributeName!);
      else m.addedNodes.forEach(walk);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
