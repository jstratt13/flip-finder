import { money } from './Listings.jsx';

export default function Inventory({ items, loading, onOpen }) {
  if (loading && !items.length) return <p className="status">Loading inventory…</p>;

  if (!items.length) {
    return (
      <div className="empty">
        <p className="empty-title">Nothing bought yet.</p>
        <p>
          Mark a listing acquired from the Opportunities tab and it will appear here, ready for you
          to record what it actually sold for.
        </p>
      </div>
    );
  }

  const open = items.filter((i) => i.sale_id == null);
  const closed = items.filter((i) => i.sale_id != null);

  return (
    <>
      <p className="status">
        {open.length} held · {closed.length} sold
      </p>
      <ul className="cards">
        {items.map((item) => {
          const done = item.sale_id != null;
          const delta = item.variance;
          return (
            <li key={item.acquisition_id}>
              <button type="button" className="card" onClick={() => onOpen(item)}>
                <div className="thumb">
                  {item.thumb_url ? (
                    <img src={item.thumb_url} alt="" loading="lazy" />
                  ) : (
                    <span className="no-img">No Photo</span>
                  )}
                  <span className="src">{done ? 'Sold' : 'Held'}</span>
                </div>

                <div className="body">
                  <h3>{item.title ?? item.listing_id}</h3>

                  <div className="figures">
                    <div className="fig">
                      <span className="k">Cost</span>
                      <span className="v">{money(item.acquisition_cost)}</span>
                    </div>
                    <div className="fig">
                      <span className="k">Predicted</span>
                      <span className="v">{money(item.predicted_profit)}</span>
                    </div>
                    <div className={done ? 'fig gain' : 'fig'}>
                      <span className="k">Actual</span>
                      <span className="v">{done ? money(item.actual_profit) : '—'}</span>
                    </div>
                  </div>

                  <div className="meta">
                    <span className="pill quiet">{item.acquired_by ?? 'Unknown'}</span>
                    {done && <span className="pill quiet">{item.venue}</span>}
                    {done && delta != null && (
                      <span className={`pill ${delta >= 0 ? 'high' : 'low'}`}>
                        {delta >= 0 ? '+' : ''}
                        {money(delta)} vs model
                      </span>
                    )}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
