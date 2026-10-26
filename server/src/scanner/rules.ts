import semver from 'semver';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Advisory } from './osv.ts';
import type { VersionFacts } from './facts.ts';
import type { Mention } from '../watchers/watchers.ts';

export const policy = {
  takeoverHours: 48,
  popularWeekly: 1_000_000,
};

// .depmap.yml in the scanned repo; strict so a typo fails the scan instead of silently relaxing the policy
const PolicyFile = z.strictObject({
  cooldown_hours: z.number().positive().default(Number(process.env.COOLDOWN_HOURS ?? 24)),
  block_on: z.array(z.enum(['red', 'amber', 'grey'])).default(['red']),
  allow: z.array(z.strictObject({ pkg: z.string(), reason: z.string() })).default([]),
  licenses: z.strictObject({ deny: z.array(z.string()).default([]) }).default({ deny: [] }),
});
export type Policy = z.infer<typeof PolicyFile>;

export function parsePolicy(src?: string | object | null): Policy {
  try {
    return PolicyFile.parse((typeof src === 'string' ? parseYaml(src) : src) ?? {});
  } catch (e) {
    throw new Error(`.depmap.yml: ${e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message}`);
  }
}
export const defaultPolicy = parsePolicy();

export function allowedBy(name: string, version: string, p: Policy) {
  return p.allow.find(({ pkg }) => {
    const at = pkg.lastIndexOf('@');
    return (at > 0 ? pkg.slice(0, at) : pkg) === name && semver.satisfies(version, at > 0 ? pkg.slice(at + 1) : '*');
  });
}

// which packages fail the gate under the policy, and the rule that made each one fail
export function gateFor(pvs: string[], states: { color: number; reasons: Reason[] }[], decided: Set<string>, p: Policy) {
  const blocked: { pv: string; rule: string }[] = [];
  const allowed: { pv: string; rule: string; reason: string }[] = [];
  pvs.forEach((pv, i) => {
    const color = COLORS[states[i].color];
    if (!p.block_on.includes(color as Policy['block_on'][number])) return;
    const at = pv.lastIndexOf('@');
    const allow = allowedBy(pv.slice(0, at), pv.slice(at + 1), p);
    if (allow) allowed.push({ pv, rule: `allow: ${allow.pkg}`, reason: allow.reason });
    else if (!decided.has(pv)) {
      const via = states[i].reasons.map((r) => r.policy).filter(Boolean);
      blocked.push({ pv, rule: [`block_on: ${color}`, ...new Set(via)].join(' · ') });
    }
  });
  return { pass: !blocked.length, undecidedReds: blocked.map((b) => b.pv), blocked, allowed };
}

export const COLOR = { green: 0, amber: 1, red: 2, grey: 3 } as const;
const COLORS = ['green', 'amber', 'red', 'grey'];
export type Reason = { code: string; severity: 'red' | 'amber'; text: string; url: string; policy?: string };
export type Assessment = { color: number; reasons: Reason[]; signals: Set<string> };

const POPULAR = ['react', 'lodash', 'express', 'chalk', 'debug', 'axios', 'commander', 'moment', 'request', 'webpack', 'typescript', 'eslint', 'jquery', 'vue', 'next', 'semver', 'uuid', 'yargs', 'colors', 'glob', 'minimist', 'dotenv', 'cors', 'body-parser', 'mongoose', 'socket.io', 'electron', 'babel-core', 'prettier', 'jest', 'mocha', 'ws', 'rxjs', 'tslib', 'ms', 'qs', 'async', 'bluebird', 'underscore', 'cross-env'];

export function npmUrl(name: string, version: string) {
  return `https://www.npmjs.com/package/${name}/v/${version}`;
}

// one insertion, deletion, substitution or adjacent swap
export function oneEdit(a: string, b: string) {
  if (a === b) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.length - s.length > 1) return false;
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  if (s.length < l.length) return s.slice(i) === l.slice(i + 1);
  return s.slice(i + 1) === l.slice(i + 1) || (s[i] === l[i + 1] && s[i + 1] === l[i] && s.slice(i + 2) === l.slice(i + 2));
}

function ago(hours: number) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

