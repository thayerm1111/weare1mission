import { admin } from "../db";

/**
 * Account leases with fencing tokens.
 *
 * The lease answers "who may command this account". The fence answers the harder question: a worker
 * that stalled past its TTL and then woke up still believes it holds the lease, and a TTL cannot
 * tell it otherwise. Every write it makes carries the fence it was issued under, and the database
 * refuses anything behind the current one.
 */

export type Lease = { accountId: string; owner: string; fence: number };

export async function acquire(accountId: string, owner: string, ttlMs: number): Promise<Lease | null> {
  const { data, error } = await admin().rpc("rapid_acquire_lease", { p_account: accountId, p_owner: owner, p_ttl_ms: ttlMs });
  if (error) throw new Error(`rapid_lease_acquire_failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { fence: number; acquired: boolean } | undefined;
  if (!row?.acquired) return null;
  return { accountId, owner, fence: Number(row.fence) };
}

/** FALSE means the lease is gone. The caller must stop commanding this account immediately. */
export async function extend(lease: Lease, ttlMs: number): Promise<boolean> {
  const { data, error } = await admin().rpc("rapid_extend_lease", {
    p_account: lease.accountId, p_owner: lease.owner, p_fence: lease.fence, p_ttl_ms: ttlMs,
  });
  // A transient database error is NOT proof the lease was lost. The next extend decides; dropping
  // the account on one flaky query would hand a live position to another worker for no reason.
  if (error) return true;
  return data === true;
}

export async function release(lease: Lease): Promise<void> {
  try {
    await admin().rpc("rapid_release_lease", { p_account: lease.accountId, p_owner: lease.owner, p_fence: lease.fence });
  } catch {
    /* the TTL will expire it */
  }
}

/**
 * Run `fn` while holding the lease, keeping it alive underneath. If the lease is lost mid-pass the
 * keep-alive stops extending and `lost` is set, so the caller can abandon the pass rather than keep
 * issuing commands for an account it no longer owns.
 */
export async function withLease<T>(
  accountId: string,
  owner: string,
  ttlMs: number,
  fn: (lease: Lease, stillOwned: () => boolean) => Promise<T>,
): Promise<{ ran: false } | { ran: true; result: T; lostMidPass: boolean }> {
  const lease = await acquire(accountId, owner, ttlMs);
  if (!lease) return { ran: false };

  let lost = false;
  const keepAlive = setInterval(() => {
    void extend(lease, ttlMs).then((held) => { if (!held) lost = true; });
  }, Math.max(1000, Math.floor(ttlMs / 3)));

  try {
    const result = await fn(lease, () => !lost);
    return { ran: true, result, lostMidPass: lost };
  } finally {
    clearInterval(keepAlive);
    if (!lost) await release(lease);
  }
}
