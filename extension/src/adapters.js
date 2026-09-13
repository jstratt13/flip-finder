// Site adapters. Each returns records in the worker's normalized shape.
// Content scripts can't use ES modules without a build step, so this registers
// onto a global the later scripts read.
//
// The file is a plain script with no top-level DOM access, which lets the test
// suite require it directly and exercise the extraction against captured
// markup. Selector rot is the expected failure mode here, so it needs to be
// something tests can catch rather than something you notice weeks later.
globalThis.FF_ADAPTERS = globalThis.FF_ADAPTERS || {};

function ffPrice(text) {
  if (!text) return null;
  const n = Number(String(text).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Facebook hashes every class name and reshuffles them on deploys, so nothing
// here may depend on them. The one stable anchor is the item URL, which FB
// can't randomise without breaking its own routing.
const FB_ITEM_RE = /\/marketplace\/item\/(\d+)/;
const FB_PRICE_LINE = /^\$[\d,]+(\.\d{2})?$/;
const FB_FREE_LINE = /^free$/i;
const FB_LOCATION_LINE = /,\s*[A-Z]{2}$/;

// Card chrome that isn't part of the listing.
const FB_BADGES = new Set([
  'just listed', 'sponsored', 'new', 'price drop', 'free shipping',
  'shipping available', 'save', 'saved', 'pending',
]);

function ffFbPrice(lines) {
  const prices = lines
    .filter((l) => FB_PRICE_LINE.test(l) || FB_FREE_LINE.test(l))
    .map((l) => (FB_FREE_LINE.test(l) ? 0 : Number(l.replace(/[^0-9.]/g, ''))))
    .filter((n) => Number.isFinite(n));

  if (!prices.length) return { price: null, prices };
  // A discounted listing renders the sale price and the struck-through original
  // as two separate lines. The lower one is what you'd actually pay, and taking
  // the minimum doesn't care which order FB renders them in.
  return { price: Math.min(...prices), prices };
}

globalThis.FF_ADAPTERS.facebook = {
  name: 'facebook',

  handles: (url) => /(^|\.)facebook\.com$/.test(new URL(url).hostname),

  isDetail: () => FB_ITEM_RE.test(location.pathname),

  // Matches the anchor itself rather than a card container: the anchor already
  // holds the price, title, location and image, and any wrapper we picked would
  // be identified by a class name we can't trust.
  cardSelector: 'a[href*="/marketplace/item/"]',

  fromCard(anchor) {
    const id = (anchor.getAttribute('href') || '').match(FB_ITEM_RE)?.[1];
    if (!id) return null;

    const lines = (anchor.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return null;

    const { price } = ffFbPrice(lines);
    const location_name = [...lines].reverse().find((l) => FB_LOCATION_LINE.test(l)) ?? null;

    const rest = lines.filter(
      (l) =>
        !FB_PRICE_LINE.test(l) &&
        !FB_FREE_LINE.test(l) &&
        l !== location_name &&
        !FB_BADGES.has(l.toLowerCase())
    );
    const title = rest.sort((a, b) => b.length - a.length)[0];
    if (!title) return null;

    return {
      source: 'facebook',
      source_id: id,
      // The href carries a long tracking payload; keep only the canonical item.
      url: `https://www.facebook.com/marketplace/item/${id}/`,
      title,
      price,
      location_name,
      thumb_url: anchor.querySelector('img')?.src ?? null,
      // Keeps the unparsed card so a layout change is re-parsable server-side
      // instead of silently losing listings.
      raw_text: anchor.innerText || null,
      acquisition_mode: 'pickup',
      capture_phase: 'grid',
    };
  },

  fromDetail() {
    const id = location.pathname.match(FB_ITEM_RE)?.[1];
    if (!id) return null;

    const main = document.querySelector('[role="main"]') ?? document.body;
    const text = main.innerText || '';
    const all = text.split('\n').map((s) => s.trim()).filter(Boolean);

    // Everything below "Related searches" is OTHER people's listings, each with
    // its own price. Reading past this point would happily record a $1 related
    // item as this listing's price.
    const cut = all.findIndex((l) =>
      /^(related searches|more like this|you may also like|similar items|suggested)$/i.test(l)
    );
    const lines = cut === -1 ? all : all.slice(0, cut);

    // The Details block is label/value pairs on consecutive lines.
    const valueAfter = (label) => {
      const i = lines.findIndex((l) => l.toLowerCase() === label);
      return i !== -1 && lines[i + 1] ? lines[i + 1] : null;
    };

    const { price } = ffFbPrice(lines);
    const title = document.querySelector('h1')?.innerText?.trim() || lines[0] || null;

    // "Listed 40 minutes ago in Claremont, CA"
    const listed = lines.find((l) => /^listed\b.*\bin\s+/i.test(l));

    // Description is free text, so it's the longest line that isn't a field
    // value or the title.
    const description = lines
      .filter((l) => l !== title && l.length > 60 && !/·/.test(l))
      .sort((a, b) => b.length - a.length)[0] ?? null;

    return {
      source: 'facebook',
      source_id: id,
      url: `https://www.facebook.com/marketplace/item/${id}/`,
      title,
      price,
      // FB states the condition outright, which beats inferring it from prose.
      condition_raw: valueAfter('condition'),
      // ...and names the category, which beats our keyword guess.
      category: lines[2] && !FB_PRICE_LINE.test(lines[2]) ? lines[2].toLowerCase() : null,
      description,
      location_name:
        (listed && listed.replace(/^listed\b.*?\bin\s+/i, '').trim()) ||
        [...lines].reverse().find((l) => FB_LOCATION_LINE.test(l)) ||
        null,
      // The item region travels with the record so a layout change is
      // re-parsable server-side rather than silently losing listings.
      raw_text: lines.join('\n').slice(0, 8000),
      images: [...main.querySelectorAll('img')]
        .map((i) => i.src)
        .filter((s) => s && s.includes('fbcdn'))
        .slice(0, 12),
      acquisition_mode: 'pickup',
      capture_phase: 'detail',
    };
  },
};

globalThis.FF_ADAPTERS.craigslist = {
  name: 'craigslist',

  handles: (url) => /(^|\.)craigslist\.org$/.test(new URL(url).hostname),

  isDetail: () => Boolean(document.querySelector('#postingbody')),

  // Grid cards carry title and price but no description, so condition stays
  // unknown until the detail page is opened.
  cardSelector: '.cl-search-result',

  fromCard(card) {
    const pid = card.getAttribute('data-pid');
    if (!pid) return null;

    const anchor = card.querySelector('a.posting-title') || card.querySelector('a[href*="/view/d/"]');
    const title = card.getAttribute('title') || anchor?.innerText?.trim();
    if (!title) return null;

    return {
      source: 'craigslist',
      source_id: pid,
      url: anchor?.href ?? null,
      title,
      price: ffPrice(card.querySelector('.priceinfo')?.textContent),
      location_name: card.querySelector('.result-location')?.textContent?.trim().replace(/^[()\s]+|[()\s]+$/g, '') || null,
      thumb_url: card.querySelector('img')?.src ?? null,
      acquisition_mode: 'pickup',
      capture_phase: 'grid',
    };
  },

  // Same numeric pid as the grid, so this upgrades the existing row rather
  // than creating a second one.
  fromDetail() {
    const pid = (document.body.innerHTML.match(/post id:\s*(\d+)/i) || [])[1];
    if (!pid) return null;

    const map = document.querySelector('#map');
    const attrs = [...document.querySelectorAll('.attrgroup, .attr')]
      .map((g) => g.innerText.trim())
      .join(' | ');
    const condMatch = attrs.match(/condition:\s*([a-z\s-]+)/i);

    return {
      source: 'craigslist',
      source_id: pid,
      url: location.href,
      title:
        document.querySelector('#titletextonly')?.textContent?.trim() ||
        document.querySelector('.postingtitletext')?.innerText?.trim(),
      price: ffPrice(document.querySelector('.price')?.textContent),
      description: document.querySelector('#postingbody')?.innerText?.trim() ?? null,
      raw_text: attrs || null,
      condition_raw: condMatch ? condMatch[1].trim() : null,
      lat: map ? Number(map.getAttribute('data-latitude')) : null,
      lon: map ? Number(map.getAttribute('data-longitude')) : null,
      posted_at: Date.parse(
        document.querySelector('.postinginfos time')?.getAttribute('datetime') || ''
      ) || null,
      images: [...document.querySelectorAll('.slide img, .thumb img')]
        .map((i) => i.src)
        .filter(Boolean),
      acquisition_mode: 'pickup',
      capture_phase: 'detail',
    };
  },
};

// Chrome loads this as a plain script and ignores the following. Node's test
// suite requires the same file, so the adapters shipped to the browser are
// exactly the ones under test.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.FF_ADAPTERS;
}
