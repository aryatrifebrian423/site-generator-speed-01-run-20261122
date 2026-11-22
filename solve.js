// site-generator-speed-01-run-20261122: a faster drop-in for makefun-site 1.0.0.
// Written from scratch against the reference's README and code: same answers,
// byte for byte, on every input. No dependencies, Node stdlib only.
//
// How it is fast: the reference renders Markdown one character at a time
// (escapeHtml per character, string concatenation per token), builds a token
// object per block, re-slugifies every title and tag name with a fresh
// normalize + regex pass, and renders templates by string concatenation
// through a scope chain. This module instead:
//  - escapes with one native regex scan per string, returning the input
//    untouched when it holds nothing to escape;
//  - renders Markdown in a single fused pass over the lines (no token
//    objects), with inline markup found by one native regex scan per token
//    and long plain runs sliced whole;
//  - memoises slugify per case (tag names and titles repeat) with a pure
//    ASCII fast path that skips Unicode normalisation entirely;
//  - renders templates into an output array joined once, with a flat scope
//    stack and direct property walks;
//  - parses front matter by scanning line boundaries instead of splitting
//    and re-joining the whole body.
'use strict';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = Object.hasOwn;

// ---------------------------------------------------------------- text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Returns the input when nothing needs it. */
function esc(text) {
  ESC_RE.lastIndex = 0;
  let m;
  let out = '';
  let last = 0;
  let found = false;
  while ((m = ESC_RE.exec(text)) !== null) {
    found = true;
    out += text.slice(last, m.index) + ESC_MAP[m[0]];
    last = m.index + 1;
  }
  if (!found) return text;
  return out + text.slice(last);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  // date is YYYY-MM-DD, already validated.
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const NON_ASCII = /[^\x00-\x7F]/;
const COMBINING = /\p{M}/gu;

/**
 * The slug of `text`, memoised in `cache` (one cache per case). ASCII text
 * skips normalisation: NFKD is the identity on ASCII and combining marks
 * are all non-ASCII, so the ASCII loop below is exactly the reference rule.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  if (!NON_ASCII.test(text)) {
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(COMBINING, '');
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken`: first of slug, slug-2, slug-3... free. */
function uniqueSlug(slug, taken, next) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = next.get(slug) || 2;
  let out;
  for (;;) {
    out = slug + '-' + n;
    if (!taken.has(out)) break;
    n++;
  }
  next.set(slug, n + 1);
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        const t = tags[i];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
        if (!ok) return { error: 'key "slug": not a slug' };
        if (c === 45 && (i === 0 || i === raw.length - 1 || raw.charCodeAt(i - 1) === 45)) return { error: 'key "slug": not a slug' };
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Scans line
 * boundaries instead of splitting the whole body.
 */
function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  const data = {};
  let pos = nl === -1 ? text.length : nl + 1;
  let lineNo = 1;
  for (;;) {
    if (pos >= text.length) return { error: 'the front matter is not closed' };
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    lineNo++;
    if (line === '---') {
      const body = e === -1 ? '' : text.slice(e + 1);
      if (!hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body };
    }
    if (isBlankLine(line) || line.charCodeAt(0) === 35) {
      pos = e === -1 ? text.length : e + 1;
      continue;
    }
    // LINE: ([a-z_]+):(?: (.*))?$
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) {
      return { error: `line ${lineNo} is not "key: value"` };
    }
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${lineNo} is not "key: value"` };
    let end = raw.length;
    while (end > 0) {
      const c = raw.charCodeAt(end - 1);
      if (c === 32 || c === 9) end--;
      else break;
    }
    if (end !== raw.length) raw = raw.slice(0, end);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    pos = e === -1 ? text.length : e + 1;
  }
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = '\\`*_[]()#+-.!>';
const INLINE_RE = /[\\`*\[&<>"']/g;
const WS_RE = /\s/;

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence-open line's language, or null when the line is not a fence open. */
function fenceLang(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  let lang = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) {
      lang += line[i];
      i++;
    } else break;
  }
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length) {
    const ch = line.charCodeAt(a);
    if (ch === 32 || ch === 9) a++;
    else break;
  }
  let b = line.length;
  while (b > a) {
    const ch = line.charCodeAt(b - 1);
    if (ch === 32 || ch === 9) b--;
    else break;
  }
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHR(line) {
  if (line.length < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (c === 45) {
    if (line.charCodeAt(1) !== 45 || line.charCodeAt(2) !== 45) return false;
  } else {
    if (line.charCodeAt(1) !== 42 || line.charCodeAt(2) !== 42) return false;
  }
  for (let i = 3; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  // First-character gating: no fence, heading or break starts with a space,
  // a tab, or any other character than `, # , - or *.
  const c0 = line.charCodeAt(0);
  if (line.length === 0 || c0 === 32 || c0 === 9) return isBlankLine(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return false;
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. `re` is the
 * shared special-character scan, its lastIndex reset after every token so
 * the recursion (strong / emphasis / link text) can reuse it.
 */
function inline(s, env, re) {
  let out = '';
  let i = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = m[0];
    if (c === '\\') {
      const n = s[j + 1];
      if (n !== undefined && ESCAPABLE.indexOf(n) !== -1) {
        out += n;
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += '<code>' + esc(s.slice(j + 1, k)) + '</code>';
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += '<strong>' + inline(s.slice(j + 2, k), env, re) + '</strong>';
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += '<em>' + inline(s.slice(j + 1, k), env, re) + '</em>';
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        out += '<a href="' + esc(env.link(target)) + '">' + inline(s.slice(j + 1, k), env, re) + '</a>';
        i = mm + 1;
      } else {
        out += '[';
        i = j + 1;
      }
    } else {
      out += ESC_MAP[c];
      i = j + 1;
    }
    re.lastIndex = i;
  }
  if (i < s.length) out += s.slice(i);
  return out;
}

/**
 * `src` rendered in one fused pass over its lines: HTML (each block on its
 * own lines, a "\n" after the last), table of contents (level 2 and 3
 * headings) and excerpt (first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, re, slugCache) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  const idNext = new Map();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    // First-character gating: a blank line, fence, heading, break, quote or
    // list can only start with its own first character, so most lines skip
    // straight to the list-or-paragraph tail below.
    const c0 = line.charCodeAt(0);
    if (line.length === 0 || c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        let code = '';
        while (i < n && !isFenceClose(lines[i])) {
          code += esc(lines[i]) + '\n';
          i++;
        }
        i++;
        blocks.push('<pre><code' + (lang === '' ? '' : ' class="language-' + esc(lang) + '"') + '>' + code + '</code></pre>');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids, idNext);
        const html = inline(heading.text, env, re);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.slice(l.charCodeAt(1) === 32 ? 2 : 1)));
      }
      const kept = [];
      for (const l of body) if (l !== '') kept.push(l);
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(kept.join('\n'), env, re) + '</p>\n</blockquote>');
      continue;
    }
    const bullet = line.length >= 2 && (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32;
    let ordered = false;
    let start = 1;
    if (!bullet) {
      let d = 0;
      while (d < line.length && d < 10) {
        const c = line.charCodeAt(d);
        if (c >= 48 && c <= 57) d++;
        else break;
      }
      if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        ordered = true;
        start = Number(line.slice(0, d));
      }
    }
    if (bullet || ordered) {
      const items = [];
      while (i < n) {
        const l = lines[i];
        let itemText = null;
        if (ordered) {
          let d = 0;
          while (d < l.length && d < 10) {
            const c = l.charCodeAt(d);
            if (c >= 48 && c <= 57) d++;
            else break;
          }
          if (d >= 1 && d <= 9 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) itemText = l.slice(d + 2);
        } else if (l.length >= 2 && (l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          itemText = l.slice(2);
        }
        if (itemText !== null) {
          items.push([trimLine(itemText)]);
          i++;
        } else if (l.length >= 2 && l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32) {
          // CONTINUED: two or more spaces, then a non-space character.
          let sp = 0;
          while (sp < l.length && l.charCodeAt(sp) === 32) sp++;
          if (sp < l.length && !WS_RE.test(l[sp])) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let listHtml = open + '\n';
      for (const parts of items) listHtml += `<li>${inline(parts.join('\n'), env, re)}</li>\n`;
      listHtml += `</${tag}>`;
      blocks.push(listHtml);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env, re);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += b + '\n';
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope stack: first name from the nearest scope holding it, then own properties. */
function lookup(stack, path) {
  const first = path[0];
  for (let k = stack.length - 1; k >= 0; k--) {
    const vars = stack[k];
    if (hasOwn(vars, first)) {
      let v = vars[first];
      for (let j = 1; j < path.length; j++) {
        if (v === null || typeof v !== 'object' || !hasOwn(v, path[j])) return undefined;
        v = v[path[j]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` (joined once by the caller) in `stack`'s scopes. */
function renderNodes(nodes, stack, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(stack, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(stack, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(stack, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, stack, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(stack, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          stack.push(vars);
          renderNodes(n.body, stack, ctx, depth, out);
          stack.pop();
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, stack, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  // A manual scan (no match array): exactly JavaScript \s — tab, LF, VT, FF,
  // CR, space, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F,
  // U+3000, U+FEFF. Surrogate halves are never whitespace, as with \S.
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) ||
      c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const re = INLINE_RE;
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths; a non-.md file is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: refused sources and drafts are reported and dropped.
  {
    const kept = [];
    for (const s of sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      let own;
      for (const d of RESERVED) {
        if (d !== 'posts' && s.path.startsWith(d + '/')) { own = d; break; }
      }
      if (own !== undefined) {
        report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !hasOwn(s.data, 'date')) {
        report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!templates.has(layout)) {
        report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    sources = kept;
  }

  // 3. Permalinks: each page's directory and url, slug unique in its directory.
  const bySource = new Map();
  {
    const taken = new Map();
    const takenIn = (dir) => {
      let set = taken.get(dir);
      if (set === undefined) {
        set = new Set(dir === '' ? RESERVED : []);
        taken.set(dir, set);
      }
      return set;
    };
    const nextIn = new Map();
    const nextFor = (dir) => {
      let m = nextIn.get(dir);
      if (m === undefined) {
        m = new Map();
        nextIn.set(dir, m);
      }
      return m;
    };
    for (const s of sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir), nextFor(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : dir + '/' + slug;
      s.url = base + '/' + s.outDir + '/';
      bySource.set(s.path, s);
    }
  }

  // 4. Markdown: each body's HTML, its links resolved.
  const broken = new Set();
  {
    const staticPaths = new Set(statics.map((f) => f.path));
    for (const s of sources) {
      const dir = dirOf(s.path);
      const link = (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      };
      const md = renderMarkdown(s.body, { link }, re, slugCache);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. Collections: posts newest first, then by slug; newer / older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in the posts' order.
  const tags = [];
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name, slugCache);
        if (!seen.has(slug)) {
          seen.add(slug);
          out.push(name);
        }
      }
      return out;
    };
    for (const p of posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name, slugCache);
        let tag = bySlug.get(slug);
        if (tag === undefined) {
          tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
          bySlug.set(slug, tag);
        }
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of sources) {
      if (s.post) continue;
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        const t = bySlug.get(slug);
        return t !== undefined ? t : { name, slug, url: '', posts: [] };
      });
    }
    tags.push(...[...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug)));
  }

  // 7. Layouts: every page, the index pages and the tag pages.
  const output = {};
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  // One root scope object per case, its keys mutated per render: a key
  // present with value undefined reads exactly as an absent key (lookup
  // returns undefined either way), and the object's shape never changes.
  const rootVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    rootVars.page = vars.page;
    rootVars.posts = vars.posts;
    rootVars.pager = vars.pager;
    rootVars.tag = vars.tag;
    const out = [];
    renderNodes(nodes, [rootVars], ctx, 0, out);
    return out.join('');
  };
  for (const s of sources) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[s.outDir + '/index.html'] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
