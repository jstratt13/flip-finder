import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The extension ships plain scripts, so the same file the browser loads is
// required here. These tests exist because selector rot is the expected
// failure mode: Facebook reshuffles its markup, and the first sign shouldn't
// be weeks of silently missing listings.
const require = createRequire(import.meta.url);
const ADAPTERS = require('../../extension/src/adapters.js');

// Minimal stand-ins for the two element shapes the adapters touch. Small enough
// to read, which matters more here than fidelity to a real DOM.
function el({ attrs = {}, text = '', children = {} }) {
  return {
    getAttribute: (k) => attrs[k] ?? null,
    innerText: text,
    textContent: text,
    querySelector: (sel) => children[sel] ?? null,
  };
}

function fbAnchor({ id, lines, img = 'https://scontent.xx.fbcdn.net/v/t39.jpg', href }) {
  return el({
    attrs: {
      href: href ?? `/marketplace/item/${id}/?ref=category_feed&tracking=%7B%22qid%22%3A%22x%22%7D`,
    },
    text: lines.join('\n'),
    children: { img: { src: img } },
  });
}

function clCard({ pid, title, price, location, href, img }) {
  return el({
    attrs: { 'data-pid': pid, title },
    children: {
      'a.posting-title': { href, innerText: title },
      '.priceinfo': { textContent: price },
      '.result-location': location ? { textContent: location } : null,
      img: { src: img },
    },
  });
}

// ---------------------------------------------------------------- facebook

const FB = ADAPTERS.facebook;

test('facebook: parses a real card', () => {
  const r = FB.fromCard(
    fbAnchor({ id: '1784016875935293', lines: ['Just listed', '$725', '9070XT white', 'Alhambra, CA'] })
  );

  assert.equal(r.source, 'facebook');
  assert.equal(r.source_id, '1784016875935293');
  assert.equal(r.price, 725);
  assert.equal(r.title, '9070XT white');
  assert.equal(r.location_name, 'Alhambra, CA');
  // The tracking payload is stripped down to the canonical item URL.
  assert.equal(r.url, 'https://www.facebook.com/marketplace/item/1784016875935293/');
  assert.ok(r.raw_text.includes('9070XT'), 'raw text travels for later re-parsing');
});

test('facebook: a discounted card takes the sale price, not the struck-out one', () => {
  // Observed live: FB renders both the current and original price as lines.
  const r = FB.fromCard(
    fbAnchor({
      id: '1387380270209966',
      lines: ['$300', '$400', '2 (12) kicker subs with brand new amp', 'Riverside, CA'],
    })
  );
  assert.equal(r.price, 300);
  assert.equal(r.title, '2 (12) kicker subs with brand new amp');
});

test('facebook: badge lines never become the title', () => {
  for (const badge of ['Just listed', 'Sponsored', 'Price drop']) {
    const r = FB.fromCard(fbAnchor({ id: '1', lines: [badge, '$50', 'Beats Solo3', 'Covina, CA'] }));
    assert.equal(r.title, 'Beats Solo3', `"${badge}" leaked into the title`);
  }
});

test('facebook: free items price at zero rather than null', () => {
  const r = FB.fromCard(fbAnchor({ id: '2', lines: ['Free', 'Moving boxes', 'Irvine, CA'] }));
  assert.equal(r.price, 0);
  assert.equal(r.title, 'Moving boxes');
});

test('facebook: a card with no price still yields a record', () => {
  const r = FB.fromCard(fbAnchor({ id: '3', lines: ['Dining table', 'Tustin, CA'] }));
  assert.equal(r.price, null);
  assert.equal(r.title, 'Dining table');
});

test('facebook: non-item anchors are ignored', () => {
  assert.equal(FB.fromCard(el({ attrs: { href: '/marketplace/category/electronics' } })), null);
  assert.equal(FB.fromCard(el({ attrs: { href: '/groups/12345' } })), null);
  assert.equal(FB.fromCard(el({ attrs: {} })), null);
});

