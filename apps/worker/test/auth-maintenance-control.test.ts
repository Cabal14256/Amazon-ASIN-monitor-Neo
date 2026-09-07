import { describe, expect, it, vi } from 'vitest';
import { controlAuthMaintenance } from '../src/auth-maintenance-control';

describe('Explicit authentication maintenance control', () => {
  it('durably pauses consumers before removing only owned scheduler definitions', async () => {
    const actions: string[] = [];
    const queue = {
      pause: vi.fn(async () => {
        actions.push('pause');
      }),
      resume: vi.fn(),
      removeJobScheduler: vi.fn(async (id: string) => {
        actions.push(id);
        return true;
      }),
    };
    await controlAuthMaintenance('stop', queue);
    expect(actions).toEqual([
      'pause',
      'auth-session-cleanup',
      'auth-audit-archive',
    ]);
    expect(queue.resume).not.toHaveBeenCalled();
  });
  it('keeps the queue paused when schedule removal fails', async () => {
    const queue = {
      pause: vi.fn(),
      resume: vi.fn(),
      removeJobScheduler: vi
        .fn()
        .mockRejectedValue(new Error('fixture failure')),
    };
    await expect(controlAuthMaintenance('stop', queue)).rejects.toThrow(
      'fixture failure',
    );
    expect(queue.pause).toHaveBeenCalledOnce();
    expect(queue.resume).not.toHaveBeenCalled();
  });
  it('resumes existing work without bypassing the scheduler lease', async () => {
    const queue = {
      pause: vi.fn(),
      resume: vi.fn(),
      removeJobScheduler: vi.fn(),
    };
    await controlAuthMaintenance('resume', queue);
    expect(queue.resume).toHaveBeenCalledOnce();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });
  it('rejects unknown commands before changing queue state', async () => {
    const queue = {
      pause: vi.fn(),
      resume: vi.fn(),
      removeJobScheduler: vi.fn(),
    };
    await expect(controlAuthMaintenance('drain', queue)).rejects.toThrow(
      'Expected maintenance command',
    );
    expect(queue.pause).not.toHaveBeenCalled();
    expect(queue.resume).not.toHaveBeenCalled();
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
  });
});
