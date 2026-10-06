# Disposable local workflow test database

Created and verified on 2026-10-06 with explicit user permission to create a new
isolated target. No existing container, database or application environment was reused.

## Target

| Item | Verified value |
| --- | --- |
| Container | fiesta-workflow-test-pg |
| PostgreSQL | 17.11 (Debian 17.11-1.pgdg13+2) |
| Image tag | postgres:17 |
| Pulled digest | sha256:ae69c452f483507a6b99fb654cf93aad7fe156ffd2c56247707eef4e36d3c12b |
| Endpoint | 127.0.0.1:55433 only |
| Database | fiesta_workflow_test |
| Local bootstrap role | fiesta_test_admin |
| Data volume | fiesta-workflow-test-pg-data |
| Dedicated bridge | fiesta-workflow-test-isolated |
| Permanent public tables at creation and after restart | 0 |

Port 55432 was already occupied and was left unchanged. The existing mypet-postgres
container and its resources were not changed. The dedicated bridge is separate from
the existing compose services. It is not an air gap; PostgreSQL is published only on
loopback and no application code, live integration credentials or remote data is loaded.
This Docker version did not publish the port on an internal network, so only the newly
created empty test network was replaced with a dedicated bridge; the volume was retained.

The bootstrap role belongs only to this disposable cluster. It is not a production
runtime-role or least-privilege design approval. Separate runtime privileges still
require the storage/access-control review before integrating the application.

## Credentials and environment safety

The helper generated a random password without printing it. Its local state file is:

```text
%LOCALAPPDATA%\FiestaAI\workflow-test-db\state.json
```

The password is protected with Windows DPAPI for the current Windows account, not
stored in the OneDrive workspace or a tracked environment file. The helper decrypts
it only for the explicit local connection and restores affected process variables.
Docker administrators can inspect a container's environment; this is a throwaway
local credential, not a secret suitable for another account or production.

Do not paste the state file, password or connection URL into chat. The helper checks
resource labels, expected database metadata and exact loopback binding before connecting.
It supplies host/port/user/database explicitly and clears conflicting libpq service/
host-address options for the connection. It never reads the backend .env file.

## Commands

Run from the backend directory:

```powershell
.\scripts\workflow-test-db.ps1 -Action Verify
.\scripts\workflow-test-db.ps1 -Action Connect
.\scripts\workflow-test-db.ps1 -Action Stop
.\scripts\workflow-test-db.ps1 -Action Start
```

Connect opens psql directly for the current user without exposing the password.
Verify reports target identity/version, tests a temporary transaction and reports
permanent table count. It does not reset tables, run migrations or alter business data.
Stop preserves the volume and encrypted state. Start uses the same target and credential.
There is intentionally no automatic delete/reset action.

Create is only for an unused target and refuses existing named resources/state. Do
not rerun it to reset this database. If creation partially fails, the helper retains
its new resources/state for inspection rather than deleting possible data silently.
Keep Docker Desktop running while using the database. Starting the API is not required.

## Verification performed

- Docker daemon availability and unused 55433/container/volume/network names checked.
- PowerShell helper syntax validated before provisioning and after repair.
- Exact database and role verified over the explicit loopback TCP connection.
- Temporary table insert/read returned 42; the transaction was rolled back.
- Permanent public table count was zero; no application/workflow schema was installed.
- Owned container Stop/Start succeeded; repeat identity/read-write/table-count checks passed.

These are local target/lifecycle checks, not workflow migrations, engine integration,
backup-restoration tests or end-to-end acceptance. No production connection, payment,
Calendar operation, outbound customer message, .env edit, commit or deployment occurred.

## Remaining gates

Target selection is now satisfied. P01-P06 storage/access/delivery/ownership decisions
remain under review. Before applying anything, author and review the exact additive
schema artifacts, establish the isolated migration baseline, and rehearse a local
backup/restore or deterministic recreation procedure. Do not claim volume retention
or a successful restart proves backup restoration.

The live engine remains inactive. Do not change DATABASE_URL/DIRECT_URL in the existing
application environment or launch live-wired automation against this empty database.
Future tests/migration tooling need a scoped target adapter that decrypts only this
local credential, validates the target and restores environment state. It is not
implemented by creating the database.

Storage review: [WORKFLOW_STORAGE_DESIGN.md](WORKFLOW_STORAGE_DESIGN.md).
Core boundary: [WORKFLOW_ENGINE_CORE.md](WORKFLOW_ENGINE_CORE.md).