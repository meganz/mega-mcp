import { describe, it, expect } from 'vitest';
import { createConfirmStore } from '../src/confirm.js';

describe('confirm token store', () => {
  it('issues a token that confirms the same action+args', () => {
    const store = createConfirmStore();
    const args = { remotePath: '/a/b' };
    const token = store.issue('rm', args);
    expect(store.consume('rm', args, token)).toBe(true);
  });

  it('rejects a mismatched token', () => {
    const store = createConfirmStore();
    store.issue('rm', { remotePath: '/a' });
    expect(store.consume('rm', { remotePath: '/a' }, 'not-a-real-token')).toBe(false);
  });

  it('rejects when args differ from what was confirmed', () => {
    const store = createConfirmStore();
    const token = store.issue('rm', { remotePath: '/a' });
    expect(store.consume('rm', { remotePath: '/different' }, token)).toBe(false);
  });

  it('rejects when the action differs', () => {
    const store = createConfirmStore();
    const token = store.issue('rm', { remotePath: '/a' });
    expect(store.consume('deleteversions', { remotePath: '/a' }, token)).toBe(false);
  });

  it('is order-independent on object keys', () => {
    const store = createConfirmStore();
    const token = store.issue('share', { remotePath: '/a', withEmail: 'x@y.z' });
    expect(store.consume('share', { withEmail: 'x@y.z', remotePath: '/a' }, token)).toBe(true);
  });

  it('is single-use: a second consume of the same token fails', () => {
    const store = createConfirmStore();
    const args = { remotePath: '/a' };
    const token = store.issue('rm', args);
    expect(store.consume('rm', args, token)).toBe(true);
    expect(store.consume('rm', args, token)).toBe(false);
  });

  it('expires tokens after the TTL', () => {
    let now = 1_000_000;
    const store = createConfirmStore(100, () => now);
    const args = { remotePath: '/a' };
    const token = store.issue('rm', args);
    now += 101; // past TTL
    expect(store.consume('rm', args, token)).toBe(false);
  });
});
