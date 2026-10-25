// Signal shapes of real npm supply-chain incidents. Each signal id is produced by rules.assess().
export const FINGERPRINTS = [
  {
    id: 'chalk-debug-2025',
    title: 'chalk/debug account takeover (Sept 2025)',
    summary: 'A phished maintainer account republished 18+ hugely popular packages with a browser crypto-stealer. The versions lived about two hours.',
    url: 'https://www.csoonline.com/article/4053725/massive-npm-supply-chain-attack-hits-18-popular-packages-with-2b-weekly-downloads.html',
    signals: [
      ['very-new', 'Published within the last 48 hours'],
      ['popular', 'Over 1M weekly downloads'],
      ['same-publisher', 'Published by the usual account (hijacked, not handed over)'],
      ['no-install-script', 'Payload in the code, not in install scripts'],
    ],
  },
  {
    id: 'shai-hulud-2025',
    title: 'Shai-Hulud worm (Sept 2025)',
    summary: 'A self-replicating worm stole npm tokens through install scripts and republished every package the victim could publish.',
    url: 'https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem',
    signals: [
      ['very-new', 'Published within the last 48 hours'],
      ['install-script-added', 'A new postinstall/install script'],
      ['same-publisher', 'Published by the usual (stolen) account'],
      ['provenance-dropped', 'Provenance missing where it used to be'],
    ],
  },
  {
    id: 'ua-parser-js-2021',
    title: 'ua-parser-js hijack (Oct 2021)',
    summary: 'A hijacked account published three versions whose preinstall script dropped a cryptominer and a password stealer.',
    url: 'https://github.com/advisories/GHSA-pjwm-rvh2-c87w',
    signals: [
      ['very-new', 'Published within the last 48 hours'],
      ['install-script-added', 'A new preinstall script'],
      ['popular', 'Over 1M weekly downloads'],
    ],
  },
  {
    id: 'event-stream-2018',
    title: 'event-stream handover (Nov 2018)',
    summary: 'The maintainer handed the package to a stranger, who added a dependency carrying a wallet-stealing payload.',
    url: 'https://github.com/dominictarr/event-stream/issues/116',
    signals: [
      ['new-publisher', 'A different publisher than the previous version'],
      ['popular', 'Over 1M weekly downloads'],
      ['very-new', 'Published within the last 48 hours'],
    ],
  },
] as const;

export type FingerprintMatch = {
  id: string; title: string; summary: string; url: string; matched: number; total: number;
  signals: { id: string; label: string; hit: boolean }[];
};

// a fresh release of a popular package looks exactly like the chalk/debug attack until something anomalous shows up,
// which is why the cooldown rule exists; fingerprints need at least one anomaly
const ANOMALY = ['malicious', 'security-post', 'install-script-added', 'new-publisher', 'provenance-dropped'];

export function matchFingerprint(signals: Set<string>): FingerprintMatch | null {
  if (!ANOMALY.some((s) => signals.has(s))) return null;
  let best: FingerprintMatch | null = null;
  for (const f of FINGERPRINTS) {
    const list = f.signals.map(([id, label]) => ({ id, label, hit: signals.has(id) }));
    const matched = list.filter((s) => s.hit).length;
    if (matched < 2 || matched / list.length < 0.5) continue;
    if (!best || matched / list.length > best.matched / best.total) {
      best = { id: f.id, title: f.title, summary: f.summary, url: f.url, matched, total: list.length, signals: list };
    }
  }
  return best;
}
