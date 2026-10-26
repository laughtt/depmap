// depmap:gate: fail the pipeline while a package the policy blocks (default: red; see .depmap.yml block_on) has no human decision.
import { logger, readResult, registerJob } from './depmap-lib.mjs';

const { receipt: r } = readResult();
const { log, trace } = logger();
const allowed = r.gate.allowed ?? [];

if (r.gate.pass) {
  log(`depmap gate: PASS (${r.counts.red} red, all decided; ${r.counts.amber} amber)`);
  for (const a of allowed) log(`  ok ${a.pv}: allowed by .depmap.yml ${a.rule} (${a.reason})`);
  await registerJob(trace());
  process.exit(0);
}

log(`depmap gate: FAIL, ${r.gate.undecidedReds.length} package(s) blocked by policy without a decision:`);
for (const pv of r.gate.undecidedReds) {
  const red = r.reds.find((x) => x.pv === pv);
  log(`  x ${pv}  [policy: ${r.gate.blocked?.find((b) => b.pv === pv)?.rule ?? 'block_on: red'}]`);
  for (const reason of red?.reasons ?? []) log(`      ${reason.code}: ${reason.text} (${reason.url})`);
  if (red?.fingerprint) log(`      looks like ${red.fingerprint.title}: ${red.fingerprint.matched} of ${red.fingerprint.total} signals`);
}
for (const a of allowed) log(`  ok ${a.pv}: allowed by .depmap.yml ${a.rule} (${a.reason})`);
log('');
log('To proceed, change the dependency or record a decision as an MR comment, then re-run the pipeline:');
for (const pv of r.gate.undecidedReds) log(`  /depmap accept ${pv} 1d: <why the risk is acceptable>`);
log('  /depmap pin <pkg@previous-version>: <reason>');
log('  or a standing exception in .depmap.yml (allow: [{ pkg: name@range, reason }]), reviewed by CODEOWNERS');
log(`Page: ${r.urls.page ?? r.urls.map}`);
await registerJob(trace(), 'failed');
process.exit(1);
