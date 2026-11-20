import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMssqlConnectionString as parse } from '../src/renderer/lib/mssqlconnection.js';
import sqlServer from '../src/main/database/mssql.cjs';

test('pasted SQL Server credentials reach the driver with literal password characters', () => {
  const prefix = 'Data Source=tcp:db.example,1444;Initial Catalog=Orders;UID=reader;';
  for (const [literal, expected] of [
    ['a#b!c', 'a#b!c'], ['" a;#=""! "', ' a;#="! '], ["'a;''b!#'", "a;'b!#"],
  ]) {
    const config = sqlServer.mssqlConfig(parse(prefix + 'PWD=' + literal));
    assert.deepEqual([config.server, config.port, config.database, config.user, config.password],
      ['db.example', 1444, 'Orders', 'reader', expected]);
  }
});

test('named instance, Windows login and TLS options populate the existing driver settings', () => {
  const config = sqlServer.mssqlConfig(parse('Server=db\\sales;Trusted_Connection=SSPI;User ID=ACME\\jo;Encrypt=no;Trust Server Certificate=yes'));
  assert.equal(config.options.instanceName, 'sales');
  assert.equal(config.port, undefined);
  const explicitPort = sqlServer.mssqlConfig(parse('Server=db\\sales,1444'));
  assert.equal(explicitPort.port, 1444);
  assert.equal(explicitPort.options.instanceName, undefined);
  assert.equal(config.options.encrypt, false);
  assert.equal(config.options.trustServerCertificate, true);
  assert.deepEqual(config.authentication.options, { userName: 'jo', domain: 'ACME', password: '' });
});

test('malformed or unsupported settings fail without including credentials in errors', () => {
  for (const input of ['PWD=secret', 'Server=db;Pwd="secret', 'Server=db,99999;Pwd=secret',
    'Server=db;Pwd=secret;Encrypt=strict', 'Server=db;Authentication=Active Directory Integrated;Pwd=secret']) {
    assert.throws(() => parse(input), error => !error.message.includes('secret'));
  }
});
