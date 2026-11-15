// Every change of LiteLLM's deployments goes through here (spec, section 8.1): the catalog of models
// and keys and the pool of ChatGPT accounts share one queue, so each change computes LiteLLM's next
// state from ours without another change slipping in between.
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { deploymentsOf, reconcile, type GatewayTimeouts, type SyncModel, type SyncResult, type SyncState } from './gateway-sync.ts';
import type { DeploymentSpec, LiteLLMClient } from './litellm-client.ts';
import { syncModelOf, type ModelRow } from './model-rows.ts';

export interface GatewayWriterDeps {
  db: Db;
  box: SecretBox;
  client: LiteLLMClient;
  // Marks this installation's deployments in LiteLLM (GATEWAY_OWNER; a test database in tests).
  owner: string;
  // Models whose deployments are written in LiteLLM's config file, not copied by the server: the
  // mock models of the tests (test-catalog.ts). Empty in an installation.
  fileModelIds: ReadonlySet<string>;
  // How long the gateway waits on a provider (GATEWAY_TIMEOUTS; shorter in tests).
  timeouts: GatewayTimeouts;
}

// Plain functions, not methods: the catalog and the accounts take them apart.
export interface GatewayWriter {
  owner: string;
  serial: <T>(work: () => Promise<T>) => Promise<T>;
  // Our models, keys and active accounts, as LiteLLM should have them.
  state: () => Promise<SyncState>;
  desired: (state: SyncState) => DeploymentSpec[];
  // Brings LiteLLM to the given state; call inside serial().
  apply: (next: SyncState) => Promise<SyncResult>;
}

interface KeyRow {
  id: string;
  model_id: string;
  key_ciphertext: Buffer;
  key_iv: Buffer;
  key_version: number;
}

export function createGatewayWriter(deps: GatewayWriterDeps): GatewayWriter {
  const { db, box, client, owner, timeouts } = deps;
  let queue: Promise<unknown> = Promise.resolve();

  return {
    owner,
    serial: (work) => {
      const run = queue.then(work, work);
      queue = run.catch(() => undefined);
      return run;
    },

    state: async () => {
      const [models, keys, accounts] = await Promise.all([
        db.query<ModelRow>('SELECT * FROM app.models ORDER BY created_at, id'),
        db.query<KeyRow>('SELECT id, model_id, key_ciphertext, key_iv, key_version FROM app.model_provider_keys ORDER BY created_at, id'),
        db.query<{ id: string }>("SELECT id FROM app.chatgpt_accounts WHERE status = 'active' ORDER BY connected_at, id"),
      ]);
      const own: SyncModel[] = models.rows.filter((m) => !deps.fileModelIds.has(m.id)).map(syncModelOf);
      return {
        models: own,
        keys: keys.rows.map((k) => ({ id: k.id, modelId: k.model_id, secret: box.open({ ciphertext: k.key_ciphertext, iv: k.key_iv, keyVersion: k.key_version }) })),
        accounts: accounts.rows,
      };
    },

    desired: (state) => deploymentsOf(state, owner, timeouts),

    apply: (next) => reconcile(client, owner, deploymentsOf(next, owner, timeouts)),
  };
}
