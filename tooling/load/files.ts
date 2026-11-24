// Where the load tests keep what they share: the stand's description and the results of every stage (.data is not in git).
import { fileURLToPath } from 'node:url';

export const LOAD_DIR = fileURLToPath(new URL('../../.data/load/', import.meta.url));
export const STAND_FILE = `${LOAD_DIR}stand.json`;
export const RESULTS_FILE = `${LOAD_DIR}results.jsonl`;
// The journal of the stand: `pnpm load:stand > .data/load/stand.log` — the errors of each stage are counted from it.
export const STAND_LOG = `${LOAD_DIR}stand.log`;

export interface LoadStand {
  pid: number;
  database: string;
  modelMs: number;
  longText: number;
  people: { email: string; ip: string; cookie: string }[];
}
