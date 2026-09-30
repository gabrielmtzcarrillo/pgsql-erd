// Minimal PostgreSQL syntax highlighter. tokenizeSQL() is pure (and
// lossless: the token texts concatenate back to the input); highlightSQL()
// renders the tokens into an element as text-only spans.

const KEYWORDS = new Set(
  `abort action add all alter always analyze and any array as asc begin between by cascade case cast
  check collate column comment commit concurrently constraint create cross current_date current_time
  current_timestamp current_user cycle default deferrable deferred delete desc distinct do drop each else
  end exclude exists false fetch first following for foreign from full function generated grant group having
  identity if ilike immediate in include index initially inner insert intersect into is isnull join key last
  lateral left like limit match minvalue maxvalue natural no not nothing notnull null nulls offset on only
  or order outer over owned partial partition policy primary procedure references rename replace restrict
  returning revoke right rollback row rows schema select sequence session_user set simple some start stored
  table tablespace temp temporary then to transaction trigger true truncate type union unique unlogged
  update using vacuum values view when where window with without by`.split(/\s+/)
);

const TYPES = new Set(
  `bigint bigserial bit boolean bool box bytea char character cidr circle date decimal double float float4
  float8 inet int int2 int4 int8 integer interval json jsonb line lseg macaddr macaddr8 money numeric path
  point polygon precision real regclass serial serial2 serial4 serial8 smallint smallserial text time
  timestamp timestamptz timetz tsquery tsvector uuid varbit varchar varying xml zone vector halfvec sparsevec`.split(/\s+/)
);

const RULES = [
  ['comment', /--[^\n]*/y],
  ['comment', /\/\*[\s\S]*?(?:\*\/|$)/y],
  ['string', /[eE]'(?:[^'\\]|\\[\s\S]|'')*(?:'|$)/y],
  ['string', /'(?:[^']|'')*(?:'|$)/y],
  ['string', /\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?(?:\$\1\$|$)/y],
  ['ident', /"(?:[^"]|"")*(?:"|$)/y],
  ['number', /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?![A-Za-z0-9_$])/y],
  ['word', /[A-Za-z_][A-Za-z0-9_$]*/y],
  ['operator', /::|[<>=!~+\-*/%^|&@#]+/y],
  ['space', /\s+/y],
  ['punct', /[(),;.[\]{}:]/y],
];

export function tokenizeSQL(sql) {
  const src = String(sql ?? '');
  const tokens = [];
  let pos = 0;
  const push = (type, text) => {
    const last = tokens[tokens.length - 1];
    // Merge runs of the same kind to keep the DOM small.
    if (last && last.type === type && (type === 'plain' || type === 'space' || type === 'punct')) last.text += text;
    else tokens.push({ type, text });
  };
  while (pos < src.length) {
    let matched = false;
    for (const [type, re] of RULES) {
      re.lastIndex = pos;
      const m = re.exec(src);
      if (!m || !m[0]) continue;
      let t = type;
      if (type === 'word') {
        const w = m[0].toLowerCase();
        // A word before "(" is a function call unless it's a keyword or type.
        if (TYPES.has(w)) t = 'type';
        // "with/without time zone" is part of a time/timestamp type.
        else if ((w === 'with' || w === 'without') && /^\s+time\s+zone\b/i.test(src.slice(pos + m[0].length))) t = 'type';
        else if (KEYWORDS.has(w)) t = 'keyword';
        else if (src[pos + m[0].length] === '(') t = 'function';
        else t = 'plain';
      }
      push(t, m[0]);
      pos += m[0].length;
      matched = true;
      break;
    }
    if (!matched) push('plain', src[pos++]);
  }
  return tokens;
}

const CLASS = {
  comment: 'sql-com', string: 'sql-str', ident: 'sql-ident', number: 'sql-num',
  keyword: 'sql-kw', type: 'sql-type', function: 'sql-fn', operator: 'sql-op', punct: 'sql-punct',
};

export function highlightSQL(el, sql) {
  const doc = el.ownerDocument;
  const frag = doc.createDocumentFragment();
  for (const { type, text } of tokenizeSQL(sql)) {
    const cls = CLASS[type];
    if (!cls) {
      frag.append(text);
      continue;
    }
    const span = doc.createElement('span');
    span.className = cls;
    span.textContent = text;
    frag.append(span);
  }
  el.replaceChildren(frag);
}
