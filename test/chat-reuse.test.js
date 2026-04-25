import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseCascadeReuse, shouldUseStrictCascadeReuse } from '../src/handlers/chat.js';

describe('shouldUseCascadeReuse', () => {
  it('allows reuse for normal Cascade chat turns', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: false, modelKey: 'claude-4.5-haiku' }), true);
  });

  it('keeps most tool-emulated turns out of reuse', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-4.5-haiku' }), false);
  });

  it('allows reuse for tool-emulated Opus 4.7 turns', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4-7-medium' }), true);
  });

  it('can disable the Opus 4.7 tool reuse override', () => {
    assert.equal(shouldUseCascadeReuse({
      useCascade: true,
      emulateTools: true,
      modelKey: 'claude-opus-4-7-medium',
      allowToolReuse: false,
    }), false);
  });

  it('disables reuse outside Cascade', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: false, emulateTools: false, modelKey: 'claude-opus-4-7-medium' }), false);
  });

  // Regression: #59 widened the tool-emulated reuse override from 4.7-only
  // to 4.6/4.7. The matcher must accept both label conventions (dotted
  // `4.6` and dashed `4-6-medium`) and reject 4.5 / non-Opus models / the
  // not-Opus-4-x case that would otherwise look similar.
  it('allows tool-emulated reuse for Opus 4.6 (dotted)', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4.6' }), true);
  });

  it('allows tool-emulated reuse for Opus 4.6 (dashed variant)', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4-6-medium' }), true);
  });

  it('allows tool-emulated reuse for Opus 4.6 thinking', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4.6-thinking' }), true);
  });

  it('allows tool-emulated reuse for Opus 4.7 1m', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4-7-1m' }), true);
  });

  it('rejects Opus 4.5 (outside the widening)', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-opus-4.5' }), false);
  });

  it('rejects sonnet 4.6 (only Opus is tool-sensitive)', () => {
    assert.equal(shouldUseCascadeReuse({ useCascade: true, emulateTools: true, modelKey: 'claude-sonnet-4.6' }), false);
  });
});

describe('shouldUseStrictCascadeReuse', () => {
  it('strictly binds tool-emulated Opus 4.7 reuse by default', () => {
    assert.equal(shouldUseStrictCascadeReuse({
      emulateTools: true,
      modelKey: 'claude-opus-4-7-medium',
      strict: false,
      allowOpus47Strict: true,
    }), true);
  });

  it('strictly binds tool-emulated Opus 4.6 reuse (#59 widening)', () => {
    assert.equal(shouldUseStrictCascadeReuse({
      emulateTools: true,
      modelKey: 'claude-opus-4.6',
      strict: false,
      allowOpus47Strict: true,
    }), true);
  });

  it('does not strictly bind other models unless the global flag is on', () => {
    assert.equal(shouldUseStrictCascadeReuse({
      emulateTools: true,
      modelKey: 'claude-4.5-haiku',
      strict: false,
      allowOpus47Strict: true,
    }), false);
  });
});
