// Reading and writing pgAdmin 4 ERD files (.pgerd).
//
// A .pgerd file is the JSON serialization of pgAdmin's react-diagrams model:
//
//   { "version": <pgAdmin version int>,
//     "data": { offsetX, offsetY, zoom, gridSize,
//               layers: [ { type: "diagram-links", models: { <id>: link } },
//                         { type: "diagram-nodes", models: { <id>: node } } ] } }
//
// Each table node keeps its definition in node.otherInfo.data (name, schema,
// columns, primary_key, foreign_key, ...). Links carry
// data.{local,referenced}_{table_uuid,column_attnum}.
//
// Internally we work with a simpler model (see emptyModel) and keep the raw
// objects around so that unknown properties survive a load/save round trip.

export const DEFAULT_VERSION = 80000;

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function emptyModel() {
  return {
    version: DEFAULT_VERSION,
    view: { offsetX: 0, offsetY: 0, zoom: 1, gridSize: 15 },
    tables: [],
    links: [],
    raw: null,
  };
}

export function newTable(props = {}) {
  return {
    id: uuid(),
    name: 'new_table',
    schema: 'public',
    description: '',
    note: '',
    color: null,
    x: 0,
    y: 0,
    columns: [],
    raw: null,
    rawData: null,
    ...props,
  };
}

export function newColumn(props = {}) {
  return {
    name: 'column',
    type: 'text',
    length: null,
    precision: null,
    notNull: false,
    default: '',
    pk: false,
    attnum: 0,
    raw: null,
    ...props,
  };
}

export function nextAttnum(table) {
  return table.columns.reduce((m, c) => Math.max(m, Number(c.attnum) || 0), -1) + 1;
}

const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

function modelsOf(layer) {
  if (!layer?.models) return [];
  return Array.isArray(layer.models) ? layer.models : Object.values(layer.models);
}

