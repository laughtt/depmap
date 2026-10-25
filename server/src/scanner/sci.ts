import { stats } from './http.ts';

// SCI = (E × I + M) per R (ISO/IEC 21031:2024), R = one dependency scan.
// E from Cloud Carbon Footprint GCP coefficients because shared runners expose no RAPL: 0.71–4.26 W per vCPU, 0.392 W per GB of memory, PUE 1.1, 0.001 kWh/GB network.
// I defaults to us-east1, where GitLab.com hosted runners run (Google 2025 table: 579 gCO2e/kWh). M (embodied) is not modelled and is reported as excluded.
const W_MIN = 0.71, W_MAX = 4.26, W_PER_GB = 0.392, PUE = 1.1, NET_KWH_PER_GB = 0.001;
const INTENSITY = Number(process.env.SCI_GRID_INTENSITY ?? 579);
const REGION = process.env.SCI_REGION ?? 'us-east1';

export function startMeter() {
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const s0 = { ...stats };
  return (packages: number) => {
    const wallS = (performance.now() - t0) / 1000;
    const cpu = process.cpuUsage(cpu0);
    const cpuS = (cpu.user + cpu.system) / 1e6;
    const util = Math.min(1, cpuS / Math.max(wallS, 1e-3));
    const memGb = process.memoryUsage().rss / 1e9;
    const bytes = stats.bytes - s0.bytes;
    const fetches = stats.fetches - s0.fetches;
    const cacheHits = stats.cacheHits - s0.cacheHits;
    const computeKwh = ((W_MIN + util * (W_MAX - W_MIN)) + memGb * W_PER_GB) * PUE * (wallS / 3600) / 1000;
    const networkKwh = (bytes / 1e9) * NET_KWH_PER_GB;
    const energyKwh = computeKwh + networkKwh;
    const avgBytes = fetches ? bytes / fetches : 20_000;
    const avoidedKwh = (cacheHits * avgBytes / 1e9) * NET_KWH_PER_GB;
    return {
      wallMs: Math.round(wallS * 1000), cpuMs: Math.round(cpuS * 1000), util: +util.toFixed(2), fetches, cacheHits, bytes, packages,
      energyKwh, gco2e: energyKwh * INTENSITY, gco2ePer1kPackages: packages ? (energyKwh * INTENSITY * 1000) / packages : 0,
      avoidedGco2e: avoidedKwh * INTENSITY, intensity: INTENSITY, region: REGION,
      method: 'SCI per scan; E from CCF GCP coefficients (measured CPU and wall time, RSS, bytes); I location-based; M excluded',
    };
  };
}
