import { useEffect, useRef, useState } from 'react';

const SOURCES = [
  { id: 'all', label: 'All' },
  { id: 'craigslist', label: 'Craigslist' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'ebay', label: 'eBay' },
];

const LABELS = {
  electronics: 'Electronics',
  furniture: 'Furniture',
  appliances: 'Appliances',
  tools: 'Tools',
  outdoor: 'Outdoor',
  auto: 'Auto',
  home: 'Home',
  apparel: 'Apparel',
  toys: 'Toys',
  music: 'Music',
  other: 'Other',
};

export default function Filters({ filters, onChange, categories, selected, onSelectedChange }) {
  // Open on desktop where there is room — a filter you can't see isn't a
  // filter. Still collapsible on phones, where it would push the ranking off
  // the first screen.
  const [open, setOpen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches
  );
  const allRef = useRef(null);

  const names = categories.map((c) => c.category);
  const allChecked = names.length > 0 && selected.length === names.length;
  const noneChecked = selected.length === 0;

  // Indeterminate is a property, not an attribute — it can only be set in JS.
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = !allChecked && !noneChecked;
  }, [allChecked, noneChecked]);

  const set = (patch) => onChange({ ...filters, ...patch });

  // Blank means "use the model default", so any non-blank threshold is a
  // deliberate override and is what the reset offers to undo.
  const THRESHOLDS = ['minProfit', 'minRoi', 'minConfidence', 'maxDistance'];
  const overridden = THRESHOLDS.filter((k) => filters[k] !== '');

  const resetThresholds = () =>
    set(Object.fromEntries(THRESHOLDS.map((k) => [k, ''])));

  function toggleCategory(name) {
    onSelectedChange(
      selected.includes(name) ? selected.filter((c) => c !== name) : [...selected, name]
    );
  }

  return (
    <div className="filters">
      <nav className="tabs" aria-label="Source">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={filters.source === s.id ? 'tab on' : 'tab'}
            onClick={() => set({ source: s.id })}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <button
        type="button"
        className="disclosure"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? 'Hide Filters' : 'Filters'}
        <span className="count">
          {allChecked ? 'All Categories' : `${selected.length} of ${names.length}`}
        </span>
      </button>

      <div className="panel" hidden={!open}>
        <fieldset className="cats">
          <legend>Categories</legend>

          <label className="cat all">
            <input
              ref={allRef}
              type="checkbox"
              checked={allChecked}
              onChange={() => onSelectedChange(allChecked ? [] : names)}
            />
            <span>Select All</span>
          </label>

          <div className="cat-grid">
            {categories.map((c) => (
              <label key={c.category} className="cat">
                <input
                  type="checkbox"
                  checked={selected.includes(c.category)}
                  onChange={() => toggleCategory(c.category)}
                />
                <span>{LABELS[c.category] ?? c.category}</span>
                <span className="n">{c.count}</span>
              </label>
            ))}
          </div>

          {noneChecked && <p className="hint">Nothing selected — showing every category.</p>}
        </fieldset>

        <fieldset className="nums">
          <legend>Thresholds</legend>

          <label>
            <span>Min Profit</span>
            <input
              type="number"
              inputMode="decimal"
              placeholder="25"
              value={filters.minProfit}
              onChange={(e) => set({ minProfit: e.target.value })}
            />
          </label>

          <label>
            <span>Min ROI %</span>
            <input
              type="number"
              inputMode="decimal"
              placeholder="25"
              value={filters.minRoi === '' ? '' : Math.round(filters.minRoi * 100)}
              onChange={(e) =>
                set({ minRoi: e.target.value === '' ? '' : Number(e.target.value) / 100 })
              }
            />
          </label>

          <label>
            <span>Min Confidence</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.05"
              placeholder="0.70"
              value={filters.minConfidence}
              onChange={(e) => set({ minConfidence: e.target.value })}
            />
          </label>

          <label>
            <span>Max Miles</span>
            <input
              type="number"
              inputMode="numeric"
              placeholder="Any"
              value={filters.maxDistance}
              onChange={(e) => set({ maxDistance: e.target.value })}
            />
          </label>

          <div className="nums-foot">
            <p className="hint">
              Blank uses the model default. Shipped listings ignore the distance limit.
            </p>
            {overridden.length > 0 && (
              <button type="button" className="reset" onClick={resetThresholds}>
                Reset to Default
                <span className="n">{overridden.length}</span>
              </button>
            )}
          </div>
        </fieldset>
      </div>
    </div>
  );
}