export function parsePgerd(text) {
  let json;
  try {
    json = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    throw new Error(`Not a valid .pgerd file: ${e.message}`);
  }
  const data = json?.data ?? json;
  if (!data || !Array.isArray(data.layers)) {
    throw new Error('Not a valid .pgerd file: no diagram layers found');
  }

  const model = emptyModel();
  model.version = json.version || DEFAULT_VERSION;
  model.raw = json;
  model.view = {
    offsetX: Number(data.offsetX) || 0,
    offsetY: Number(data.offsetY) || 0,
    // pgAdmin stores zoom as a percentage.
    zoom: (Number(data.zoom) || 100) / 100,
    gridSize: Number(data.gridSize) || 15,
  };

  const nodeLayer = data.layers.find((l) => l.type === 'diagram-nodes');
  const linkLayer = data.layers.find((l) => l.type === 'diagram-links');

  for (const node of modelsOf(nodeLayer)) {
    if (node.type && node.type !== 'table' && !node.otherInfo) continue;
    const d = node.otherInfo?.data ?? {};
    const pkNames = new Set(
      (d.primary_key ?? []).flatMap((pk) => (pk.columns ?? []).map((c) => c.column))
    );
    const columns = (d.columns ?? []).map((c, i) =>
      newColumn({
        name: c.name ?? `column_${i}`,
        type: c.cltype ?? c.type ?? '',
        length: emptyToNull(c.attlen),
        precision: emptyToNull(c.attprecision),
        notNull: !!c.attnotnull,
        default: c.defval ?? '',
        pk: !!c.is_primary_key || pkNames.has(c.name),
        attnum: c.attnum ?? i,
        raw: c,
      })
    );
    model.tables.push(
      newTable({
        id: node.id ?? uuid(),
        name: d.name ?? node.name ?? 'table',
        schema: d.schema ?? 'public',
        description: d.description ?? '',
        note: node.otherInfo?.note ?? '',
        color: node.otherInfo?.fillColor ?? node.otherInfo?.metadata?.fillColor ?? null,
        x: Number(node.x) || 0,
        y: Number(node.y) || 0,
        columns,
        raw: node,
        rawData: d,
      })
    );
  }

  const byId = new Map(model.tables.map((t) => [t.id, t]));
  const byName = new Map(model.tables.map((t) => [t.name, t]));
  const seen = new Set();
  const addLink = (link) => {
    const key = `${link.localTable}:${link.localCol}->${link.refTable}:${link.refCol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    model.links.push(link);
    return true;
  };

  // Foreign keys stored on the tables are the source of truth.
  for (const t of model.tables) {
    (t.rawData?.foreign_key ?? []).forEach((fk, fkIdx) => {
      const group = uuid();
      for (const fc of fk.columns ?? []) {
        const ref = byId.get(fc.references) ?? byName.get(fc.references_table_name);
        const localCol = t.columns.find((c) => c.name === fc.local_column);
        const refCol = ref?.columns.find((c) => c.name === fc.referenced);
        if (!ref || !localCol || !refCol) continue;
        addLink({
          id: uuid(),
          type: 'onetomany',
          localTable: t.id,
          localCol: localCol.attnum,
          refTable: ref.id,
          refCol: refCol.attnum,
          group,
          fkName: fk.name ?? '',
          rawFk: fk,
          raw: null,
          order: fkIdx,
        });
      }
    });
  }

  // Links in the links layer: attach raw data, and pick up any relation
  // that was drawn but not stored as a foreign key.
  for (const l of modelsOf(linkLayer)) {
    const d = l.data;
    if (!d || !byId.has(d.local_table_uuid) || !byId.has(d.referenced_table_uuid)) continue;
    const existing = model.links.find(
      (x) =>
        x.localTable === d.local_table_uuid &&
        x.refTable === d.referenced_table_uuid &&
        x.localCol === d.local_column_attnum &&
        x.refCol === d.referenced_column_attnum
    );
    if (existing) {
      existing.raw = l;
      if (l.type) existing.type = l.type;
      continue;
    }
    addLink({
      id: l.id ?? uuid(),
      type: l.type ?? 'onetomany',
      localTable: d.local_table_uuid,
      localCol: d.local_column_attnum,
      refTable: d.referenced_table_uuid,
      refCol: d.referenced_column_attnum,
      group: uuid(),
      fkName: '',
      rawFk: null,
      raw: l,
    });
  }

  return model;
}

function columnToData(c) {
  const out = {
    ...(c.raw ?? {}),
    name: c.name,
    cltype: c.type,
    attlen: c.length === null || c.length === '' ? null : c.length,
    attprecision: c.precision === null || c.precision === '' ? null : c.precision,
    attnotnull: !!c.notNull,
    defval: c.default ?? '',
    is_primary_key: !!c.pk,
    attnum: c.attnum,
  };
  if (!('is_array' in out)) out.is_array = /\[\]$/.test(c.type ?? '');
  return out;
}

// Store the header color where pgAdmin keeps it (metadata.fillColor in some
// versions, fillColor in others), preferring whichever the file already used.
function withFillColor(otherInfo, color) {
  if (otherInfo.metadata && 'fillColor' in otherInfo.metadata) {
    otherInfo.metadata = { ...otherInfo.metadata, fillColor: color ?? null };
  } else if (color || 'fillColor' in otherInfo) {
    otherInfo.fillColor = color ?? null;
  }
  return otherInfo;
}

// Group a table's outgoing links into foreign key constraints.
export function foreignKeysOf(model, table) {
  const groups = new Map();
  for (const l of model.links) {
    if (l.localTable !== table.id) continue;
    if (!groups.has(l.group)) groups.set(l.group, []);
    groups.get(l.group).push(l);
  }
  return [...groups.values()];
}

export function serializePgerd(model) {
  const tablesById = new Map(model.tables.map((t) => [t.id, t]));
  const nodeModels = {};
  const linkModels = {};
  const ports = new Map(); // tableId -> Map(portName -> port)

  const getPort = (table, attnum, alignment, type) => {
    if (!ports.has(table.id)) ports.set(table.id, new Map());
    const tablePorts = ports.get(table.id);
    const name = `coll-port-${attnum}`;
    if (!tablePorts.has(name)) {
      tablePorts.set(name, {
        id: uuid(),
        type,
        x: 0,
        y: 0,
        name,
        alignment,
        parentNode: table.id,
        links: [],
      });
    }
    return tablePorts.get(name);
  };

  for (const l of model.links) {
    const local = tablesById.get(l.localTable);
    const ref = tablesById.get(l.refTable);
    if (!local || !ref) continue;
    const type = l.type || 'onetomany';
    // pgAdmin draws links from the referenced (one) side to the local (many) side.
    const sourcePort = getPort(ref, l.refCol, 'right', type);
    const targetPort = getPort(local, l.localCol, 'left', type);
    sourcePort.links.push(l.id);
    targetPort.links.push(l.id);
    const raw = l.raw ?? {};
    linkModels[l.id] = {
      selected: false,
      width: 1,
      color: 'gray',
      curvyness: 50,
      selectedColor: 'rgb(0,192,255)',
      labels: [],
      locked: false,
      ...raw,
      id: l.id,
      type,
      source: ref.id,
      sourcePort: sourcePort.id,
      target: local.id,
      targetPort: targetPort.id,
      points: [
        { id: uuid(), type: 'point', x: ref.x, y: ref.y },
        { id: uuid(), type: 'point', x: local.x, y: local.y },
      ],
      data: {
        ...(raw.data ?? {}),
        local_table_uuid: local.id,
        local_column_attnum: l.localCol,
        referenced_table_uuid: ref.id,
        referenced_column_attnum: l.refCol,
      },
    };
  }

  for (const t of model.tables) {
    const colByAttnum = new Map(t.columns.map((c) => [c.attnum, c]));
    const pkCols = t.columns.filter((c) => c.pk);
    const rawPk = t.rawData?.primary_key?.[0] ?? {};
    const colNames = new Set(t.columns.map((c) => c.name));

    const foreign_key = foreignKeysOf(model, t)
      .map((links) => {
        const first = links[0];
        return {
          ...(first.rawFk ?? {}),
          name: first.fkName ?? '',
          columns: links
            .map((l) => {
              const ref = tablesById.get(l.refTable);
              const lc = colByAttnum.get(l.localCol);
              const rc = ref?.columns.find((c) => c.attnum === l.refCol);
              if (!ref || !lc || !rc) return null;
              return {
                local_column: lc.name,
                references: ref.id,
                referenced: rc.name,
                references_table_name: ref.name,
              };
            })
            .filter(Boolean),
        };
      })
      .filter((fk) => fk.columns.length);

    const keepConstraint = (list) =>
      (list ?? []).filter((con) => (con.columns ?? []).every((c) => colNames.has(c.column)));

    const data = {
      ...(t.rawData ?? {}),
      name: t.name,
      schema: t.schema,
      description: t.description ?? '',
      columns: t.columns.map(columnToData),
      primary_key: pkCols.length
        ? [{ ...rawPk, columns: pkCols.map((c) => ({ column: c.name })) }]
        : [],
      foreign_key,
      unique_constraint: keepConstraint(t.rawData?.unique_constraint),
    };

    const raw = t.raw ?? {};
    const tablePorts = [...(ports.get(t.id)?.values() ?? [])];
    nodeModels[t.id] = {
      selected: false,
      locked: false,
      name: '',
      portsInOrder: [],
      portsOutOrder: [],
      ...raw,
      id: t.id,
      type: 'table',
      x: Math.round(t.x),
      y: Math.round(t.y),
      color: raw.color ?? 'rgb(0,192,255)',
      ports: tablePorts,
      otherInfo: withFillColor(
        { ...(raw.otherInfo ?? {}), data, note: t.note ?? '' },
        t.color
      ),
    };
  }

  const rawData = model.raw?.data ?? {};
  const rawLayer = (type) => rawData.layers?.find((l) => l.type === type) ?? {};
  return {
    ...(model.raw ?? {}),
    version: model.version || DEFAULT_VERSION,
    data: {
      ...rawData,
      id: rawData.id ?? uuid(),
      offsetX: Math.round(model.view.offsetX),
      offsetY: Math.round(model.view.offsetY),
      zoom: Math.round(model.view.zoom * 100),
      gridSize: model.view.gridSize ?? 15,
      layers: [
        {
          isSvg: true,
          transformed: true,
          selected: false,
          locked: false,
          ...rawLayer('diagram-links'),
          id: rawLayer('diagram-links').id ?? uuid(),
          type: 'diagram-links',
          models: linkModels,
        },
        {
          isSvg: false,
          transformed: true,
          selected: false,
          locked: false,
          ...rawLayer('diagram-nodes'),
          id: rawLayer('diagram-nodes').id ?? uuid(),
          type: 'diagram-nodes',
          models: nodeModels,
        },
      ],
    },
  };
}

export function stringifyPgerd(model) {
  return JSON.stringify(serializePgerd(model));
}