test('facebook: an empty card is skipped rather than half-parsed', () => {
  assert.equal(FB.fromCard(fbAnchor({ id: '4', lines: [] })), null);
  // Price and location only, no title line.
  assert.equal(FB.fromCard(fbAnchor({ id: '5', lines: ['$40', 'Irvine, CA'] })), null);
});

test('facebook: the card selector is not class-based', () => {
  // FB hashes class names on every deploy; anything keyed on them rots.
  assert.ok(FB.cardSelector.includes('/marketplace/item/'));
  assert.ok(!/\.x[0-9a-z]/.test(FB.cardSelector), 'must not depend on FB class names');
});

test('facebook: handles() only claims facebook URLs', () => {
  assert.equal(FB.handles('https://www.facebook.com/marketplace/category/electronics'), true);
  assert.equal(FB.handles('https://orangecounty.craigslist.org/search/ela'), false);
  assert.equal(FB.handles('https://notfacebook.com/marketplace'), false);
});

// -------------------------------------------------------------- craigslist

const CL = ADAPTERS.craigslist;

test('craigslist: parses a real gallery card', () => {
  const r = CL.fromCard(
    clCard({
      pid: '7948505592',
      title: 'Redragon Pollux Pro K628 mechanical keyboard',
      price: '$20',
      location: 'Santa Ana, CA',
      href: 'https://www.craigslist.org/view/d/santa-ana-redragon/kMwyUJ1YTkwdojm8An61bg',
      img: 'https://images.craigslist.org/d/7948505592/01616.jpg',
    })
  );

  assert.equal(r.source_id, '7948505592');
  assert.equal(r.price, 20);
  assert.equal(r.title, 'Redragon Pollux Pro K628 mechanical keyboard');
  assert.equal(r.location_name, 'Santa Ana, CA');
  assert.equal(r.capture_phase, 'grid');
});

test('craigslist: the post id is the join key between grid and detail', () => {
  // Both phases key on data-pid / "post id", which is what lets a detail
  // capture upgrade the grid row instead of creating a duplicate.
  const r = CL.fromCard(clCard({ pid: '7946786144', title: 'iMac screen', price: '$75', href: '#' }));
  assert.equal(r.source_id, '7946786144');
});

test('craigslist: prices with separators parse correctly', () => {
  const r = CL.fromCard(clCard({ pid: '1', title: 'Pioneer Elite', price: '$2,900', href: '#' }));
  assert.equal(r.price, 2900);
});

test('craigslist: a card with no price still yields a record', () => {
  const r = CL.fromCard(clCard({ pid: '2', title: 'Free cables', price: null, href: '#' }));
  assert.equal(r.price, null);
  assert.equal(r.title, 'Free cables');
});

test('craigslist: a card without a pid is skipped', () => {
  assert.equal(CL.fromCard(el({ attrs: {}, children: {} })), null);
});

test('craigslist: handles() only claims craigslist URLs', () => {
  assert.equal(CL.handles('https://orangecounty.craigslist.org/search/ela'), true);
  assert.equal(CL.handles('https://www.craigslist.org/view/d/x/y'), true);
  assert.equal(CL.handles('https://www.facebook.com/marketplace'), false);
});

// A detail page reduced to what fromDetail reads: dialogs, the main region,
// and each region's text, heading and images.
function region(lines, { heading, imgs = [] } = {}) {
  return {
    innerText: lines.join('\n'),
    querySelector: (sel) => (sel === 'h1' && heading ? { innerText: heading } : null),
    querySelectorAll: (sel) => (sel === 'img' ? imgs.map((src) => ({ src })) : []),
  };
}

function fbDoc({ main = null, dialogs = [] } = {}) {
  return {
    body: region([]),
    querySelector: (sel) => (sel === '[role="main"]' ? main : null),
    querySelectorAll: (sel) => (sel === '[role="dialog"]' ? dialogs : []),
  };
}

const itemLoc = (id) => ({ pathname: `/marketplace/item/${id}/` });

const ITEM_LINES = [
  'Herman Miller Aeron chair size B',
  '$450',
  'Furniture',
  'Listed 2 days ago in Irvine, CA',
  'Condition',
  'Used - good',
  'Fully adjustable, lumbar pad included, one small scuff on the left arm rest from moving.',
];

