# Security

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/Provokke/tidemark/security/advisories/new), not in public
issues. You should hear back within a few days.

## What Tidemark defends against

**Wrong data from RPC providers.** Providers lag, load-balance across nodes at different heights and
sometimes return short answers.

- Every `eth_getLogs` range is batched with `eth_blockNumber` to the same node and refused if the node's
  head does not cover it.
- Unfinalised blocks are always fetched by hash, never by number.
- `verify: "bloom"` checks each block against its header's bloom.
- `verify: "receipts-root"` derives logs from receipts proven against the header.
- `tidemark verify` re-checks the cache.
- A reorg below the finalised block halts that chain instead of guessing.

**Leaked secrets.** RPC URLs usually carry API keys. Endpoints are identified by index and hash in logs,
errors and metrics, and a central redactor removes URLs, path segments and query values from every error
message. API keys are stored as SHA-256 digests only.

**The SQL endpoint.** Queries are parsed with Postgres's own parser.

- Only a single `SELECT` over your tables is accepted, with an allowlist of functions (no `pg_sleep`,
  `dblink`, `lo_*`, `set_config` or `pg_read_file`, and no `reg*` casts).
- Queries run in a read-only transaction, with a statement timeout and a row cap.
- `tidemark db init` creates an API role that cannot write and cannot read the sync cache or the outbox,
  so even a query that got past the guard could do neither.

**Expensive queries.** GraphQL has depth, cost and page-size limits. Live queries are capped and only
re-run when a table they read changes. Requests can be rate-limited per key.

**The outbox as an SSRF vector.**

- Webhook URLs must be https.
- Every address a host resolves to must be public: private, loopback, link-local (including cloud
  metadata), CGNAT, NAT64, 6to4 and IPv4-mapped forms are refused.
- The connection is pinned to the checked address, and redirects are never followed.

**Forged or replayed webhooks.** Deliveries are signed with HMAC-SHA256 over a timestamp and the raw body,
with every configured secret so you can rotate. Ids are deterministic so receivers can dedupe.
`verifySignature` checks the tolerance window.

**Side effects that outlive a reorg.** Handlers cannot call out directly. Side effects go through the
outbox, which waits for finality or retracts what a reorg removed.

**The supply chain.** The lockfile and dependencies are pinned exactly, and GitHub Actions are pinned to
commits. CI runs gitleaks and CodeQL. Images are signed with cosign and ship an SBOM and provenance; npm
packages are published with provenance.

## Out of scope

- **Malicious handler code.** Handlers are your code, running on your infrastructure, and are not
  sandboxed.
- **Colluding providers.** A majority of the configured RPC providers presenting one consistent false
  chain. Run your own node if that is in your threat model.
