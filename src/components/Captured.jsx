import { money } from './Listings.jsx';

const SOURCE_LABEL = { craigslist: 'CL', facebook: 'FB', ebay: 'eBay' };

// Grouped by what you'd actually do about it, not by severity.
const REASON_ORDER = [
  'ranking',
  'no_comps',
  'low_profit',
  'low_confidence',
  'low_roi',
  'no_margin',
  'no_match',
  'no_price',
  'acquired',
  'gone',
];

const REASON_COPY = {
  ranking: 'In the ranking',
  no_comps: 'Awaiting comps',
  low_profit: 'Below profit floor',
  low_confidence: 'Below confidence floor',
  low_roi: 'Below ROI floor',
  no_margin: 'No margin',
  no_match: 'No product match',
  no_price: 'No price',
  acquired: 'Bought',
  gone: 'No longer listed',
};

// Only the reasons that mean something is wrong get colour. Everything else is
// ordinary — most captured listings simply aren't deals, and dressing that up
// as a problem would bury the ones that are.
const REASON_TONE = {
  ranking: 'ok',
  no_match: 'warn',
  no_price: 'warn',
  no_comps: 'info',
};

function ageText(lastSeen) {
  if (lastSeen == null) return '';
  const days = (Date.now() - lastSeen) / 86400000;
  if (days < 1) return 'today';
  if (days < 2) return '1d';
  return `${Math.round(days)}d`;
}

export default function Captured({
  data,
  loading,
  onOpen,
  onToggleWatch,
  query,
  onQueryChange,
  reason,
  onReasonChange,
}) {
  const search = (
    <div className="searchbar">
      <input
        type="search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search captured listings…"
        aria-label="Search captured listings"
      />
      {query && (
        <button type="button" className="link" onClick={() => onQueryChange('')}>
          Clear
        </button>
      )}
    </div>
  );

  if (loading && !data) {
    return (
      <>
        {search}
        <p className="status">Loading captured listings…</p>
      </>
    );
  }
  if (!data) return search;

  // Nothing captured (or nothing matches the search) at all. A reason filter
  // that happens to match nothing is handled below, with the tallies still
  // showing so it can be switched or cleared.
  if (!data.total) {
    return (
      <>
        {search}
        <div className="empty">
          <p className="empty-title">
            {query ? `Nothing matches "${query}".` : 'Nothing captured yet.'}
          </p>
          <p>
            {query
              ? 'Every word has to appear in the title or description. Try fewer words, or a distinctive one like a model number.'
              : 'Browse Craigslist or Facebook Marketplace with the extension running and listings will appear here within a minute or so — whether or not they are worth buying.'}
          </p>
        </div>
      </>
    );
  }

  // The active reason stays listed even at zero, so it can always be cleared.
  const counts = REASON_ORDER.filter((c) => data.summary[c] || c === reason).map((c) => ({
    code: c,
    label: REASON_COPY[c],
    n: data.summary[c] ?? 0,
  }));

  return (
    <>
      {search}

      <ul className="tally" aria-label="Filter by reason">
        {counts.map((c) => {
          const on = c.code === reason;
          return (
            <li key={c.code}>
              <button
                type="button"
                className={['tally-chip', REASON_TONE[c.code] ?? '', on ? 'on' : ''].join(' ').trim()}
                aria-pressed={on}
                onClick={() => onReasonChange(on ? null : c.code)}
                title={on ? 'Show every reason' : `Show only: ${c.label}`}
              >
                <b>{c.n}</b> {c.label}
              </button>
            </li>
          );
        })}
        {reason && (
          <li>
            <button type="button" className="link tally-clear" onClick={() => onReasonChange(null)}>
              Show all {data.total}
            </button>
          </li>
        )}
      </ul>

      {data.matching > data.count && (
        <p className="hint tally-cap">
          Showing the {data.count} most recently seen of {data.matching}.
        </p>
      )}

      {!data.count && (
        <div className="empty">
          <p className="empty-title">No listings with this reason right now.</p>
          <p>They may have been scored or bought since. Pick another reason, or show all.</p>
        </div>
      )}

      <ul className="rows">
        {data.listings.map((l) => (
          // Two sibling buttons rather than one nested inside the other, which
          // isn't valid markup — and saving while triaging shouldn't cost a
          // round trip into the detail sheet and back.
          <li key={l.id} className="row-wrap">
            <button
              type="button"
              className={l.watched ? 'row-star on' : 'row-star'}
              onClick={() => onToggleWatch(l)}
              aria-pressed={Boolean(l.watched)}
              title={l.watched ? 'Remove from watchlist' : 'Save to watchlist'}
            >
              {l.watched ? '★' : '☆'}
            </button>

            <button type="button" className="row-item" onClick={() => onOpen(l)}>
              <span className="r-src">{SOURCE_LABEL[l.source] ?? l.source}</span>
              <span className="r-title">{l.title}</span>
              <span className="r-price">{l.price == null ? '—' : money(l.price)}</span>
              <span className={`r-reason ${REASON_TONE[l.reason.code] ?? ''}`}>
                {l.reason.label}
              </span>
              <span className="r-age">{ageText(l.last_seen)}</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="hint" style={{ padding: '0 14px' }}>
        Most captured listings aren't deals — that's expected. This tab exists so an empty
        Opportunities tab can be told apart from capture having quietly stopped working. Star
        anything worth a second look; saved listings ignore every threshold.
      </p>
    </>
  );
}
