// Apache AGE graphs for the Graph tab: graphs and labels, vertices and
// relationships (edges), and Cypher queries.
//
// - Lists are read with SQL from the label tables (paging, search, counts);
//   changes go through Cypher, so AGE keeps its own bookkeeping.
// - Reads run in read-only transactions. Changes need the connection's
//   policy to allow writes (graphs and labels: schema changes too), run in
//   one transaction and are recorded in the audit log.
// - Graph and label names are validated; values reach Cypher as parameters
//   or escaped literals (AGE takes no parameters for property maps).

const MAX_ROWS = 2000;

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

class AgeService {
  // shared: modules from src/shared (the age module's helpers).
  constructor({ connections, audit, shared }) {
    this.connections = connections;
    this.audit = audit;
    this.shared = shared;
  }

  // AGE needs LOAD in each session unless it is preloaded; non-superusers can
  // only load it from $libdir/plugins. If neither works, cypher() reports it.
  async prepare(client) {
    for (const lib of ['age', '$libdir/plugins/age']) {
      await client.query('SAVEPOINT age_load');
      try {
        await client.query(`LOAD '${lib}'`);
        await client.query('RELEASE SAVEPOINT age_load');
        break;
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT age_load');
      }
    }
    await client.query(`SET LOCAL search_path = ag_catalog, "$user", public`);
  }

