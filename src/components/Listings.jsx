const SOURCE_LABEL = { craigslist: 'CL', facebook: 'FB', ebay: 'eBay' };

const BAND_LABEL = {
  new: 'New',
  like_new: 'Like New',
  good: 'Good',
  fair: 'Fair',
  parts: 'For Parts',
  unknown: 'Unknown',
};

export const money = (n) =>
  n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`;

export const pct = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);

const DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = 7;

// Capture is browse-triggered, so this says when the listing was last confirmed
// present — not that it's still available. Stating it plainly beats implying a
// certainty we don't have.
function freshness(lastSeen) {
  if (lastSeen == null) return null;
  const days = (Date.now() - lastSeen) / DAY;

  const text =
    days < 1 ? 'Seen today' : days < 2 ? 'Seen yesterday' : `Seen ${Math.round(days)}d ago`;

  return { text, stale: days >= STALE_DAYS };
}

// Confidence earns a word rather than a bare number: the figure only means
// something relative to the gate, and a colour alone can't say which side.
function confidenceLabel(c) {
  if (c == null) return { text: 'Unknown', level: 'low' };
  if (c >= 0.85) return { text: 'High', level: 'high' };
  if (c >= 0.7) return { text: 'Solid', level: 'mid' };
  return { text: 'Thin', level: 'low' };
}

function Card({ row, onOpen }) {
  const conf = confidenceLabel(row.confidence);
  const seen = freshness(row.last_seen);

  return (
    <button type="button" className="card" onClick={() => onOpen(row)}>
      <div className="thumb">
        {row.thumb_url ? (
          <img src={row.thumb_url} alt="" loading="lazy" />
        ) : (
          <span className="no-img">No Photo</span>
        )}
        <span className="src">{SOURCE_LABEL[row.source] ?? row.source}</span>
      </div>

      <div className="body">
        <h3>{row.title}</h3>

        <div className="figures">
          <div className="fig">
            <span className="k">Ask</span>
            <span className="v">{money(row.price)}</span>
          </div>
          <div className="fig gain">
            <span className="k">Profit</span>
            <span className="v">{money(row.profit)}</span>
          </div>
          <div className="fig">
            <span className="k">ROI</span>
            <span className="v">{pct(row.roi)}</span>
          </div>
        </div>

        <div className="meta">
          <span className={`pill ${conf.level}`}>{conf.text}</span>
          <span className="pill quiet">{BAND_LABEL[row.condition_band] ?? 'Unknown'}</span>
          {row.acquisition_mode === 'shipped' ? (
            <span className="pill quiet">Ships</span>
          ) : row.distance_mi != null ? (
            // "≈" marks a distance derived from a city centroid rather than
            // real coordinates, so the pickup cost behind it is an estimate.
            <span className="pill quiet" title={row.geo_source === 'city' ? 'Estimated from city' : 'From listing coordinates'}>
              {row.geo_source === 'city' ? '≈ ' : ''}
              {row.distance_mi.toFixed(1)} mi
            </span>
          ) : null}
          {row.price_drop_pct > 0.05 && (
            <span
              className="pill drop"
              title={`Was ${money(row.original_price)}${
                row.days_listed ? `, listed ${Math.round(row.days_listed)} days` : ''
              }`}
            >
              ↓ {Math.round(row.price_drop_pct * 100)}%
              {row.days_listed ? ` in ${Math.round(row.days_listed)}d` : ''}
            </span>
          )}
          {seen && (
            <span
              className={seen.stale ? 'pill mid' : 'pill quiet'}
              title={
                seen.stale
                  ? "Not confirmed recently — may be gone, or you just haven't browsed it"
                  : 'When this listing was last seen in a capture'
              }
            >
              {seen.text}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

export default function Listings({ rows, loading, onOpen }) {
  if (loading && !rows.length) return <p className="status">Finding opportunities…</p>;

  if (!rows.length) {
    return (
      <div className="empty">
        <p className="empty-title">Nothing clears the gates right now.</p>
        <p>
          Either no captured listing beats the profit, ROI and confidence thresholds, or nothing has
          been captured yet. Browse Craigslist or Facebook with the extension running, then check
          back.
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="status">
        {rows.length} {rows.length === 1 ? 'opportunity' : 'opportunities'}
        {loading ? ' · refreshing…' : ''}
      </p>
      <ul className="cards">
        {rows.map((row) => (
          <li key={row.id}>
            <Card row={row} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </>
  );
}
