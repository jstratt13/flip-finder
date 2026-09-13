import { useEffect, useState } from 'react';
import * as api from '../api.js';
import { money, pct } from './Listings.jsx';

const ANCHOR_LABEL = {
  local: 'Local asking prices',
  blended: 'eBay new + used',
  active: 'eBay used listings',
  retail: 'eBay new listings',
};

const VENUES = [
  { id: 'facebook', label: 'Facebook' },
  { id: 'ebay', label: 'eBay' },
  { id: 'other', label: 'Other' },
];

function Row({ label, value, note, strong }) {
  return (
    <div className={strong ? 'row strong' : 'row'}>
      <span className="label">
        {label}
        {note && <em>{note}</em>}
      </span>
      <span className="value">{value}</span>
    </div>
  );
}

export default function Detail({ listing, onClose, onChanged }) {
  const owned = listing.acquisition_id != null;
  const sold = listing.sale_id != null;

  const [pricePaid, setPricePaid] = useState(String(listing.price ?? ''));
  const [pickupCost, setPickupCost] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [venue, setVenue] = useState('facebook');
  const [fees, setFees] = useState('');
  const [shipping, setShipping] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Optimistic locally so the star responds immediately; the list refreshes on
  // close, which is when the change needs to be visible elsewhere.
  const [watched, setWatched] = useState(Boolean(listing.watched));
  const [watchBusy, setWatchBusy] = useState(false);

  async function toggleWatch() {
    const next = !watched;
    setWatchBusy(true);
    setError(null);
    try {
      if (next) await api.watch(listing.id);
      else await api.unwatch(listing.id);
      setWatched(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setWatchBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const overhead =
    listing.acquisition_cost != null && listing.price != null
      ? listing.acquisition_cost - listing.price
      : null;

  async function submitAcquire(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.acquire({
        listing_id: listing.id,
        price_paid: Number(pricePaid),
        pickup_cost: pickupCost === '' ? 0 : Number(pickupCost),
        notes: notes || null,
      });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitSale(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.recordSale({
        acquisition_id: listing.acquisition_id,
        venue,
        sale_price: Number(salePrice),
        fees_paid: fees === '' ? 0 : Number(fees),
        shipping_paid: shipping === '' ? 0 : Number(shipping),
        notes: notes || null,
      });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-label={listing.title}>
      <div className="scrim" onClick={onClose} />
      <div className="sheet">
        <header>
          <h2>{listing.title}</h2>
          <button type="button" className="close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="sheet-body">
          {listing.thumb_url && (
            <img className="hero" src={listing.thumb_url} alt="" />
          )}

          {!owned && (
            <section className="math">
              <h3>How this was valued</h3>
              <Row
                label="Anchor"
                note={ANCHOR_LABEL[listing.anchor_source] ?? listing.anchor_source}
                value={money(listing.anchor_value)}
              />
              <Row
                label="Est. net after fees"
                note={listing.condition_band?.replace('_', ' ')}
                value={money(listing.est_net_blended)}
              />
              <Row label="Asking price" value={`− ${money(listing.price)}`} />
              {overhead ? (
                <Row
                  label={listing.acquisition_mode === 'shipped' ? 'Shipping to you' : 'Pickup drive'}
                  note={
                    listing.acquisition_mode === 'shipped'
                      ? null
                      : listing.distance_mi != null
                        ? `${listing.geo_source === 'city' ? 'approx ' : ''}${listing.distance_mi.toFixed(1)} mi round trip${
                            listing.geo_source === 'city' ? ', from city centre' : ''
                          }`
                        : null
                  }
                  value={`− ${money(overhead)}`}
                />
              ) : null}
              <Row label="Estimated profit" value={money(listing.profit)} strong />
              <Row label="Return" value={pct(listing.roi)} />
              <Row label="Confidence" value={listing.confidence?.toFixed(2) ?? '—'} />
              {listing.price_drop_pct > 0 && (
                <Row
                  label="Seller has dropped"
                  note={
                    listing.days_listed
                      ? `from ${money(listing.original_price)} over ${Math.round(listing.days_listed)} days`
                      : `from ${money(listing.original_price)}`
                  }
                  value={`−${Math.round(listing.price_drop_pct * 100)}%`}
                />
              )}
            </section>
          )}

          {owned && (
            <section className="math">
              <h3>Outcome</h3>
              <Row label="Paid" value={money(listing.acquisition_cost)} />
              <Row label="Model predicted" value={money(listing.predicted_profit)} />
              {sold && <Row label="Sold on" note={listing.venue} value={money(listing.sale_price)} />}
              {sold && <Row label="Actual profit" value={money(listing.actual_profit)} strong />}
              {sold && listing.variance != null && (
                <Row
                  label="Model was off by"
                  value={`${listing.variance >= 0 ? '+' : ''}${money(listing.variance)}`}
                />
              )}
            </section>
          )}

          <div className="detail-actions">
            <button
              type="button"
              className={watched ? 'watch-btn on' : 'watch-btn'}
              onClick={toggleWatch}
              disabled={watchBusy}
            >
              {watched ? '★ On Watchlist' : '☆ Save to Watchlist'}
            </button>

            {listing.url && (
              <a className="external" href={listing.url} target="_blank" rel="noreferrer">
                Open Original Listing
              </a>
            )}
          </div>

          {error && <p className="error">{error}</p>}

          {!owned && (
            <form className="act" onSubmit={submitAcquire}>
              <h3>Mark Acquired</h3>
              <div className="pair">
                <label>
                  <span>Price Paid</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={pricePaid}
                    onChange={(e) => setPricePaid(e.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>Pickup Cost</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="0"
                    value={pickupCost}
                    onChange={(e) => setPickupCost(e.target.value)}
                  />
                </label>
              </div>
              <label>
                <span>Notes</span>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              <button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Mark Acquired'}
              </button>
              <p className="hint">
                This freezes the current estimate so the model can be checked against what actually
                happens.
              </p>
            </form>
          )}

          {owned && !sold && (
            <form className="act" onSubmit={submitSale}>
              <h3>Record Sale</h3>
              <label>
                <span>Sold On</span>
                <select value={venue} onChange={(e) => setVenue(e.target.value)}>
                  {VENUES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="pair">
                <label>
                  <span>Sale Price</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={salePrice}
                    onChange={(e) => setSalePrice(e.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>Fees Paid</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="0"
                    value={fees}
                    onChange={(e) => setFees(e.target.value)}
                  />
                </label>
              </div>
              <label>
                <span>Shipping Paid</span>
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="0"
                  value={shipping}
                  onChange={(e) => setShipping(e.target.value)}
                />
              </label>
              <button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Record Sale'}
              </button>
              <p className="hint">
                Venue is recorded per sale, so the Facebook/eBay weighting corrects itself over time.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
