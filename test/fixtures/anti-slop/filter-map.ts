export const ids = (rows: Array<{ id: string; live: boolean }>) => rows.filter((r) => r.live).map((r) => r.id);
