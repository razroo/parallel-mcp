# Security policy

## Supported versions

Only the latest minor release line of `@razroo/parallel-mcp`,
`@razroo/parallel-mcp-server`, and `@razroo/parallel-mcp-testkit` receives
security fixes. Older versions will not get back-ported patches unless the
issue is critical and affects a still-supported release.

| Version line | Supported |
| ------------ | --------- |
| `0.2.x`      | ✅        |
| `< 0.2`      | ❌        |

## Reporting a vulnerability

**Please do not file a public GitHub issue for security problems.**

Use [GitHub Security Advisories][gh-sa] to open a private report. That
automatically includes the maintainer team and lets us coordinate a fix +
disclosure before details become public. If that flow is unavailable for
some reason, email `security@razroo.com` with:

1. A description of the issue and the affected package(s).
2. The smallest reproduction you can share (an input, a tool call, a
   state-machine sequence).
3. Any proof-of-concept exploit code — we will treat it as confidential.
4. Your suggested severity and any proposed remediation.

We will acknowledge receipt within **3 business days** and aim to provide
a fix or mitigation plan within **30 days** for high-severity issues.

[gh-sa]: https://github.com/razroo/parallel-mcp/security/advisories/new

## Scope

In scope:

- Logic bugs in `@razroo/parallel-mcp`'s state machine, leases, retries,
  or transactions that let a task double-execute, escape cancellation,
  or leak data across runs.
- SQL injection or integer / string coercion bugs in the SQLite adapter.
- MCP tool-surface vulnerabilities in `@razroo/parallel-mcp-server`
  (tool argument parsing, auth bypass on admin tools, response leakage).
- Supply-chain issues with our release pipeline (publishing provenance,
  tag validation).

Out of scope:

- Denial-of-service by simply enqueueing a very large number of tasks
  against a local SQLite file — this is a capacity-planning concern, not
  a vulnerability.
- Behaviors that require the reporter to already have write access to
  the MCP transport, the SQLite file, or the Node process itself — that
  is not a trust boundary this project claims to defend.
- Issues in user handler code (`WorkerHandler`) that crash / hang a
  worker; the contract is that workers are restartable and that
  lease expiry cleans them up.

## Our commitments

- Credit reporters in release notes unless you ask us not to.
- Publish a GitHub Security Advisory with a CVE once a fix ships.
- Cut a patch release (and republish all three packages at the same
  version) within the 30-day window for high-severity issues.
