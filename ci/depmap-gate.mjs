// depmap:gate: fail the pipeline while a red package has no human decision.
import { logger, readResult, registerJob } from './depmap-lib.mjs';

const { receipt: r } = readResult();
const { log, trace } = logger();

if (r.gate.pass) {
  log(`depmap gate: PASS (${r.counts.red} red, all decided; ${r.counts.amber} amber)`);
  await registerJob(trace());
  process.exit(0);
}

log(`depmap gate: FAIL, ${r.gate.undecidedReds.length} red package(s) without a decision:`);
for (const pv of r.gate.undecidedReds) {
  const red = r.reds.find((x) => x.pv === pv);
  log(`  x ${pv}`);
  for (const reason of red?.reasons ?? []) log(`      ${reason.code}: ${reason.text} (${reason.url})`);
  if (red?.fingerprint) log(`      looks like ${red.fingerprint.title}: ${red.fingerprint.matched} of ${red.fingerprint.total} signals`);
}
log('');
log('To proceed, change the dependency or record a decision as an MR comment, then re-run the pipeline:');
for (const pv of r.gate.undecidedReds) log(`  /depmap accept ${pv} 1d: <why the risk is acceptable>`);
log('  /depmap pin <pkg@previous-version>: <reason>');
log(`Page: ${r.urls.page ?? r.urls.map}`);
await registerJob(trace(), 'failed');
process.exit(1);
