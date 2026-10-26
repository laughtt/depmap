# The nine DevSecOps stages

How DepthMap touches every stage of GitLab's DevSecOps lifecycle. Each row names the GitLab feature, the artifact a judge can open, and whether it runs as deterministic CI (0 credits) or as a Duo flow.

| Stage | What happens | GitLab feature | Where to see it |
|---|---|---|---|
| **Plan** | A newly red package in any repo opens an issue labelled `security::watch`, with the reasons, the paths and the fix version. A human assigns it to the flow. | Issues, labels, the Assign trigger | `ci/depmap-refresh.mjs`, issues in each project |
| **Create** | The upgrade-impact advisor writes, per call site, what to change in *your* code (for example `src/log.js:1`: chalk 5 is ESM-only). The flow can open the pin/upgrade MR. | MR notes, `create_merge_request` | the MR note's "Upgrade impact" section |
| **Verify** | `depmap:gate` fails the pipeline on any undecided red package, and a human `/depmap accept …` note clears it. | Pipelines, "Pipelines must succeed" | `ci/templates/depmap.gitlab-ci.yml` |
| **Package** | Every scan exports a CycloneDX 1.5 SBOM with DepthMap risk as component properties, uploaded as a `cyclonedx` report. The service is packaged as one container. | CycloneDX report artifact, the dependency list, Container Registry | `/api/snapshots/:id/sbom.cdx.json`, `deploy/Dockerfile` |
| **Secure** | Behaviour signals (cooldown, takeover shape, install scripts, publisher handover, provenance), OSV and GitHub malware advisories, security watchers, and fingerprints of real attacks. | Duo flow (the investigator), MR notes | `server/src/scanner/`, `server/src/watchers/` |
| **Release** | The default branch deploys the API and UI container (Cloud Run script), and GitLab Pages publishes a static security page per repo. | Environments, GitLab Pages | `deploy/cloudrun-deploy.sh`, `scripts/export-pages.ts` |
| **Configure** | The policy (cooldown hours, popularity thresholds, grid intensity), `agent-config.yml` and the flow YAML live in the repo, protected by CODEOWNERS. | CODEOWNERS, `.gitlab/duo/agent-config.yml` | `server/src/scanner/rules.ts` (`policy`), `flows/depmap.flow.yml` |
| **Monitor** | Without any commit, a scheduled pipeline polls 7 security watchers (GitHub malware advisories, Aikido, StepSecurity, Wiz, Snyk, OpenSSF, CISA) and re-checks every branch head against new advisories. One advisory re-colours every repo that contains the package. | Scheduled pipelines | `/api/watchers`, `/api/refresh` |
| **Govern** | Every acceptance is a human note, stored with a reason and an **expiry**. Expired decisions re-block the gate. Events form an audit trail, and each scan carries an SCI carbon receipt. | MR notes as approvals, audit events | `decision` and `event` tables, `docs/GREEN.md` |
