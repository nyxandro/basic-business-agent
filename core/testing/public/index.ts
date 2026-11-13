// Test helpers for plugins and installation code: a fresh database and a tool context of an employee.
import { RequestContext } from '@mastra/core/request-context';
import { REQUEST_KEYS } from '../../runtime/request-keys.ts';

export { migrate } from '../../db/migrate.ts';
export { createPool, type Db } from '../../db/pool.ts';
export { createTestDatabase, type TestDatabase } from '../../db/test-database.ts';

// The second argument of a tool's execute(), as the core passes it when an employee runs the agent.
export function toolContextFor(userId: string): { requestContext: RequestContext } {
  const requestContext = new RequestContext();
  requestContext.set(REQUEST_KEYS.userId, userId);
  return { requestContext };
}