  async read(windowId, fn, { age = true } = {}) {
    const client = await this.connections.client(windowId);
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query('SET LOCAL statement_timeout = 30000');
      if (age) await this.prepare(client);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end().catch(() => {});
    }
  }

  // kind: 'data' (vertices, edges, Cypher writes) or 'ddl' (graphs, labels, extension).
  async write(windowId, kind, details, fn, { age = true } = {}) {
    const session = this.connections.require(windowId);
    const { policy } = session.profile;
    if (!policy.allowWrites) throw new Error(`The "${session.profile.name}" connection (${session.profile.environment}) is read-only. Edit the connection to change its policy.`);
    if (kind === 'ddl' && !policy.allowDDL) throw new Error(`The "${session.profile.name}" connection (${session.profile.environment}) doesn't allow schema changes.`);
    const client = await this.connections.client(windowId);
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout = 60000');
      if (age) await this.prepare(client);
      const result = await fn(client);
      await client.query('COMMIT');
      this.audit?.log('graph-write', {
        windowId, target: this.connections.describe(session.conn), environment: session.profile.environment, ...details,
      });
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await client.end().catch(() => {});
    }
  }

  // ------------------------------------------------------------ catalog

  // { available, version, graphs: [{ name, vertexLabels: [{ name, count }], edgeLabels }] }
  async status(windowId) {
    const ext = await this.read(windowId, (c) => c.query(
      `SELECT (SELECT extversion FROM pg_extension WHERE extname = 'age') AS version,
              EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'age') AS available`
    ), { age: false });
    const { version, available } = ext.rows[0];
    if (!version) return { available, version: null, graphs: [] };
    return this.read(windowId, async (c) => {
      const labels = await c.query(`
        SELECT g.name::text AS graph, l.name::text AS label, l.kind, l.relation::regclass::text AS relation
          FROM ag_catalog.ag_graph g
          LEFT JOIN ag_catalog.ag_label l ON l.graph = g.graphid AND l.name NOT LIKE '\\_ag\\_label\\_%'
         ORDER BY 1, 2`);
      // Exact counts per label table (ONLY: label tables can inherit from each other).
      const withRel = labels.rows.filter((r) => r.relation);
      const counts = withRel.length
        ? (await c.query(withRel.map((r, i) => `SELECT ${i} AS i, count(*)::bigint AS n FROM ONLY ${r.relation}`).join(' UNION ALL '))).rows
        : [];
      const countOf = new Map(counts.map((r) => [Number(r.i), Number(r.n)]));
      const graphs = new Map();
      labels.rows.forEach((r) => {
        if (!graphs.has(r.graph)) graphs.set(r.graph, { name: r.graph, vertexLabels: [], edgeLabels: [] });
        if (!r.label) return;
        const entry = { name: r.label, count: countOf.get(withRel.indexOf(r)) ?? 0 };
        graphs.get(r.graph)[r.kind === 'e' ? 'edgeLabels' : 'vertexLabels'].push(entry);
      });
      return { available, version, graphs: [...graphs.values()] };
    });
  }

  // Graph oid, schema and label tables: { oid, schema, labels: Map(name -> { kind, relation }) }.
  async graph(client, name) {
    if (!this.shared.isGraphName(name)) throw new Error(`Invalid graph name: ${name}`);
    const g = await client.query(
      `SELECT g.graphid AS oid, g.namespace::regnamespace::text AS schema FROM ag_catalog.ag_graph g WHERE g.name = $1`, [name]
    );
    if (!g.rows.length) throw new Error(`Graph ${name} does not exist.`);
    const labels = await client.query(
      `SELECT l.name::text AS name, l.kind, l.relation::regclass::text AS relation FROM ag_catalog.ag_label l WHERE l.graph = $1`, [g.rows[0].oid]
    );
    return { ...g.rows[0], labels: new Map(labels.rows.map((r) => [r.name, r])) };
  }

  labelTable(g, label, kind) {
    if (!label) return `${g.schema}.${ident(kind === 'e' ? '_ag_label_edge' : '_ag_label_vertex')}`;
    const l = g.labels.get(label);
    if (!l || l.kind !== kind) throw new Error(`${kind === 'e' ? 'Relationship type' : 'Vertex label'} ${label} does not exist in this graph.`);
    return l.relation;
  }

  vertexRow(r, prefix = '') {
    return {
      kind: 'vertex',
      id: r[`${prefix}id`],
      label: r[`${prefix}label`],
      properties: this.shared.parseProperties(r[`${prefix}properties`]),
    };
  }

  // ------------------------------------------------------------ reading

  // Relationships with their end vertices: { rows: [{ edge, start, end }], total }.
  // around: a vertex id; only its relationships (both directions).
  async edges(windowId, { graph, label = '', search = '', around = null, limit = 100, offset = 0 }) {
    return this.read(windowId, async (c) => {
      const g = await this.graph(c, graph);
      const table = this.labelTable(g, label, 'e');
      const params = [g.oid];
      const where = [];
      if (search) {
        params.push(`%${String(search).replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
        const p = `$${params.length}`;
        where.push(`(agtype_out(e.properties)::text ILIKE ${p} OR agtype_out(a.properties)::text ILIKE ${p} OR agtype_out(b.properties)::text ILIKE ${p}
                    OR _label_name($1, e.id)::text ILIKE ${p} OR _label_name($1, a.id)::text ILIKE ${p} OR _label_name($1, b.id)::text ILIKE ${p})`);
      }
      if (around !== null && around !== undefined && around !== '') {
        if (!this.shared.isGraphId(around)) throw new Error(`Invalid vertex id: ${around}`);
        params.push(String(around));
        where.push(`(e.start_id = $${params.length}::graphid OR e.end_id = $${params.length}::graphid)`);
      }
      const lim = Math.min(MAX_ROWS, Math.max(1, Math.floor(Number(limit) || 100)));
      const off = Math.max(0, Math.floor(Number(offset) || 0));
      const vertices = `${g.schema}.${ident('_ag_label_vertex')}`;
      const r = await c.query(
        `SELECT e.id::text AS id, _label_name($1, e.id)::text AS label, e.properties,
                a.id::text AS s_id, _label_name($1, a.id)::text AS s_label, a.properties AS s_properties,
                b.id::text AS t_id, _label_name($1, b.id)::text AS t_label, b.properties AS t_properties,
                count(*) OVER () AS total
           FROM ${table} e
           JOIN ${vertices} a ON a.id = e.start_id
           JOIN ${vertices} b ON b.id = e.end_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY e.id
          LIMIT ${lim} OFFSET ${off}`,
        params
      );
      return {
        total: Number(r.rows[0]?.total ?? 0),
        rows: r.rows.map((x) => ({
          edge: { kind: 'edge', id: x.id, label: x.label, start: x.s_id, end: x.t_id, properties: this.shared.parseProperties(x.properties) },
          start: this.vertexRow(x, 's_'),
          end: this.vertexRow(x, 't_'),
        })),
      };
    });
  }

  // Vertices with their relationship counts: { rows: [{ vertex, degree }], total }.
  async vertices(windowId, { graph, label = '', search = '', ids = null, limit = 100, offset = 0 }) {
    return this.read(windowId, async (c) => {
      const g = await this.graph(c, graph);
      const table = this.labelTable(g, label, 'v');
      const params = [g.oid];
      const where = [];
      if (search) {
        params.push(`%${String(search).replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
        where.push(`(agtype_out(v.properties)::text ILIKE $${params.length} OR _label_name($1, v.id)::text ILIKE $${params.length} OR v.id::text = $${params.length + 1})`);
        params.push(String(search).trim());
      }
      if (ids) {
        const list = [].concat(ids).map(String);
        if (!list.every(this.shared.isGraphId)) throw new Error('Invalid vertex id.');
        params.push(list);
        where.push(`v.id::text = ANY($${params.length}::text[])`);
      }
      const lim = Math.min(MAX_ROWS, Math.max(1, Math.floor(Number(limit) || 100)));
      const off = Math.max(0, Math.floor(Number(offset) || 0));
      const edges = `${g.schema}.${ident('_ag_label_edge')}`;
      const r = await c.query(
        `SELECT v.id::text AS id, _label_name($1, v.id)::text AS label, v.properties,
                (SELECT count(*) FROM ${edges} e WHERE e.start_id = v.id OR e.end_id = v.id) AS degree,
                count(*) OVER () AS total
           FROM ${table} v
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY v.id
          LIMIT ${lim} OFFSET ${off}`,
        params
      );
      return { total: Number(r.rows[0]?.total ?? 0), rows: r.rows.map((x) => ({ vertex: this.vertexRow(x), degree: Number(x.degree) })) };
    });
  }

  // A Cypher query typed by the user. Writes need allowChanges and the policy.
  async cypher(windowId, { graph, query, columns = null, allowChanges = false }) {
    const { isCypherWrite, cypherSQL, parseAgtype } = this.shared;
    const cols = columns && String(columns).trim() ? String(columns).split(',').map((s) => s.trim()).filter(Boolean) : null;
    const sql = cypherSQL(graph, query, { columns: cols });
    const writes = isCypherWrite(query);
    const started = Date.now();
    const run = async (c) => {
      const r = await c.query(sql);
      const columnsOut = r.fields.map((f) => f.name);
      return {
        columns: columnsOut,
        rows: r.rows.slice(0, MAX_ROWS).map((row) => columnsOut.map((f) => parseAgtype(row[f]))),
        rowCount: r.rowCount,
        truncated: r.rows.length > MAX_ROWS,
        committed: writes,
        durationMs: Date.now() - started,
      };
    };
    if (!writes) return this.read(windowId, run);
    if (!allowChanges) throw new Error('This query changes the graph. Tick "Allow changes" to run it.');
    return this.write(windowId, 'data', { action: 'cypher', graph, query: String(query).slice(0, 2000) }, run);
  }

  // ------------------------------------------------------------ changes

  // op: one of the operations below; args as documented there.
  async change(windowId, op, args = {}) {
    const s = this.shared;
    const lit = s.cypherLiteral;
    const props = (p) => {
      if (p === null || p === undefined) return {};
      if (typeof p !== 'object' || Array.isArray(p)) throw new Error('Properties must be a JSON object.');
      return p;
    };
    const label = (name, what) => {
      if (!s.isLabelName(name)) throw new Error(`Invalid ${what} name: ${name || '(empty)'}. Use letters, digits and _, starting with a letter.`);
      return name;
    };
    const id = (v, what = 'id') => {
      if (!s.isGraphId(v)) throw new Error(`Invalid ${what}: ${v}`);
      return String(v);
    };
    const cypher = (c, graph, query, params, columns) =>
      c.query(s.cypherSQL(graph, query, { params: params ? '$1' : null, columns }), params ? [params] : []).then((r) =>
        r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, s.parseAgtype(v)])))
      );
    const { graph } = args;
    const needGraph = () => {
      if (!s.isGraphName(graph)) throw new Error(`Invalid graph name: ${graph || '(empty)'}. Use 3–63 letters, digits and _, starting with a letter.`);
    };

    switch (op) {
      case 'install':
        return this.write(windowId, 'ddl', { action: 'create-extension' }, (c) => c.query('CREATE EXTENSION IF NOT EXISTS age'), { age: false });
      case 'create-graph':
        needGraph();
        return this.write(windowId, 'ddl', { action: op, graph }, (c) => c.query('SELECT ag_catalog.create_graph($1)', [graph]));
      case 'drop-graph':
        needGraph();
        return this.write(windowId, 'ddl', { action: op, graph }, (c) => c.query('SELECT ag_catalog.drop_graph($1, true)', [graph]));
      case 'create-label': {
        needGraph();
        const fn = args.kind === 'e' ? 'create_elabel' : 'create_vlabel';
        return this.write(windowId, 'ddl', { action: op, graph, label: args.label, kind: args.kind }, (c) =>
          c.query(`SELECT ag_catalog.${fn}($1, $2)`, [graph, label(args.label, 'label')])
        );
      }
      case 'drop-label':
        needGraph();
        return this.write(windowId, 'ddl', { action: op, graph, label: args.label }, (c) =>
          c.query('SELECT ag_catalog.drop_label($1, $2, true)', [graph, label(args.label, 'label')])
        );
      case 'create-vertex': {
        needGraph();
        const q = `CREATE (n:${s.cypherName(label(args.label, 'vertex label'))} ${lit(props(args.properties))}) RETURN n`;
        return this.write(windowId, 'data', { action: op, graph, label: args.label }, async (c) => (await cypher(c, graph, q, null, ['n']))[0].n);
      }
      case 'create-edge': {
        needGraph();
        const from = id(args.from, 'start vertex');
        const to = id(args.to, 'end vertex');
        const q = `MATCH (a), (b) WHERE id(a) = $a AND id(b) = $b
                   CREATE (a)-[r:${s.cypherName(label(args.label, 'relationship type'))} ${lit(props(args.properties))}]->(b) RETURN r`;
        return this.write(windowId, 'data', { action: op, graph, label: args.label, from, to }, async (c) => {
          const rows = await cypher(c, graph, q, `{"a": ${from}, "b": ${to}}`, ['r']);
          if (!rows.length) throw new Error('The start or end vertex no longer exists.');
          return rows[0].r;
        });
      }
      case 'set-properties': {
        needGraph();
        const el = id(args.id);
        const pattern = args.kind === 'edge' ? '()-[n]->()' : '(n)';
        const q = `MATCH ${pattern} WHERE id(n) = $id SET n = ${lit(props(args.properties))} RETURN n`;
        return this.write(windowId, 'data', { action: op, graph, id: el, kind: args.kind }, async (c) => {
          const rows = await cypher(c, graph, q, `{"id": ${el}}`, ['n']);
          if (!rows.length) throw new Error(`The ${args.kind === 'edge' ? 'relationship' : 'vertex'} no longer exists.`);
          return rows[0].n;
        });
      }
      case 'delete-edge': {
        needGraph();
        const el = id(args.id);
        return this.write(windowId, 'data', { action: op, graph, id: el }, (c) =>
          cypher(c, graph, 'MATCH ()-[r]->() WHERE id(r) = $id DELETE r', `{"id": ${el}}`, ['r']).then(() => null)
        );
      }
      case 'delete-vertex': {
        needGraph();
        const el = id(args.id);
        // DETACH also deletes the vertex's relationships.
        return this.write(windowId, 'data', { action: op, graph, id: el }, (c) =>
          cypher(c, graph, 'MATCH (n) WHERE id(n) = $id DETACH DELETE n', `{"id": ${el}}`, ['n']).then(() => null)
        );
      }
      default:
        throw new Error(`Unknown graph operation: ${op}`);
    }
  }
}

module.exports = { AgeService };
