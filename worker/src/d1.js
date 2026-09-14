// D1 rejects any statement with more than 100 bound parameters ("too many SQL
// variables"). Every IN-list built from a batch has to be split, or the query
// works in testing and fails the first time a real backlog exceeds 100 — which
// is exactly how the cron silently stopped scoring anything.
//
// 90 leaves room for the extra parameters a query binds after the list.
export const MAX_IN = 90;

export const chunk = (arr, n = MAX_IN) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));

export const placeholders = (values) => values.map(() => '?').join(',');

// Runs `sql(ph)` once per chunk of `values`, binding the chunk then `extra`,
// and concatenates the rows.
export async function allIn(db, sql, values, extra = []) {
  const rows = [];
  for (const part of chunk(values)) {
    const { results } = await db.prepare(sql(placeholders(part))).bind(...part, ...extra).all();
    rows.push(...results);
  }
  return rows;
}
