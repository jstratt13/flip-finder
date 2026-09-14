import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The capture chassis against a fake browser: a mutable location, a document
// with no cards, stubbed chrome messaging, and node's mock timers. Enough to
// drive single-page navigation, which is the part Craigslist never exercised.
const require = createRequire(import.meta.url);
const CAPTURE_PATH = require.resolve('../../extension/src/capture.js');

function setup(t, { href }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  const url = new URL(href);
  const loc = { href: url.href, pathname: url.pathname };
  const sent = [];

  globalThis.location = loc;
  globalThis.document = { body: {}, querySelectorAll: () => [] };
  globalThis.window = { addEventListener() {} };
  globalThis.MutationObserver = class {
    observe() {}
  };
  globalThis.chrome = {
    runtime: {
      sendMessage: (msg, cb) => {
        sent.push(...msg.items);
        cb({ ok: true, accepted: msg.items.length });
      },
    },
    storage: { local: { set() {} } },
  };

  // Fresh chassis per test; it keeps module-level state.
  delete require.cache[CAPTURE_PATH];
  delete globalThis.FFCapture;
  const capture = require(CAPTURE_PATH);

  const go = (next) => {
    const u = new URL(next);
    loc.href = u.href;
    loc.pathname = u.pathname;
  };
  // Node's mock clock won't fire a timer scheduled during the same tick() call,
  // so one big tick would run a polling loop exactly once. Advance in steps.
  const tick = (ms) => {
    for (let done = 0; done < ms; done += 100) t.mock.timers.tick(Math.min(100, ms - done));
  };
  return { capture, sent, go, tick };
}

// A Facebook-shaped adapter whose rendered detail is whatever the test says.
function spaAdapter() {
  const a = {
    name: 'facebook',
    spa: true,
    cardSelector: 'a',
    rendered: null,
    inScope: (l) => l.pathname.startsWith('/marketplace'),
    isDetail: () => /\/marketplace\/item\//.test(location.pathname),
    fromCard: () => null,
    fromDetail() {
      const id = location.pathname.match(/item\/(\d+)/)?.[1];
      return id && a.rendered ? { source: 'facebook', source_id: id, capture_phase: 'detail', ...a.rendered } : null;
    },
  };
  return a;
}

test('clicking into an item from the grid captures its detail', (t) => {
  const { capture, sent, go, tick } = setup(t, { href: 'https://www.facebook.com/marketplace/irvine/search' });
  const a = spaAdapter();
  capture.start(a);

  go('https://www.facebook.com/marketplace/item/111/');
  a.rendered = { title: 'Aeron chair', price: 450 };
  tick(500); // URL poll notices
  tick(400); // second identical read

  assert.equal(sent.length, 1);
  assert.equal(sent[0].source_id, '111');
  assert.equal(capture.stats.details, 1);
});

test('a detail is not recorded until two reads agree', (t) => {
  const { capture, sent, go, tick } = setup(t, { href: 'https://www.facebook.com/marketplace/' });
  const a = spaAdapter();
  capture.start(a);

  go('https://www.facebook.com/marketplace/item/111/');
  a.rendered = { title: 'Aeron', price: null }; // still rendering
  tick(500);
  a.rendered = { title: 'Aeron chair', price: 450 };
  tick(400);
  assert.equal(sent.length, 0, 'content changed between reads');
  tick(400);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].price, 450);
});

test("the previous item's content is never recorded under the next id", (t) => {
  const { capture, sent, go, tick } = setup(t, { href: 'https://www.facebook.com/marketplace/' });
  const a = spaAdapter();
  capture.start(a);

  go('https://www.facebook.com/marketplace/item/111/');
  a.rendered = { title: 'Aeron chair', price: 450 };
  tick(900);
  assert.equal(sent.length, 1);

  // URL moves to 222 but the dialog still shows 111 for a while.
  go('https://www.facebook.com/marketplace/item/222/');
  tick(500);
  tick(400);
  tick(400);
  assert.equal(sent.length, 1, 'stale content was recorded as item 222');

  a.rendered = { title: 'Steelcase Leap', price: 300 };
  tick(400);
  tick(400);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].source_id, '222');
  assert.equal(sent[1].title, 'Steelcase Leap');
});

test('an item that never renders is counted as a miss, not guessed', (t) => {
  const { capture, sent, go, tick } = setup(t, { href: 'https://www.facebook.com/marketplace/' });
  const a = spaAdapter();
  capture.start(a);

  go('https://www.facebook.com/marketplace/item/111/');
  tick(500);
  tick(10000);
  assert.equal(sent.length, 0);
  assert.equal(capture.stats.detail_misses, 1);
});

test('nothing is read outside Marketplace, and walking in starts capture', (t) => {
  const { capture, sent, go, tick } = setup(t, { href: 'https://www.facebook.com/' });
  const a = spaAdapter();
  let detailReads = 0;
  const fromDetail = a.fromDetail;
  a.fromDetail = () => (detailReads++, fromDetail());
  a.rendered = { title: 'Aeron chair', price: 450 };
  capture.start(a);

  go('https://www.facebook.com/groups/123');
  tick(1000);
  assert.equal(detailReads, 0);

  go('https://www.facebook.com/marketplace/item/111/');
  tick(900);
  assert.equal(sent.length, 1);
});

test('craigslist keeps its one-shot detail capture', (t) => {
  const { capture, sent } = setup(t, { href: 'https://orangecounty.craigslist.org/ele/d/x/123.html' });
  capture.start({
    name: 'craigslist',
    cardSelector: '.cl-search-result',
    isDetail: () => true,
    fromCard: () => null,
    fromDetail: () => ({ source: 'craigslist', source_id: '123', capture_phase: 'detail', title: 'Receiver' }),
  });
  // No polling or waiting: recorded immediately on load, as before.
  assert.equal(sent.length, 1);
});
