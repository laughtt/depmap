export type Counts = { total: number; red: number; amber: number; green: number; grey: number };
export type Repo = { repo: string; snapshots: number; latest: { id: number; commitSha: string; ref: string; createdAt: string; counts: Counts } };
export type Snapshot = {
  id: number; commitSha: string; ref: string; createdAt: string; lockfileSha: string; counts: Counts; mrIid: number | null;
  kind?: "push" | "mr" | "refresh"; asOf?: string; gate?: { pass: boolean; undecidedReds: string[] };
};
export type State = { snapshotId: number; lockfileSha: string; asOf: string; color: Uint8Array; flags: Uint8Array; counts: Counts };
export type Verdict = "NEEDS_CHANGE" | "REVIEW" | "NO_CHANGE" | "PATH_ONLY";
export type AdviceItem = { file: string; line: number; code: string; problem: string; fix: string; alternatives: string[] };
export type Advice = {
  package: string; from: string; to: string; direct: boolean; verdict: Verdict; summary: string;
  items: AdviceItem[]; evidence: { kind: string; text: string; url: string }[]; paths: string[][];
};
export type Delta = {
  baseSnapshotId: number | null; added: string[]; removed: string[];
  upgraded: { name: string; from: string; to: string }[]; colorChanged: { pv: string; from: number; to: number }[]; advice: Advice[];
};
export type Reason = { code: string; severity: "red" | "amber" | "grey"; text: string; url: string };
export type Fingerprint = {
  id: string; title: string; matched: number; total: number; url: string; summary: string;
  signals: { id: string; label: string; hit: boolean }[];
};
export type Decision = { repo: string; pv: string; action: "accept" | "pin" | "fix"; reason: string; expiresAt?: string | null; by: string; createdAt?: string; mrUrl?: string | null };
export type PvDetail = {
  pv: string; name: string; version: string; color: number; reasons: Reason[]; fingerprint: Fingerprint | null;
  facts: {
    publishedAt: string | null; publisher: string | null; maintainers: string[]; installScripts: string[];
    provenance: boolean | null; deprecated: string | null; license: string | null; unpublished: boolean;
  };
  advisories: { id: string; kind: string; summary: string; severity: string; url: string }[];
  upgrade: Advice | null; decision: Decision | null;
};
export type DepEvent = { id: number; at: string; kind: string; repo: string; pv: string | null; snapshotId?: number; payload: Record<string, unknown> };
export type WatchSource = { id: string; name: string; kind: string; url: string; items: number; latest: string | null };
export type WatchItem = {
  id: string; source: string; title: string; url: string; published: string; summary: string;
  packages: { name: string; versions: string[] }[]; matched: string[];
};
export type CodeSite = { file: string; line: number; code: string; snippet: { line: number; text: string }[]; calls: { line: number; code: string; name: string }[]; url?: string };
export type CodeFix = {
  pv: string; name: string; version: string; color: number; direct: boolean; via: string[]; usedBy: string; usedIn: CodeSite[];
  action: { kind: "upgrade" | "pin" | "replace" | "remove"; text: string; version?: string; packageJson?: { before: string | null; after: string } } | null;
  alternatives: { for: string; name: string; kind: string; text: string; example?: string; url?: string }[];
  why: string[]; sources: { label: string; url: string }[];
  ai: { status: "queued" | "running" | "done" | "failed"; error: string | null; fix: AiFix | null } | null;
  mrUrl?: string | null;
};
export type AiFix = {
  needsCodeChange: boolean; summary: string; confidence: "high" | "medium" | "low"; risks: string[]; model: string; costUsd: number;
  edits: { file: string; startLine: number; endLine: number; before: string; after: string; why: string; required: boolean; url?: string }[];
  sources: { label: string; url: string }[];
};
export type WorldPackage = { name: string; versions: string[]; dependents: number; color: number; category: string; use: string[]; trust: string[] };
export type Remedy = { kind: "upgrade"; version: string; bump: string; clears?: number } | { kind: "switch"; version: string } | { kind: "remove" };
export type AdvisoryDetail = {
  id: string; cwe: string[]; affected: string[]; fixedIn: { version: string; bump: string } | null;
  sections: { title: string; blocks: { text?: string; code?: string }[] }[]; fixLinks: string[];
};
export type WorldVersion = {
  version: string; color: number; publishedAt: string | null; publisher: string | null; provenance: boolean | null;
  installScripts: string[]; deprecated: string | null; license: string | null;
  reasons: Reason[]; advisories: (PvDetail["advisories"][number] & { detail: AdvisoryDetail | null; remedy: Remedy })[];
  fingerprint: Fingerprint | null; repos: string[]; remedy: Remedy | null;
};
export type Connection = { id: string; gitlabUrl: string; user?: { username: string; name: string; avatarUrl: string }; username?: string };
export type Project = { id: number; pathWithNamespace: string; defaultBranch: string; webUrl: string; lastActivityAt: string };