export function assess(name: string, version: string, facts: VersionFacts | null, advisories: Advisory[], asOf: string, mentions: Mention[] = [], devOnly = false, p = defaultPolicy): Assessment {
  const reasons: Reason[] = [];
  const signals = new Set<string>();
  const url = npmUrl(name, version);
  const add = (code: string, severity: 'red' | 'amber', text: string, link = url, rule?: string) => reasons.push({ code, severity, text, url: link, ...(rule && { policy: rule }) });

  for (const a of advisories) {
    if (a.kind === 'malicious') {
      signals.add('malicious');
      add('malicious', 'red', `${a.id}: ${a.summary}`, a.url);
    } else if ((a.severity === 'HIGH' || a.severity === 'CRITICAL') && a.fixed.length) {
      // malware in dev dependencies is still red (it runs in CI with secrets); a vulnerable build tool is not exposed to users
      add('vuln-high', devOnly ? 'amber' : 'red', `${a.id} (${a.severity}): ${a.summary}. Fixed in ${a.fixed.join(', ')}.${devOnly ? ' Dev-only: build-time exposure.' : ''}`, a.url);
    } else {
      add('vuln', 'amber', `${a.id} (${a.severity}): ${a.summary}`, a.url);
    }
  }

  for (const m of mentions) {
    signals.add('security-post');
    const when = ago((Date.parse(asOf) - Date.parse(m.item.published)) / 36e5);
    add('security-post', m.exact ? 'red' : 'amber', `${m.exact ? 'This exact version is named' : `${name} is named`} in "${m.item.title}" (${m.item.source}, ${when} ago).`, m.item.url);
  }

  if (facts) {
    const hours = facts.publishedAt ? (Date.parse(asOf) - Date.parse(facts.publishedAt)) / 36e5 : Infinity;
    const prev = facts.previous;
    // maintainers of busy packages take turns publishing; only someone outside the previous maintainer list is a handover
    const trustedPublishing = facts.provenance || /^(GitHub Actions|GitLab CI)/i.test(facts.publisher ?? '');
    const newPublisher = !!(prev && facts.publisher && prev.publisher && facts.publisher !== prev.publisher && !(prev.maintainers ?? []).includes(facts.publisher) && !trustedPublishing);
    const provenanceDropped = !!(prev?.provenance && !facts.provenance);
    const scriptAdded = facts.installScripts.some((s) => !prev?.installScripts.includes(s));
    const popular = (facts.weeklyDownloads ?? 0) >= policy.popularWeekly;
    if (hours >= 0 && hours < 48) signals.add('very-new');
    if (popular) signals.add('popular');
    if (newPublisher) signals.add('new-publisher');
    else if (prev) signals.add('same-publisher');
    if (scriptAdded) signals.add('install-script-added');
    if (!facts.installScripts.length) signals.add('no-install-script');
    if (provenanceDropped) signals.add('provenance-dropped');

    if (hours >= 0 && hours < p.cooldown_hours) {
      add('cooldown', 'red', `Published ${ago(hours)} before this scan${popular ? ` (${(facts.weeklyDownloads! / 1e6).toFixed(0)}M weekly downloads)` : ''}. Policy holds versions younger than ${p.cooldown_hours} h; most malicious releases are pulled within hours.`, url, `cooldown_hours: ${p.cooldown_hours}`);
    } else if (hours >= 0 && hours < policy.takeoverHours && (newPublisher || provenanceDropped || scriptAdded)) {
      add('takeover-shape', 'red', `New version (${ago(hours)} old) with ${[newPublisher && 'a new publisher', provenanceDropped && 'provenance dropped', scriptAdded && 'a new install script'].filter(Boolean).join(' and ')}.`);
    } else if (hours >= 0 && hours < p.cooldown_hours * 3) {
      add('recent', 'amber', `Published ${ago(hours)} ago.`);
    }
    if (scriptAdded) add('install-script-added', 'amber', `Adds ${facts.installScripts.join(', ')} script${facts.installScripts.length > 1 ? 's' : ''} not present in ${prev?.version ?? 'earlier versions'}.`);
    if (newPublisher && hours < 90 * 24) add('new-publisher', 'amber', `Published by ${facts.publisher}, who was not a maintainer of ${prev!.version} (published by ${prev!.publisher}).`);
    if (provenanceDropped) add('provenance-dropped', 'amber', `${prev!.version} had npm provenance; this version does not.`);
    const license = facts.license?.toLowerCase();
    const denied = license && p.licenses.deny.find((d) => license === d.toLowerCase() || license.startsWith(`${d.toLowerCase()}-`));
    if (denied) add('license-denied', 'red', `License ${facts.license} is denied by the repo policy (.depmap.yml licenses.deny: ${denied}).`, url, `licenses.deny: ${denied}`);
    if (facts.deprecated) add('deprecated', 'amber', `Deprecated: ${facts.deprecated}`);
    // the registry only shows today's state; a replay of a past moment must not know a version was pulled later
    const live = Date.now() - Date.parse(asOf) < 864e5;
    if (facts.unpublished && live) {
      signals.add('unpublished');
      add('unpublished', 'amber', 'This version has been removed from the registry.');
    }
    const twin = POPULAR.find((p) => oneEdit(p, name));
    if (twin && (facts.weeklyDownloads ?? 0) < 10_000) add('typosquat', 'amber', `Name is one edit away from "${twin}" and has few downloads.`);
  }

  const color = reasons.some((r) => r.severity === 'red') ? COLOR.red
    : reasons.length ? COLOR.amber
    : facts ? COLOR.green : COLOR.grey;
  return { color, reasons, signals };
}
