// ADO.NET values can contain delimiters inside quotes. A doubled closing
// quote represents one literal quote. Keep quoted whitespace intact.
function* entries(text) {
  const pair = /\s*([^;=\s][^;=]*?)\s*=\s*(?:"((?:[^"]|"")*)"|'((?:[^']|'')*)'|([^'";\s][^;]*|))\s*(?:;|$)/y;

  let pos = 0;
  while (pos < text.length) {
    if (text[pos] === ';' || /\s/.test(text[pos])) {
      pos++;
      continue;
    }
    pair.lastIndex = pos;
    const match = pair.exec(text);
    if (!match) throw new Error('Invalid connection string');
    const [, key, double, single, plain] = match;
    const value = double !== undefined ? double.replaceAll('""', '"')
      : single !== undefined ? single.replaceAll("''", "'") : plain.trim();
    yield [key.toLowerCase().replace(/[\s_]/g, ''), value];
    pos = pair.lastIndex;
  }
}

function booleanValue(value) {
  if (/^(true|yes)$/i.test(value)) return true;
  if (/^(false|no)$/i.test(value)) return false;
  throw new Error('Invalid boolean option');
}

export function parseMssqlConnectionString(text) {
  const settings = { server: '', port: '', database: '', auth: 'sql', domain: '', user: '', password: '', encrypt: true, trustServerCertificate: false };
  for (const [key, value] of entries(text)) {
    switch (key) {
      case 'server': case 'datasource': case 'address': case 'addr': case 'networkaddress': {
        const endpoint = value.replace(/^tcp:/i, '').split(',');
        settings.server = endpoint[0].trim();
        settings.port = endpoint[1]?.trim() ?? '';
        if (endpoint.length > 2 || /^(np|lpc):/i.test(settings.server)
          || (endpoint.length === 2 && (!/^\d+$/.test(settings.port) || +settings.port < 1 || +settings.port > 65535))) {
          throw new Error('Invalid server');
        }
        break;
      }
      case 'database': case 'initialcatalog': settings.database = value; break;
      case 'userid': case 'uid': case 'user': settings.user = value; break;
      case 'password': case 'pwd': settings.password = value; break;
      case 'domain': settings.domain = value; break;
      case 'integratedsecurity': case 'trustedconnection':
        settings.auth = /^sspi$/i.test(value) || booleanValue(value) ? 'ntlm' : 'sql';
        break;
      case 'authentication':
        if (!/^(ntlm|sql password)$/i.test(value)) throw new Error('Unsupported authentication');
        settings.auth = /^ntlm$/i.test(value) ? 'ntlm' : 'sql';
        break;
      case 'encrypt':
        settings.encrypt = /^mandatory$/i.test(value) || (!/^optional$/i.test(value) && booleanValue(value));
        break;
      case 'trustservercertificate': settings.trustServerCertificate = booleanValue(value); break;
      // These settings concern the original application's sessions and pool.
      case 'applicationname': case 'pooling': case 'multipleactiveresultsets':
      case 'connecttimeout': case 'connectiontimeout': case 'persistsecurityinfo': break;
      default: throw new Error('Unsupported connection option');
    }
  }
  if (!settings.server) throw new Error('Missing server');
  if (settings.auth === 'ntlm' && !settings.domain && settings.user.includes('\\')) {
    [settings.domain, settings.user] = settings.user.split('\\', 2);
  }
  return settings;
}