const qs = new URLSearchParams(location.search);
let mockMode: boolean | null = qs.has("mock") ? qs.get("mock") !== "0" : null;
export const bigMock = qs.get("big") === "1";

export async function isMock(): Promise<boolean> {
  if (mockMode === null) {
    try {
      const r = await fetch("/api/health", { signal: AbortSignal.timeout(1500) });
      mockMode = !r.ok || !(await r.json()).ok;
    } catch {
      mockMode = true;
    }
  }
  return mockMode;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (await isMock()) return (await import("./mock")).mockCall(method, path, body) as Promise<T>;
  const r = await fetch(path, {
    method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error ?? msg; } catch {}
    throw new ApiError(r.status, msg);
  }
  return r.json();
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = encodeURIComponent;

export const api = {
  repos: () => call<Repo[]>("GET", "/api/repos"),
  snapshots: (repo: string) => call<Snapshot[]>("GET", `/api/repos/${enc(repo)}/snapshots`),
  state: async (id: number): Promise<State> => {
    const s = await call<Omit<State, "color" | "flags"> & { color: string; flags: string }>("GET", `/api/snapshots/${id}/state`);
    return { ...s, color: b64(s.color), flags: b64(s.flags) };
  },
  delta: (id: number) => call<Delta>("GET", `/api/snapshots/${id}/delta`),
  pv: (pv: string, snapshot: number) => call<PvDetail>("GET", `/api/pv?pv=${enc(pv)}&snapshot=${snapshot}`),
  decide: (d: Decision) => call<{ ok: boolean; decision: Decision }>("POST", "/api/decisions", d),
  events: (repo: string) => call<DepEvent[]>("GET", `/api/events?repo=${enc(repo)}`),
  watchers: () => call<{ lastPoll: string | null; sources: WatchSource[] }>("GET", "/api/watchers"),
  watchItems: (repo: string, limit = 60) => call<WatchItem[]>("GET", `/api/watchers/items?repo=${enc(repo)}&limit=${limit}`),
  poll: () => call<unknown>("POST", "/api/watchers/poll"),
  login: (mode: "login" | "signup", username: string, password: string) => call<{ ok: boolean }>("POST", `/api/${mode}`, { username, password }),
  connect: (gitlabUrl: string, token: string) => call<Connection>("POST", "/api/connections", { gitlabUrl, token }),
  connections: () => call<Connection[]>("GET", "/api/connections"),
  projects: (id: string) => call<Project[]>("GET", `/api/connections/${enc(id)}/projects`),
  importProject: (id: string, projectId: number, ref?: string) =>
    call<{ repo: string; snapshotId: number }>("POST", `/api/connections/${enc(id)}/import`, { projectId, ref }),
  world: () => call<{ nodes: WorldPackage[]; edges: [string, string][] }>("GET", "/api/world"),
  remedies: (snapshotId: number) => call<CodeFix[]>("GET", `/api/snapshots/${snapshotId}/remedies`),
  // 409 carries an authorize link when GitLab write access is still missing
  // pv null: every red package of the scan in one merge request
  fixMr: async (snapshotId: number, pv: string | null) => {
    const r = await fetch(`/api/snapshots/${snapshotId}/fix-mr`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pv, all: !pv, return: location.pathname + location.search }) });
    const b = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
    return r.ok ? { ok: true as const, ...(b as { mrUrl: string; iid: number; lockfile: boolean; codeChanges: number; fixed: string[]; left: string[] }) } : { ok: false as const, error: b.error as string, authorize: b.authorize as string | undefined };
  },
  remedy: async (snapshotId: number, pv: string) => (await call<CodeFix[]>("GET", `/api/snapshots/${snapshotId}/remedies?pv=${enc(pv)}`))[0] ?? null,
  worldPackage: (name: string) => call<{ name: string; versions: WorldVersion[]; dependents: string[] }>("GET", `/api/world/package?name=${enc(name)}`),
  graphBytes: async (lockfileSha: string): Promise<Uint8Array> => {
    const url = (await isMock()) ? (await import("./mock")).mockGraphUrl(lockfileSha) : `/api/graphs/${enc(lockfileSha)}.bin`;
    const r = await fetch(url);
    if (!r.ok) throw new ApiError(r.status, `Graph ${lockfileSha} could not be loaded (${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  },
};
