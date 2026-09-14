import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.js';
import Login from './components/Login.jsx';
import Filters from './components/Filters.jsx';
import Listings from './components/Listings.jsx';
import Inventory from './components/Inventory.jsx';
import Captured from './components/Captured.jsx';
import Watchlist from './components/Watchlist.jsx';
import Calibration from './components/Calibration.jsx';
import Detail from './components/Detail.jsx';
import PasswordChange from './components/PasswordChange.jsx';

const DEFAULT_FILTERS = {
  source: 'all',
  minProfit: '',
  minRoi: '',
  minConfidence: '',
  maxDistance: '',
};

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [allCategories, setAllCategories] = useState([]);
  const [selected, setSelected] = useState(null); // null until categories load

  const [view, setView] = useState('opportunities');
  const [rows, setRows] = useState([]);
  const [owned, setOwned] = useState([]);
  const [calibration, setCalibration] = useState(null);
  const [captured, setCaptured] = useState(null);
  const [saved, setSaved] = useState(null);
  const [query, setQuery] = useState('');
  // The Captured tab's reason filter. Held here, not in the tab, so it survives
  // switching tabs and applies server-side to everything captured.
  const [reason, setReason] = useState(null);
  // Captured pages: the cursor that starts each page reached so far, for the
  // view (source, search, reason) they belong to. Any other view starts over
  // at page one — derived in refresh rather than reset by an effect, which
  // would fetch twice.
  const [paging, setPaging] = useState({ key: '', cursors: [null], index: 0 });
  const capturedKey = `${filters.source}|${query}|${reason ?? ''}`;
  // Which view the tallies on screen were counted for.
  const talliesKey = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [signedOutNotice, setSignedOutNotice] = useState(null);

  // A stale response from a slower earlier request must not overwrite a newer one.
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!api.getToken()) {
      setBooting(false);
      return;
    }
    api
      .me()
      .then((d) => setUser(d.user))
      .catch(() => api.clearToken())
      .finally(() => setBooting(false));
  }, []);

  const refresh = useCallback(async () => {
    if (!user) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);

    try {
      if (view === 'watchlist') {
        const data = await api.watchlist();
        if (seq !== requestSeq.current) return;
        setSaved(data);
        return;
      }

      if (view === 'captured') {
        const page = paging.key === capturedKey ? paging : { cursors: [null], index: 0 };
        // Tallies scan every listing and don't change between pages, so they're
        // fetched on page one and carried forward.
        const tallies = page.index === 0 || talliesKey.current !== capturedKey;
        const data = await api.captured({
          source: filters.source,
          q: query,
          reason,
          cursor: page.cursors[page.index],
          tallies,
        });
        if (seq !== requestSeq.current) return;
        if (tallies) talliesKey.current = capturedKey;
        setCaptured((prev) => ({
          ...(tallies ? {} : { summary: prev?.summary, total: prev?.total, matching: prev?.matching }),
          ...data,
          key: capturedKey,
          page: page.index,
        }));
        return;
      }

      if (view === 'inventory') {
        const [data, calib] = await Promise.all([api.inventory(), api.calibration()]);
        if (seq !== requestSeq.current) return;
        setOwned(data.items);
        setCalibration(calib);
        return;
      }

      const cats = await api.categories(filters.source);
      if (seq !== requestSeq.current) return;
      setAllCategories(cats.categories);

      // First load selects everything, matching the Select All default.
      const names = cats.categories.map((c) => c.category);
      const chosen = selected ?? names;
      if (selected === null) setSelected(names);

      const isSubset = chosen.length && chosen.length < names.length;
      const data = await api.listings({
        ...filters,
        categories: isSubset ? chosen : [],
      });
      if (seq !== requestSeq.current) return;
      setRows(data.listings);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      if (err.status === 401) {
        api.clearToken();
        setUser(null);
      } else {
        setError(err.message);
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [user, filters, selected, view, query, reason, paging, capturedKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function turnPage(step) {
    setPaging((p) => {
      const base = p.key === capturedKey ? p : { key: capturedKey, cursors: [null], index: 0 };
      if (step > 0) {
        if (!captured?.next_cursor) return base;
        return {
          key: capturedKey,
          cursors: [...base.cursors.slice(0, base.index + 1), captured.next_cursor],
          index: base.index + 1,
        };
      }
      return { ...base, index: Math.max(0, base.index - 1) };
    });
    window.scrollTo({ top: 0 });
  }

  // Updated locally first so the star responds instantly while triaging a long
  // list; only a failure costs a refetch.
  async function toggleWatch(listing) {
    const next = !listing.watched;

    setCaptured((c) =>
      c
        ? { ...c, listings: c.listings.map((l) => (l.id === listing.id ? { ...l, watched: next } : l)) }
        : c
    );
    setRows((rs) => rs.map((l) => (l.id === listing.id ? { ...l, watched: next } : l)));
    if (!next) {
      setSaved((s) =>
        s ? { ...s, count: s.count - 1, listings: s.listings.filter((l) => l.id !== listing.id) } : s
      );
    }

    try {
      if (next) await api.watch(listing.id);
      else await api.unwatch(listing.id);
    } catch {
      refresh();
    }
  }

  function signOut(notice = null) {
    api.clearToken();
    setUser(null);
    setRows([]);
    setSelected(null);
    setShowPassword(false);
    setSignedOutNotice(notice);
  }

  if (booting) return <div className="boot">Loading…</div>;
  if (!user) return <Login onSignedIn={setUser} notice={signedOutNotice} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <h1>Flip Finder</h1>
        </div>
        <div className="who">
          <span>{user.name}</span>
          <button type="button" className="link" onClick={() => setShowPassword(true)}>
            Password
          </button>
          <button type="button" className="link" onClick={() => signOut()}>
            Sign Out
          </button>
        </div>
      </header>

      <nav className="views" aria-label="View">
        <button
          type="button"
          className={view === 'opportunities' ? 'view on' : 'view'}
          onClick={() => setView('opportunities')}
        >
          Opportunities
        </button>
        <button
          type="button"
          className={view === 'captured' ? 'view on' : 'view'}
          onClick={() => setView('captured')}
        >
          Captured
        </button>
        <button
          type="button"
          className={view === 'watchlist' ? 'view on' : 'view'}
          onClick={() => setView('watchlist')}
        >
          Watchlist
        </button>
        <button
          type="button"
          className={view === 'inventory' ? 'view on' : 'view'}
          onClick={() => setView('inventory')}
        >
          Inventory
        </button>
      </nav>

      {view === 'opportunities' && (
        <Filters
          filters={filters}
          onChange={setFilters}
          categories={allCategories}
          selected={selected ?? []}
          onSelectedChange={setSelected}
        />
      )}

      <main>
        {error && <p className="error">{error}</p>}
        {view === 'opportunities' && (
          <Listings rows={rows} loading={loading} onOpen={setDetail} />
        )}
        {view === 'captured' && (
          <Captured
            data={captured}
            loading={loading}
            onOpen={setDetail}
            onToggleWatch={toggleWatch}
            query={query}
            onQueryChange={setQuery}
            reason={reason}
            onReasonChange={setReason}
            onNextPage={() => turnPage(1)}
            onPrevPage={() => turnPage(-1)}
          />
        )}
        {view === 'watchlist' && (
          <Watchlist
            data={saved}
            loading={loading}
            onOpen={setDetail}
            onToggleWatch={toggleWatch}
          />
        )}
        {view === 'inventory' && (
          <>
            <Calibration data={calibration} />
            <Inventory items={owned} loading={loading} onOpen={setDetail} />
          </>
        )}
      </main>

      {showPassword && (
        <PasswordChange
          onClose={() => setShowPassword(false)}
          onChanged={() => signOut('Password changed. Sign in with your new one.')}
        />
      )}

      {detail && (
        <Detail
          listing={detail}
          onClose={() => setDetail(null)}
          onChanged={() => {
            setDetail(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
