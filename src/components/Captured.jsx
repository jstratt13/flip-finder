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

export default function Captured({ data, loading, onOpen }) {
  if (loading && !data) return <p className="status">Loading captured listings…</p>;
  if (!data) return null;

  if (!data.count) {
    return (
      <div className="empty">
        <p className="empty-title">Nothing captured yet.</p>
        <p>
          Browse Craigslist or Facebook Marketplace with the extension running and listings will
          appear here within a minute or so — whether or not they're worth buying.
        </p>
      </div>
    );
  }

  const counts = REASON_ORDER.filter((c) => data.summary[c]).map((c) => ({
    code: c,
    label: REASON_COPY[c],
    n: data.summary[c],
  }));

  return (
    <>
      <ul className="tally">
        {counts.map((c) => (
          <li key={c.code} className={REASON_TONE[c.code] ?? ''}>
            <b>{c.n}</b> {c.label}
          </li>
        ))}
      </ul>

      <ul className="rows">
        {data.listings.map((l) => (
          <li key={l.id}>
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
        Opportunities tab can be told apart from capture having quietly stopped working.
      </p>
    </>
  );
}
