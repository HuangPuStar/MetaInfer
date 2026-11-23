/**
 * Multi-trace comparison for the profiling viewer.
 *
 * "Open two traces side by side" is the only way an operator can tell whether a
 * kernel change actually paid off, so the comparison is computed on the Host from
 * the already-parsed indexes (no re-parse, no upload) and aligned by kernel name:
 *
 *   rows[i] = { name, perTrace: [{ traceId, count, sumUs, avgUs }], fastest, deltaPct }
 *
 * `deltaPct` is relative to the first trace in the requested order, which keeps
 * "A vs B" readable: +12% means B is 12% slower on that kernel than A.
 */

/** Hard cap on returned rows; the totals always describe every kernel. */
export const COMPARE_MAX_ROWS = 200;

/**
 * @param {Array<{index: object, nodeId?: string|null}>} entries parsed trace indexes, query-order
 * @param {{maxRows?: number}} [options]
 */
export function compareTraces(entries, options = {}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && entry.index) : [];
  if (list.length < 2) {
    throw Object.assign(new Error('compare needs at least two open traces'), { code: 'bad_request' });
  }
  const maxRows = Number.isFinite(options.maxRows) ? Math.max(1, Math.trunc(options.maxRows)) : COMPARE_MAX_ROWS;
  const columns = list.map((entry) => ({
    traceId: entry.index.traceId,
    name: entry.index.name,
    nodeId: entry.nodeId ?? entry.index.nodeId ?? null,
    sourcePath: entry.index.sourcePath ?? null,
  }));

  // name -> per-column {count, sumUs}
  const byName = new Map();
  list.forEach((entry, columnIndex) => {
    const aggregates = entry.index.__aggregates ?? null;
    const rows = aggregates ? aggregates.rows : [];
    for (const row of rows) {
      if (!byName.has(row.name)) byName.set(row.name, columns.map(() => ({ count: 0, sumUs: 0 })));
      const bucket = byName.get(row.name)[columnIndex];
      bucket.count += row.count;
      bucket.sumUs += row.sumUs;
    }
  });

  const rows = [...byName.entries()].map(([name, buckets]) => {
    const perTrace = buckets.map((bucket, columnIndex) => ({
      traceId: columns[columnIndex].traceId,
      count: bucket.count,
      sumUs: round3(bucket.sumUs),
      avgUs: bucket.count > 0 ? round3(bucket.sumUs / bucket.count) : 0,
    }));
    const baseline = perTrace[0].sumUs;
    const deltaPct = perTrace.map((cell, columnIndex) => {
      if (columnIndex === 0) return 0;
      if (baseline <= 0) return cell.sumUs > 0 ? null : 0;
      return round3(((cell.sumUs - baseline) / baseline) * 100);
    });
    let fastest = 0;
    perTrace.forEach((cell, columnIndex) => {
      if (cell.sumUs > 0 && (perTrace[fastest].sumUs === 0 || cell.sumUs < perTrace[fastest].sumUs)) fastest = columnIndex;
    });
    const peak = Math.max(...perTrace.map((cell) => cell.sumUs));
    return { name, perTrace, deltaPct, fastest, peakUs: round3(peak) };
  });

  rows.sort((a, b) => (b.peakUs - a.peakUs) || a.name.localeCompare(b.name));

  const totals = list.map((entry, columnIndex) => {
    const aggregates = entry.index.__aggregates ?? null;
    const totalUs = aggregates ? aggregates.totalKernelUs : 0;
    const kernelCount = entry.index.kernels?.length ?? 0;
    return {
      traceId: columns[columnIndex].traceId,
      name: columns[columnIndex].name,
      nodeId: columns[columnIndex].nodeId,
      totalKernelUs: round3(totalUs),
      kernelCount,
      kernelNameCount: aggregates ? aggregates.rows.length : 0,
    };
  });
  const baselineTotal = totals[0].totalKernelUs;
  totals.forEach((total, columnIndex) => {
    total.deltaPct = columnIndex === 0
      ? 0
      : (baselineTotal > 0 ? round3(((total.totalKernelUs - baselineTotal) / baselineTotal) * 100) : null);
  });

  return {
    columns,
    totals,
    rows: rows.slice(0, maxRows),
    rowCount: rows.length,
    truncated: rows.length > maxRows,
  };
}

function round3(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 1000) / 1000;
}