test('facebook detail: reads a directly loaded item page', () => {
  const doc = fbDoc({ main: region(ITEM_LINES, { heading: 'Herman Miller Aeron chair size B' }) });
  const r = FB.fromDetail(doc, itemLoc('111'));
  assert.equal(r.source_id, '111');
  assert.equal(r.price, 450);
  assert.equal(r.condition_raw, 'Used - good');
  assert.equal(r.location_name, 'Irvine, CA');
  assert.equal(r.capture_phase, 'detail');
});

test('facebook detail: an item opened over the grid is read from its dialog', () => {
  // The grid behind still fills [role="main"]; reading it would take the
  // cheapest card's price.
  const grid = region(['$5', 'Mug', 'Irvine, CA', '$900', 'Couch', 'Tustin, CA', '$20', 'Lamp', 'Orange, CA']);
  const chat = region(['Messenger', 'Hey is this available?']);
  const item = region(ITEM_LINES, { heading: 'Herman Miller Aeron chair size B' });
  const r = FB.fromDetail(fbDoc({ main: grid, dialogs: [chat, item] }), itemLoc('222'));
  assert.equal(r.price, 450);
  assert.equal(r.title, 'Herman Miller Aeron chair size B');
});

test('facebook detail: a grid read as a detail records nothing', () => {
  // No dialog found, and main is the grid: several prices means wrong element.
  const grid = region(['$5', 'Mug', 'Irvine, CA', '$900', 'Couch', 'Tustin, CA', '$20', 'Lamp', 'Orange, CA']);
  assert.equal(FB.fromDetail(fbDoc({ main: grid }), itemLoc('333')), null);
});

test('facebook detail: related listings below the cut never set the price', () => {
  const lines = [...ITEM_LINES, 'Related searches', '$1', 'Stool', '$3', 'Chair mat', '$8', 'Desk'];
  const r = FB.fromDetail(fbDoc({ main: region(lines) }), itemLoc('444'));
  assert.equal(r.price, 450);
});

test('facebook detail: a discounted item still reads, with the sale price', () => {
  const lines = ['Aeron chair', '$400', '$450', 'Furniture', 'Irvine, CA'];
  assert.equal(FB.fromDetail(fbDoc({ main: region(lines) }), itemLoc('555')).price, 400);
});

test('facebook: capture is scoped to Marketplace', () => {
  assert.equal(FB.spa, true);
  assert.equal(FB.inScope({ pathname: '/marketplace/irvine/search' }), true);
  assert.equal(FB.inScope({ pathname: '/marketplace/item/1/' }), true);
  assert.equal(FB.inScope({ pathname: '/' }), false);
  assert.equal(FB.inScope({ pathname: '/groups/123' }), false);
});

// ------------------------------------------------------------------ shared

test('every adapter satisfies the chassis contract', () => {
  for (const [name, a] of Object.entries(ADAPTERS)) {
    for (const fn of ['handles', 'isDetail', 'fromCard', 'fromDetail']) {
      assert.equal(typeof a[fn], 'function', `${name}.${fn} missing`);
    }
    assert.equal(typeof a.cardSelector, 'string', `${name}.cardSelector missing`);
    assert.equal(a.name, name, `${name}.name mismatch`);
  }
});

test('every parsed record carries what ingest requires', () => {
  const records = [
    FB.fromCard(fbAnchor({ id: '9', lines: ['$99', 'Beats Studio pro', 'Aliso Viejo, CA'] })),
    CL.fromCard(clCard({ pid: '9', title: 'Keyboard', price: '$20', href: '#' })),
  ];

  for (const r of records) {
    assert.ok(r.source, 'source required');
    assert.ok(r.source_id, 'source_id required');
    assert.ok(r.title, 'title required');
    assert.ok(['pickup', 'shipped'].includes(r.acquisition_mode));
    assert.ok(['grid', 'detail'].includes(r.capture_phase));
  }
});
