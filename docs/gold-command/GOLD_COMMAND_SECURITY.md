# SECURITY

## Credentials

Broker refresh tokens are encrypted at rest (`FLOW_ENC_KEY`, `src/lib/flow/crypto.ts`) and decrypted only
inside server processes. Broker passwords are never stored after the initial token exchange. No credential,
token, service-role key or provider key is ever sent to the browser — the client talks only to our own
authenticated API routes.

Secrets live in Vercel and Railway environment variables and in GitHub Actions secrets. They are never
committed, never logged, and never echoed in an error message. Any log line that could carry a token is
redacted at the logging boundary, not at the call site.

## Multi-user isolation

Row-level security is on for every table. Every execution path filters by `user_id` server-side; a client
cannot widen its own scope by editing a request. Broker connections are resolved from the database on each
use and checked to belong to the requesting member — never trusted from the request body. The member trade
controls (close, partial, break-even) verify connection ownership before a single broker call.

## Live vs demo

Demo and live accounts are visually distinct everywhere they appear, and live automation is a separate,
explicit authorisation from demo automation. Nothing escalates an account from demo to live automatically,
and no default enables automation on a newly connected account.

## Authorisation model

Actions are authorised per account, not per user: entries, closes, partials, stop moves, break-even, take-
profit changes, trailing, CHoCH exits, pending orders, scale-in and scale-out are independently switchable.
The kill switch is one action that stops new entries immediately, with an explicit, separately confirmed
option to also close open positions.

## Audit

Every automated action writes an immutable row: who, which account, what action, when, at what market price,
on which snapshot, model and strategy version, risk before and after, the broker's raw answer, and the final
state. This is what makes the system defensible — to a member, to a prop firm, and to the owner.

## Boundaries the AI cannot cross

The BRAIN has no broker credentials and no network path to the broker. It writes decision rows. The Risk
Engine and Execution Validator are deterministic code with no model in the loop. A prompt injection in a news
headline or a member message can, at absolute worst, produce a decision row that the validator rejects.
