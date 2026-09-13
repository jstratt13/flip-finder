import { money, pct } from './Listings.jsx';

const SOURCE_LABEL = { craigslist: 'CL', facebook: 'FB', ebay: 'eBay' };

function ageText(ts) {
  if (ts == null) return '';
  const days = (Date.now() - ts) / 86400000;
  if (days < 1) return 'today';
  if (days < 2) return '1d';
  return `${Math.round(days)}d`;
}

export default function Watchlist({ data, loading, onOpen, onToggleWatch }) {
  if (loading && !data) return <p className="status">Loading watchlist…</p>;
  if (!data) return null;

  if (!data.count) {
    return (
      <div className="empty">
        <p className="empty-title">Nothing saved yet.</p>
        <p>
          Open any listing — from Opportunities or Captured — and choose <strong>Save to
          Watchlist</strong>. Saved listings stay here regardless of score, comps, or thresholds.
        </p>
        <p>
          This is where you overrule the model: something it can't price, or a hunch it has no way
          to know about.
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="status">
        {data.count} saved · shown regardless of score
      </p>

      <ul className="rows">
        {data.listings.map((l) => (
          <li key={l.id} className="row-wrap">
            <button
              type="button"
              className="row-star on"
              onClick={() => onToggleWatch(l)}
              aria-pressed="true"
              title="Remove from watchlist"
            >
              ★
            </button>

            <button type="button" className="row-item watch-row" onClick={() => onOpen(l)}>
              <span className="r-src">{SOURCE_LABEL[l.source] ?? l.source}</span>
              <span className="r-title">
                {l.title}
                {l.acquired ? ' · bought' : ''}
                {l.status !== 'active' ? ' · no longer listed' : ''}
              </span>
              <span className="r-reason">
                {l.score != null
                  ? `${money(l.profit)} · ${pct(l.roi)}`
                  : 'Not priced'}
              </span>
              <span className="r-price">{l.price == null ? '—' : money(l.price)}</span>
              <span className="r-age" title={`Saved by ${l.added_by ?? 'someone'}`}>
                {ageText(l.added_at)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="hint" style={{ padding: '0 14px' }}>
        Saved items ignore every gate, so some will show no estimate at all — that's the point.
        Tap the star to remove one.
      </p>
    </>
  );
}
