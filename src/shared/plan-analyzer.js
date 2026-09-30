// Reads an EXPLAIN (FORMAT JSON) plan: flattens the node tree with the time
// spent in each node itself, and points out common problems — sequential
// scans that discard most rows, bad row estimates, sorts and hashes that
// spill to disk, and foreign keys without an index on the tables involved.

import { allTables, findTable } from './schema-model.js';

// plan: the object inside EXPLAIN's JSON array ({ Plan, Planning Time, … }).
export function flattenPlan(plan) {
  const nodes = [];
  const walk = (node, depth, parent) => {
    const loops = node['Actual Loops'] ?? 1;
    const total = node['Actual Total Time'] !== undefined ? node['Actual Total Time'] * loops : null;
    const entry = {
      id: nodes.length,
      parent,
      depth,
      type: node['Node Type'],
      relation: node['Relation Name'] ? `${node.Schema ? `${node.Schema}.` : ''}${node['Relation Name']}` : null,
      alias: node.Alias ?? null,
      index: node['Index Name'] ?? null,
      joinType: node['Join Type'] ?? null,
      strategy: node.Strategy ?? null,
      cost: node['Total Cost'],
      startupCost: node['Startup Cost'],
      planRows: node['Plan Rows'],
      actualRows: node['Actual Rows'] !== undefined ? node['Actual Rows'] * loops : null,
      loops,
      totalTime: total,
      selfTime: total,
      filter: node.Filter ?? node['Index Cond'] ?? node['Hash Cond'] ?? node['Join Filter'] ?? node['Recheck Cond'] ?? null,
      rowsRemoved: (node['Rows Removed by Filter'] ?? 0) * loops + (node['Rows Removed by Join Filter'] ?? 0) * loops,
      sortMethod: node['Sort Method'] ?? null,
      sortSpace: node['Sort Space Type'] ?? null,
      hashBatches: node['Hash Batches'] ?? null,
      sortKey: node['Sort Key'] ?? null,
      raw: node,
    };
    nodes.push(entry);
    for (const child of node.Plans ?? []) {
      const c = walk(child, depth + 1, entry.id);
      if (entry.selfTime !== null && c.totalTime !== null && child['Parent Relationship'] !== 'InitPlan' && child['Parent Relationship'] !== 'SubPlan')
        entry.selfTime -= c.totalTime;
    }
    if (entry.selfTime !== null) entry.selfTime = Math.max(0, entry.selfTime);
    return entry;
  };
  walk(plan.Plan ?? plan, 0, null);
  const total = plan['Execution Time'] ?? nodes[0]?.totalTime ?? null;
  for (const n of nodes) n.percent = total && n.selfTime !== null ? (100 * n.selfTime) / total : null;
  return { nodes, planningTime: plan['Planning Time'] ?? null, executionTime: plan['Execution Time'] ?? null, analyzed: nodes[0]?.totalTime !== null };
}

const escapeRegExp = (s) => String(s).replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

// Column names mentioned in a filter expression like "(departamento_id = 3)".
// Quoted names can contain any character, so they are escaped in full.
const filterColumns = (filter, table) =>
  table ? table.columns.map((c) => c.name).filter((n) => new RegExp(`(^|[^A-Za-z0-9_])"?${escapeRegExp(n)}"?([^A-Za-z0-9_(]|$)`).test(filter ?? '')) : [];

const indexed = (table, col) =>
  (table.primaryKey?.columns[0] === col) ||
  table.uniques.some((u) => u.columns[0] === col) ||
  (table.indexes ?? []).some((i) => i.columns[0] === col);

// Suggestions: [{ severity: 'warning' | 'info', node, message, sql? }]
export function analyzePlan(flat, schema = null) {
  const out = [];
  const tableOf = (rel) => (schema && rel ? findTable(schema, rel) : null);
  for (const n of flat.nodes) {
    const rows = n.actualRows ?? n.planRows;
    if (n.type === 'Seq Scan' && n.filter && n.rowsRemoved > 1000 && n.rowsRemoved > 4 * (rows ?? 0)) {
      const t = tableOf(n.relation);
      const cols = filterColumns(n.filter, t).filter((c) => !indexed(t, c));
      out.push({
        severity: 'warning',
        node: n.id,
        message: `Sequential scan on ${n.relation} discards ${n.rowsRemoved.toLocaleString()} rows to return ${(rows ?? 0).toLocaleString()}.${cols.length ? ` An index on ${cols.join(', ')} may help.` : ''}`,
        sql: cols.length && t ? `CREATE INDEX ON "${t.schema}"."${t.name}" (${cols.map((c) => `"${c}"`).join(', ')});` : undefined,
      });
    }
    if (n.actualRows !== null && n.planRows > 0) {
      const perLoop = n.actualRows / (n.loops || 1);
      const ratio = Math.max(perLoop, 1) / Math.max(n.planRows, 1);
      if ((ratio > 10 || ratio < 0.1) && Math.max(perLoop, n.planRows) > 100)
        out.push({
          severity: 'info',
          node: n.id,
          message: `${n.type}${n.relation ? ` on ${n.relation}` : ''}: estimated ${n.planRows.toLocaleString()} rows, got ${Math.round(perLoop).toLocaleString()}${n.loops > 1 ? ' per loop' : ''}. Statistics may be stale; try ANALYZE${n.relation ? ` ${n.relation}` : ''}.`,
          sql: n.relation ? `ANALYZE ${n.relation};` : undefined,
        });
    }
    if (n.sortSpace === 'Disk' || /external/i.test(n.sortMethod ?? ''))
      out.push({ severity: 'warning', node: n.id, message: `Sort spilled to disk (${n.sortMethod}). Increasing work_mem or an index on ${n.sortKey?.join(', ') ?? 'the sort key'} may help.` });
    if (n.hashBatches > 1) out.push({ severity: 'warning', node: n.id, message: `Hash used ${n.hashBatches} batches (spilled to disk). Consider a higher work_mem.` });
    if (n.type === 'Nested Loop' && (flat.nodes.find((c) => c.parent === n.id && c.loops > 1000)))
      out.push({ severity: 'info', node: n.id, message: 'Nested loop runs its inner side more than 1,000 times; check that the join columns are indexed.' });
  }
  // Foreign keys without an index, for tables in the plan.
  if (schema) {
    const rels = new Set(flat.nodes.map((n) => tableOf(n.relation)?.id).filter(Boolean));
    for (const t of allTables(schema)) {
      if (!rels.has(t.id)) continue;
      for (const fk of t.foreignKeys) {
        if (indexed(t, fk.columns[0])) continue;
        out.push({
          severity: 'info',
          node: null,
          message: `Foreign key ${t.id}(${fk.columns.join(', ')}) → ${fk.refTable} has no index; joins and deletes on ${fk.refTable} scan ${t.name}.`,
          sql: `CREATE INDEX ON "${t.schema}"."${t.name}" (${fk.columns.map((c) => `"${c}"`).join(', ')});`,
        });
      }
    }
  }
  return out;
}

// One-line summary of a node for display.
export function describeNode(n) {
  const bits = [n.type];
  if (n.joinType && !/Join/.test(n.type)) bits.push(n.joinType);
  if (n.relation) bits.push(`on ${n.relation}${n.alias && n.alias !== n.relation.split('.').pop() ? ` ${n.alias}` : ''}`);
  if (n.index) bits.push(`using ${n.index}`);
  return bits.join(' ');
}
