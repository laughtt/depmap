import type { Advisory } from './osv.ts';
import type { VersionFacts } from './facts.ts';
import type { Mention } from '../watchers/watchers.ts';

export const policy = {
  cooldownHours: Number(process.env.COOLDOWN_HOURS ?? 24),
  takeoverHours: 48,
  recentHours: 72,
  popularWeekly: 1_000_000,
};

export const COLOR = { green: 0, amber: 1, red: 2, grey: 3 } as const;
export type Reason = { code: string; severity: 'red' | 'amber'; text: string; url: string };
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

export function assess(name: string, version: string, facts: VersionFacts | null, advisories: Advisory[], asOf: string, mentions: Mention[] = [], devOnly = false): Assessment {
  const reasons: Reason[] = [];
  const signals = new Set<string>();
  const url = npmUrl(name, version);
  const add = (code: string, severity: 'red' | 'amber', text: string, link = url) => reasons.push({ code, severity, text, url: link });

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

    if (hours >= 0 && hours < policy.cooldownHours) {
      add('cooldown', 'red', `Published ${ago(hours)} before this scan${popular ? ` (${(facts.weeklyDownloads! / 1e6).toFixed(0)}M weekly downloads)` : ''}. Policy holds versions younger than ${policy.cooldownHours} h; most malicious releases are pulled within hours.`);
    } else if (hours >= 0 && hours < policy.takeoverHours && (newPublisher || provenanceDropped || scriptAdded)) {
      add('takeover-shape', 'red', `New version (${ago(hours)} old) with ${[newPublisher && 'a new publisher', provenanceDropped && 'provenance dropped', scriptAdded && 'a new install script'].filter(Boolean).join(' and ')}.`);
    } else if (hours >= 0 && hours < policy.recentHours) {
      add('recent', 'amber', `Published ${ago(hours)} ago.`);
    }
    if (scriptAdded) add('install-script-added', 'amber', `Adds ${facts.installScripts.join(', ')} script${facts.installScripts.length > 1 ? 's' : ''} not present in ${prev?.version ?? 'earlier versions'}.`);
    if (newPublisher && hours < 90 * 24) add('new-publisher', 'amber', `Published by ${facts.publisher}, who was not a maintainer of ${prev!.version} (published by ${prev!.publisher}).`);
    if (provenanceDropped) add('provenance-dropped', 'amber', `${prev!.version} had npm provenance; this version does not.`);
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
