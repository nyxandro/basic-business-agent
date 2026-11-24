// For the tests of «Поддержка»: the database of the installation where the people of a right cannot be read — whom to tell
// after a ticket or a message is saved.
import type { Db } from '../db/pool.ts';

type Method = (...args: unknown[]) => unknown;

export function withoutHolders(db: Db): Db {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'query') {
        return (sql: unknown, ...rest: unknown[]) =>
          typeof sql === 'string' && sql.includes('r.permissions ?') ? Promise.reject(new Error('the holders of a right are not read')) : (target.query as Method).call(target, sql, ...rest);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as Method).bind(target) : value;
    },
  });
}
