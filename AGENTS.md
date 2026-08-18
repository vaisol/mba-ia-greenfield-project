# AGENTS.md

Workspace hygiene and security operations for this opencode instance.
Project development rules (architecture, conventions, testing, Definition of
Done) live in [CLAUDE.md](CLAUDE.md) — this file covers only session lifecycle
and vulnerability management.

## Pre-Quit Teardown (REQUIRED before /quit)

Before processing the `/quit` command to exit opencode, run the full teardown
of the test infrastructure started during the session and free all opened
ports. Never quit with test services still running.

Docker is not usable in this workspace (`permission denied` on
`/var/run/docker.sock`), so test services run natively. Teardown steps:

1. Stop ad-hoc test services:
   - Redis: `sudo service redis-server stop`
   - MinIO: `pkill -f '/tmp/opencode/minio server'`
   - Mailpit: `pkill -f '/tmp/opencode/mailpit'`
2. Remove the service-name aliases if the session added them to `/etc/hosts`:
   `sudo sed -i '/^127.0.0.1 db redis minio mailpit$/d' /etc/hosts`
3. Clean transient data: `rm -rf /tmp/opencode/minio-data`
   (downloaded binaries may stay in `/tmp/opencode` for reuse).
4. PostgreSQL: only stop the cluster if the agent started it during the
   session (`sudo pg_ctlcluster 16 main stop`) and only drop the
   session-created `streamtube` role/database if the session created them.
   If the cluster was already running before the session, leave it as-is.
5. Verify no ports are left bound:
   `ss -tlnp | grep -E '5432|6379|9000|9001|8025|1025'`
   Expect no output except pre-existing host services.
6. Remove session test logs (`/tmp/opencode/*.log`) if no longer needed.

## Vulnerability Scanning (crontab)

A crontab entry for the current user runs a weekly dependency scan on the
backend project:

```cron
0 6 * * 1 PATH=/home/roots.guest/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin cd /Users/roots/caudecodeworkingfolder/opencode/Template/mba-ia-greenfield-project/nestjs-project && npm audit --audit-level=high > /tmp/opencode/npm-audit.log 2>&1
```

Policy:

- Verify the entry is installed with `crontab -l`; reinstall it if missing.
- On every session start, check `/tmp/opencode/npm-audit.log` (and run
  `npm audit` on demand). Vulnerabilities identified are fixed as soon as
  they are found — update the affected dependencies, then re-run the full
  suite (`npm test -- --runInBand`), `npx tsc --noEmit`, and `npm run lint`
  before declaring the fix done. Use the auditing-dependencies skill for
  remediation.
