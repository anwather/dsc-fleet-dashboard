// Shape the request body for POST /servers/:id/provision-token.
//
// API contract recap (apps/api/src/routes/servers.ts):
//   - Empty body → silent reuse of persisted creds (back-compat for curl/scripts).
//   - { runAs: null } → switch task identity to SYSTEM and re-provision.
//   - { runAs: { kind: 'password', user, password } } → password account.
//   - { runAs: { kind: 'gmsa', user } } → gMSA.
//
// We deliberately never send `{ kind: 'system' }` here — that shape is only
// valid on PUT /servers/:id/run-as. On the provision-token route, "system"
// means "runAs: null". Centralising the shaping here is the only thing that
// stops AddServerDialog and ReprovisionDialog drifting apart.

export type RunAsKind = 'system' | 'password' | 'gmsa';

export interface RunAsInput {
  kind: RunAsKind;
  user?: string;
  password?: string;
}

export interface ProvisionTokenBody {
  runAs?: { kind: 'password' | 'gmsa'; user: string; password?: string } | null;
}

export function buildProvisionTokenBody(input: RunAsInput): ProvisionTokenBody {
  if (input.kind === 'system') {
    return { runAs: null };
  }
  if (input.kind === 'password') {
    return {
      runAs: {
        kind: 'password',
        user: (input.user ?? '').trim(),
        password: input.password ?? '',
      },
    };
  }
  return {
    runAs: {
      kind: 'gmsa',
      user: (input.user ?? '').trim(),
    },
  };
}
