// DOM awareness: map gaze coordinates to page structure using the APIs
// the browser already provides — no CV, no OCR.
//
// elementFromPoint(x, y) answers "what is under the gaze?" Classify the
// result into content roles (paragraph, heading, nav, image, code,
// whitespace, outside) so the reading-aware modes can distinguish "gaze on
// text, progressing downward" (keep reading, maybe reveal) from "gaze on
// chrome/whitespace" (don't act). All lookups are wrapped: anything odd
// (cross-origin frames, display:none) degrades to 'unknown', never throws.

export const DomRoles = {
  PARAGRAPH: 'paragraph',
  HEADING: 'heading',
  NAV: 'navigation',
  IMAGE: 'image',
  CODE: 'code',
  WHITESPACE: 'whitespace',
  OTHER: 'other',
  UNKNOWN: 'unknown',
  OUTSIDE: 'outside',
};

const TEXT_ROLES = new Set([DomRoles.PARAGRAPH, DomRoles.HEADING, DomRoles.CODE]);

export function isTextRole(role) {
  return TEXT_ROLES.has(role);
}

export function roleOfElement(el) {
  if (!el || !el.tagName) return DomRoles.WHITESPACE;
  const tag = el.tagName.toLowerCase();
  if (['p', 'li', 'blockquote', 'td', 'figcaption'].includes(tag)) return DomRoles.PARAGRAPH;
  if (/^h[1-6]$/.test(tag)) return DomRoles.HEADING;
  if (['nav', 'header', 'footer', 'aside', 'menu'].includes(tag)) return DomRoles.NAV;
  if (['a', 'button'].includes(tag)) {
    // Links/buttons *inside* text still count as reading material.
    const parent = el.closest?.('p, li, article, main');
    return parent ? DomRoles.PARAGRAPH : DomRoles.NAV;
  }
  if (['img', 'video', 'canvas', 'svg'].includes(tag)) return DomRoles.IMAGE;
  if (['pre', 'code'].includes(tag)) return DomRoles.CODE;
  if (['article', 'main', 'section', 'div'].includes(tag)) {
    // Bare containers: text-bearing if they directly hold text.
    const text = el.firstChild?.nodeType === 3 ? (el.textContent ?? '').trim() : '';
    if (text.length > 40) return DomRoles.PARAGRAPH;
    return DomRoles.OTHER;
  }
  return DomRoles.OTHER;
}

// { role, element, rect, onText } — never throws.
export function gazeTarget(x, y) {
  try {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { role: DomRoles.UNKNOWN, element: null, onText: false };
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return { role: DomRoles.OUTSIDE, element: null, onText: false };
    }
    const el = document.elementFromPoint(x, y);
    if (!el) return { role: DomRoles.WHITESPACE, element: null, onText: false };
    const role = roleOfElement(el);
    return { role, element: el, rect: el.getBoundingClientRect?.(), onText: isTextRole(role) };
  } catch {
    return { role: DomRoles.UNKNOWN, element: null, onText: false };
  }
}

// Fraction of visible viewport height below the gaze point that is text.
// Cheap proxy for "is there anything left to read here?" Sample N points
// on the vertical line below (x, y); count hits on text roles.
export function textBelowRatio(x, y, samples = 8) {
  try {
    const h = window.innerHeight;
    if (y >= h - 4) return 0;
    let text = 0;
    for (let i = 1; i <= samples; i++) {
      const sy = y + ((h - y) * i) / (samples + 1);
      if (gazeTarget(x, sy).onText) text++;
    }
    return text / samples;
  } catch {
    return 0.5; // unknown → neutral, never blocks
  }
}
