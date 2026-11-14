import { describe, expect, it } from 'vitest';
import { buildProfile, BWRAP_SYSCALLS } from './build-profile.ts';

describe('seccomp profile for bubblewrap', () => {
  it('allows exactly the 7 calls of the isolation without conditions and keeps every other rule', () => {
    const base = {
      defaultAction: 'SCMP_ACT_ERRNO',
      syscalls: [
        { names: ['read', 'write'], action: 'SCMP_ACT_ALLOW' },
        { names: ['mount', 'unshare', 'bpf'], action: 'SCMP_ACT_ALLOW', includes: { caps: ['CAP_SYS_ADMIN'] } },
        { names: ['clone'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value: 2114060288, op: 'SCMP_CMP_MASKED_EQ' }], excludes: { caps: ['CAP_SYS_ADMIN'] } },
        { names: ['clone3'], action: 'SCMP_ACT_ERRNO', errnoRet: 38, excludes: { caps: ['CAP_SYS_ADMIN'] } },
      ],
    };
    const profile = buildProfile(base);
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    expect(profile.syscalls).toEqual([
      { names: ['read', 'write'], action: 'SCMP_ACT_ALLOW' },
      { names: ['bpf'], action: 'SCMP_ACT_ALLOW', includes: { caps: ['CAP_SYS_ADMIN'] } },
      { names: BWRAP_SYSCALLS, action: 'SCMP_ACT_ALLOW', comment: 'bubblewrap isolation of skill scripts (basic-business-agent)' },
    ]);
  });
});
