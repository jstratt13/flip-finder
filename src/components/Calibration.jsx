import { money } from './Listings.jsx';

const BIAS_COPY = {
  optimistic: 'Estimates run high — flips return less than predicted.',
  conservative: 'Estimates run low — flips return more than predicted.',
  balanced: 'Estimates are landing close to reality.',
};

const BAND_LABEL = {
  new: 'New',
  like_new: 'Like New',
  good: 'Good',
  fair: 'Fair',
  parts: 'For Parts',
  unknown: 'Unknown',
};

const VENUE_LABEL = { facebook: 'Facebook', ebay: 'eBay', other: 'Other' };

const pctOf = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);

function Suggestion({ label, current, suggested, sales }) {
  if (suggested == null) return null;
  const delta = suggested - current;
  if (Math.abs(delta) < 0.01) return null;

  return (
    <li>
      <span className="sug-label">{label}</span>
      <span className="sug-move">
        <b>{current}</b> → <b>{suggested}</b>
      </span>
      <span className="sug-n">{sales} sales</span>
    </li>
  );
}

function LocalMarket({ lm }) {
  if (!lm || !lm.products_compared) return null;

  const pct = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);
  const spread = lm.p75_ratio != null ? lm.p75_ratio - lm.p25_ratio : null;
  const noisy = spread != null && spread > 0.3;

  return (
    <>
      <h4>Local market vs national</h4>

      {!lm.ready ? (
        <p className="hint">
          {lm.products_compared} of {lm.min_products_needed} products compared. Needs sightings of
          the same item both locally and on eBay — keep browsing and this fills in.
        </p>
      ) : (
        <>
          <p className="bias balanced" style={{ marginBottom: 10 }}>
            Local asks run <strong>{pct(lm.median_ratio)}</strong> of national, across{' '}
            {lm.products_compared} products.
          </p>

          <ul className="mix">
            <li>
              <span className="sug-label">Facebook price factor</span>
              <span className="sug-move">
                <b>{lm.current_price_factor}</b> → <b>{lm.suggested_price_factor}</b>
              </span>
              <span className="sug-n">{lm.local_listings_used} listings</span>
            </li>
            <li>
              <span className="sug-label">Spread (25th–75th)</span>
              <span className="sug-move">
                {pct(lm.p25_ratio)} – {pct(lm.p75_ratio)}
              </span>
            </li>
          </ul>

          {lm.was_clamped && (
            <p className="warn-note">
              <strong>Clamped.</strong> The raw measurement was{' '}
              <b>{lm.raw_suggestion}</b>, outside the {lm.bounds.min}–{lm.bounds.max} band a real
              market plausibly produces. Usually a thin or skewed sample rather than a genuine
              effect — worth a look before trusting it.
            </p>
          )}

          {noisy && (
            <p className="warn-note">
              <strong>Wide spread.</strong> Products disagree with each other by more than 30
              points, so this median isn't describing a consistent market difference yet. Treat it
              as weak until more products land.
            </p>
          )}

          <p className="hint">
            Both sides are asking prices, so this measures how local <em>asks</em> compare to
            national ones — not how much harder buyers haggle on either platform. Only recorded
            sales close that gap.
          </p>
        </>
      )}
    </>
  );
}

export default function Calibration({ data }) {
  if (!data) return null;

  if (!data.ready) {
    const have = data.sales_with_prediction;
    const need = data.min_sales_for_suggestions;
    return (
      <section className="calib pending">
        <h3>Calibration</h3>
        <p>
          {have === 0
            ? 'No completed flips yet.'
            : `${have} of ${need} completed flips recorded.`}{' '}
          The model's starting numbers are guesses until there's enough history to check them
          against. Suggestions unlock at {need}.
        </p>
        <div className="bar" role="img" aria-label={`${have} of ${need}`}>
          <span style={{ width: `${Math.min(100, (have / need) * 100)}%` }} />
        </div>

        {/* Needs no sales at all, only browsing, so it can be useful long
            before the outcome history is. */}
        <LocalMarket lm={data.local_market} />
      </section>
    );
  }

  const { accuracy, venue_mix, venue_accuracy, by_condition } = data;

  const suggestions = [
    ...venue_accuracy.map((v) => ({
      key: `venue-${v.venue}`,
      label: `${VENUE_LABEL[v.venue] ?? v.venue} price factor`,
      current: v.current_price_factor,
      suggested: v.suggested_price_factor,
      sales: v.sales,
    })),
    ...by_condition.map((b) => ({
      key: `band-${b.band}`,
      label: `${BAND_LABEL[b.band] ?? b.band} multiplier`,
      current: b.current_multiplier,
      suggested: b.suggested_multiplier,
      sales: b.sales,
    })),
  ].filter((s) => s.suggested != null);

  return (
    <section className="calib">
      <h3>Calibration</h3>

      <p className={`bias ${accuracy.bias}`}>{BIAS_COPY[accuracy.bias]}</p>

      <dl className="calib-stats">
        <div>
          <dt>Typical miss</dt>
          <dd>{money(accuracy.median_profit_error)}</dd>
        </div>
        <div>
          <dt>Within 25%</dt>
          <dd>{pctOf(accuracy.within_25pct)}</dd>
        </div>
        <div>
          <dt>Flips measured</dt>
          <dd>{data.sales_with_prediction}</dd>
        </div>
      </dl>

      <LocalMarket lm={data.local_market} />

      <h4>Where you actually sell</h4>
      <ul className="mix">
        {venue_mix.map((v) => (
          <li key={v.venue}>
            <span className="sug-label">{VENUE_LABEL[v.venue] ?? v.venue}</span>
            <span className="sug-move">
              assumed <b>{pctOf(v.configured_share)}</b> · actual <b>{pctOf(v.measured_share)}</b>
            </span>
            <span className="sug-n">{v.sales} sales</span>
          </li>
        ))}
      </ul>

      {suggestions.length > 0 && (
        <>
          <h4>Suggested changes</h4>
          <ul className="mix">
            {suggestions.map((s) => (
              <Suggestion
                key={s.key}
                label={s.label}
                current={s.current}
                suggested={s.suggested}
                sales={s.sales}
              />
            ))}
          </ul>
          <p className="warn-note">
            <strong>Apply one at a time.</strong> These aren't independent — a single systematic
            error shows up in every row at once, so changing two that share a ratio corrects the
            same bias twice. Pick the one backed by the most sales, change it, then let a few more
            flips land before touching another.
          </p>
          <p className="hint">
            Nothing is applied automatically. Edit <code>worker/src/config.js</code> if you agree
            with a change — the sale history stays as the record either way.
          </p>
        </>
      )}
    </section>
  );
}
