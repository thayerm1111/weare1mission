/** One-shot backend diagnostic. Never invoke a manager or an execution endpoint.
 * Default: resolve an allowlisted account through the backend's Supabase credentials.
 * --stdin: trusted local operator supplies the same scoped session as one JSON line.
 * Tokens and broker payloads never appear in the report. */
import { createInterface } from 'node:readline';
import { createAdminClient } from '../src/lib/supabase/admin';
import { readOnlyTransport, validateBroker, type ValidationInput } from '../src/lib/flow/validation';

async function main() {
  const expectedAccount = process.env.GENX_VALIDATION_ACCOUNT_ID;
  const expectedConnection = process.env.GENX_VALIDATION_CONNECTION_ID;
  if (!expectedAccount || !expectedConnection) throw Error('validation_allowlist_missing');
  let input: ValidationInput;
  if (process.argv.includes('--stdin')) {
    const lines = createInterface({ input: process.stdin });
    const line = await new Promise<string>(resolve => lines.once('line', resolve)); lines.close();
    const supplied = JSON.parse(line);
    if (supplied.connectionId !== expectedConnection || supplied.accountId !== expectedAccount) throw Error('validation_account_mismatch');
    input = supplied;
  } else {
    const db = createAdminClient(); if (!db) throw Error('backend_credentials_missing');
    const a = await db.from('flow_broker_accounts').select('account_id,acc_num,user_id').eq('account_id', expectedAccount).eq('connection_id', expectedConnection).single();
    if (a.error || !a.data) throw Error('validation_account_not_found');
    const c = await db.from('flow_broker_connections').select('access_token,environment').eq('id', expectedConnection).eq('user_id', a.data.user_id).single();
    if (c.error || !c.data?.access_token) throw Error('validation_session_unavailable');
    input = { accountId: a.data.account_id, accNum: a.data.acc_num, environment: c.data.environment, token: c.data.access_token };
  }
  // Reuse the existing session only: no refresh, login, credential or database writes.
  globalThis.fetch = readOnlyTransport(input, globalThis.fetch);
  process.stdout.write(JSON.stringify(await validateBroker(input), null, 2) + '\n');
}
main().catch((e) => {
  const code = e instanceof Error && /^(config|positions|orders|history|instruments|quote)_read_failed(_[0-9]{3})?$/.test(e.message) ? e.message : 'validation_unavailable';
  console.error(JSON.stringify({ code, brokerWrites: 0 })); process.exitCode = 1;
});
