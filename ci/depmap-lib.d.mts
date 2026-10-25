export type Decision = { action: 'accept' | 'pin'; pv: string; days: number | null; reason: string; by: string; noteId: number };
export function parseDecisionCommands(notes: { id: number; body: string; author: { username: string; bot?: boolean } }[]): Decision[];
