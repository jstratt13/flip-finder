import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBulky, bulkyTerm } from '../src/config.js';
import { matchProduct, MATCHER_VERSION } from '../src/match.js';
import { rematchOutdated } from '../src/resolve.js';

test('accessories for bulky things are not bulky', () => {
  // Each of these used to be priced against local asks for the whole item —
  // a $20 grill cover against $400 grills ranks as a large phantom profit.
  for (const title of [
    'Weber grill cover',
    'Ryobi mower blade',
    'Desk lamp LED',
    'Gaming chair mat',
    'Sofa slipcover gray',
    'Queen mattress protector',
    'Samsung 65 inch TV remote',
    'Dresser drawer knobs set of 6',
  ]) {
    assert.equal(isBulky(title), false, title);
  }
});

test('small things named after bulky ones are not bulky', () => {
  for (const title of [
    'Netgear WiFi range extender',
    'Pyrex dishwasher safe set',
    'Breville toaster oven',
    'Lodge dutch oven 5qt',
    'Dyson hair dryer',
    'Coleman camp stove',
    'DeWalt table saw',
    'Orvis dog bed large',
  ]) {
    assert.equal(isBulky(title), false, title);
  }
});

test('real bulky goods still are', () => {
  for (const title of [
    'Brown leather sectional',
    'Oak dresser 6 drawer',
    'Queen mattress and boxspring',
    'GE gas range 30 inch',
    'Liberty gun safe',
    'Weber Genesis grill',
    'Samsung 65 inch TV',
    'Ikea desk white',
    'Whirlpool washer and dryer',
  ]) {
    assert.equal(isBulky(title), true, title);
  }
});

test('ambiguous terms need context', () => {
  assert.equal(bulkyTerm('Price range 200'), null);
  assert.equal(bulkyTerm('Electric range, works great'), 'range');
  assert.equal(bulkyTerm('Safe for kids ride-on'), null);
  assert.equal(bulkyTerm('Sentry fireproof safe'), 'safe');
});

test('a phrase exclusion leaves the rest of the title judged', () => {
  // The toaster oven is small, but the title is about the table.
  assert.equal(bulkyTerm('Dining table, toaster oven included'), 'dining');
});

test('grill cover gets its own key, not the grill pool', () => {
  const cover = matchProduct('Weber grill cover');
  const grill = matchProduct('Weber grill');
  assert.ok(!cover.product_key.startsWith('local:'), cover.product_key);
  assert.equal(grill.product_key, 'local:grill-weber');
});

test('plural and singular bulky titles share a comp pool', () => {
  assert.equal(
    matchProduct('Oak dining chairs').product_key,
    matchProduct('Oak dining chair').product_key
  );
});

// Records every statement the rematch pass would run, without a database.
function fakeDb(outdated) {
  const batches = [];
  return {
    batches,
    prepare(sql) {
      return {
        bind: (...args) => ({
          sql,
          args,
          all: async () => ({ results: /FROM listing_matches m/.test(sql) ? outdated : [] }),
        }),
      };
    },
    batch: async (stmts) => batches.push(stmts),
  };
}

test('rematch moves a misfiled accessory and reprices both pools', async () => {
  const db = fakeDb([
    { id: 'cover', title: 'Weber grill cover', category: '', old_key: 'local:grill-weber' },
    { id: 'grill', title: 'Weber grill', category: '', old_key: 'local:grill-weber', old_score: 0.65 },
  ]);

  const r = await rematchOutdated(db, { now: 1 });
  assert.deepEqual(r, { rematched: 2, changed: 1, unpriceable: 0 });

  const stmts = db.batches[0];
  const upserts = stmts.filter((s) => /INSERT INTO listing_matches/.test(s.sql));
  assert.equal(upserts.length, 2);
  assert.ok(upserts.every((s) => s.args.at(-1) === MATCHER_VERSION));

  // The grill pool lost a member, so its median is stale for the grill too.
  const compDelete = stmts.find((s) => /DELETE FROM comps/.test(s.sql));
  assert.deepEqual(compDelete.args, ['local:grill-weber']);
  assert.ok(stmts.some((s) => /DELETE FROM scores[\s\S]*product_key IN/.test(s.sql)));
});

test('a listing that no longer matches leaves its old pool', async () => {
  const db = fakeDb([{ id: 'x', title: '   ', category: '', old_key: 'local:desk' }]);
  await rematchOutdated(db, { now: 1 });
  const stmts = db.batches[0];
  assert.ok(stmts.some((s) => /DELETE FROM listing_matches/.test(s.sql) && s.args[0] === 'x'));
  assert.ok(stmts.some((s) => /DELETE FROM comps/.test(s.sql) && s.args.includes('local:desk')));
});

test('rematch stays under the D1 bound-parameter limit', async () => {
  const outdated = Array.from({ length: 250 }, (_, i) => ({
    id: `l${i}`, title: 'Weber grill cover', category: '', old_key: `local:grill-${i}`,
  }));
  const db = fakeDb(outdated);
  await rematchOutdated(db, { limit: 250, now: 1 });
  for (const s of db.batches[0]) assert.ok(s.args.length <= 100, `${s.args.length} params`);
});

test('nothing outdated means no writes', async () => {
  const db = fakeDb([]);
  assert.deepEqual(await rematchOutdated(db), { rematched: 0, changed: 0 });
  assert.equal(db.batches.length, 0);
});

test('a listing that becomes too vague to price loses its stale value', async () => {
  // Scored under an older matcher, then re-matched down to a generic-word
  // match: it will never be rescored, so the old value has to go with it.
  const db = fakeDb([{ id: 'kay', title: 'Kay Dreadnought', category: '', old_key: 'dreadnought-kay', old_score: 0.9 }]);

  const r = await rematchOutdated(db, { now: 1 });
  assert.equal(r.unpriceable, 1);

  const stmts = db.batches[0];
  assert.ok(
    stmts.some((s) => /DELETE FROM scores WHERE listing_id IN/.test(s.sql) && s.args.includes('kay')),
    'the stale score should be deleted'
  );
  assert.ok(
    stmts.some((s) => /score_due_at = NULL/.test(s.sql) && s.args.includes('kay')),
    'and it should not sit in the scoring queue'
  );
});

test('tables of different games are different products', () => {
  // All three keyed as local:table and drew one $300 comp pool in production.
  const keys = ['Pool table', '8 person poker table', 'Harvard Foosball Table'].map(
    (t) => matchProduct(t, 'furniture').product_key
  );
  assert.equal(new Set(keys).size, 3, keys.join(' '));
  // ...but the same table written two ways still shares one pool.
  assert.equal(
    matchProduct('Pool table', 'furniture').product_key,
    matchProduct('Pool Tables - moving sale', 'furniture').product_key
  );
});
