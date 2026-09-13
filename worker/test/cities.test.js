import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordsForCity, CITY_COUNT } from '../src/cities.js';
import { normalize } from '../src/ingest.js';
import { HOME, haversineMi } from '../src/config.js';

test('resolves the city formats the sources actually emit', () => {
  // Facebook card: "Alhambra, CA". Craigslist: "santa ana". Detail page adds
  // the approximate-location suffix.
  for (const input of [
    'Alhambra, CA',
    'alhambra',
    'Alhambra, California',
    'Alhambra, CA · Location is approximate',
  ]) {
    assert.ok(coordsForCity(input), `failed to resolve "${input}"`);
  }
});

test('unknown cities resolve to null rather than a wrong guess', () => {
  assert.equal(coordsForCity('Portland, OR'), null);
  assert.equal(coordsForCity(''), null);
  assert.equal(coordsForCity(null), null);
});

test('the table is big enough to cover the metros in play', () => {
  assert.ok(CITY_COUNT > 100, `only ${CITY_COUNT} cities`);
});

test('coordinates place cities at plausible distances from home', () => {
  const d = (city) => {
    const c = coordsForCity(city);
    return haversineMi(HOME.lat, HOME.lon, c.lat, c.lon);
  };

  // Sanity-checks against real geography, from 92649 (Huntington Beach).
  //
  // The home city measures ~4.7 mi, not ~0: 92649 is Huntington Harbour at the
  // north end while the centroid sits downtown. That gap IS the approximation
  // error, and it bounds how precise any city-derived pickup cost can be —
  // roughly $3 of drive at $0.35/mi round trip.
  assert.ok(d('Huntington Beach, CA') < 7, 'home city should be within the centroid error');
  assert.ok(d('Fountain Valley, CA') < 8);
  assert.ok(d('Costa Mesa, CA') < 12);
  assert.ok(d('Long Beach, CA') > 8 && d('Long Beach, CA') < 20);
  assert.ok(d('Los Angeles, CA') > 25 && d('Los Angeles, CA') < 45);
  assert.ok(d('San Diego, CA') > 60 && d('San Diego, CA') < 100);
});

test('a Facebook listing with only a city name still gets a distance', () => {
  // This is the gap the table closes: without it, every FB listing had a null
  // distance and therefore no pickup cost at all.
  const n = normalize(
    {
      source: 'facebook',
      source_id: '1',
      title: 'Sony camera',
      price: 650,
      location_name: 'Claremont, CA',
      acquisition_mode: 'pickup',
    },
    HOME
  );

  assert.equal(n.geo_source, 'city');
  assert.ok(n.distance_mi > 20 && n.distance_mi < 50, `got ${n.distance_mi}`);
});

test('real coordinates are preferred over the city table', () => {
  const n = normalize(
    {
      source: 'craigslist',
      source_id: '2',
      title: 'Keyboard',
      price: 20,
      lat: 33.769986,
      lon: -117.85841,
      location_name: 'Los Angeles, CA',
      acquisition_mode: 'pickup',
    },
    HOME
  );

  assert.equal(n.geo_source, 'exact');
  // Santa Ana coordinates, not the Los Angeles centroid the name would give.
  assert.ok(n.distance_mi < 15, `got ${n.distance_mi}`);
});

test('shipped listings take no distance regardless of city', () => {
  const n = normalize(
    {
      source: 'ebay',
      source_id: '3',
      title: 'Headphones',
      price: 110,
      location_name: 'San Diego, CA',
      acquisition_mode: 'shipped',
      inbound_ship: 9.5,
    },
    HOME
  );

  assert.equal(n.distance_mi, null);
});
