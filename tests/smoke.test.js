import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Smoke test: execute the real page module (init + one pipeline sample)
// under DOM stubs. Catches what unit tests + build cannot — module-eval
// crashes (e.g. the faceDetector TDZ that left the enable button dead) and
// runtime ReferenceErrors in the sample handler (e.g. the undeclared
// lastFaceT that broke every face-present sample). Neither `vite build`
// (no execution) nor pure-logic unit tests cover this layer.

function makeEl() {
  return {
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    style: {},
    dataset: {},
    files: [],
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    click() {},
    focus() {},
    select() {},
    getContext() {
      return new Proxy(
        {},
        {
          get: () => () => {},
          set: () => true,
        },
      );
    },
  };
}

let hooks;

before(async () => {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, makeEl());
    return els.get(id);
  };
  global.document = {
    getElementById: el,
    createElement: () => makeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    elementFromPoint: () => null,
    body: makeEl(),
    documentElement: { scrollHeight: 2000 },
  };
  global.window = {
    innerWidth: 1280,
    innerHeight: 800,
    scrollY: 0,
    isSecureContext: true,
    addEventListener() {},
    requestAnimationFrame: () => 0,
  };
  global.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  global.requestAnimationFrame = () => 0;
  global.setInterval = () => 0; // capture, don't run loops
  global.clearInterval = () => {};
  ({ __testHooks: hooks } = await import('../src/main.js'));
});

describe('page module smoke', () => {
  it('evaluates and initializes (status set, controls wired)', () => {
    assert.ok(hooks, 'test hooks exported');
    const status = global.document.getElementById('status');
    assert.ok(status.textContent.length > 0, 'init() ran and set status');
  });

  it('handles a face-present null sample without throwing', () => {
    assert.doesNotThrow(() =>
      hooks.handleSample({
        timestamp: 1000, x: null, y: null,
        normalizedX: null, normalizedY: null,
        confidence: 0, hasFace: true,
      }),
    );
  });

  it('handles a valid gaze sample end to end', () => {
    assert.doesNotThrow(() =>
      hooks.handleSample({
        timestamp: 2000, x: 640, y: 400,
        normalizedX: 0.5, normalizedY: 0.5,
        rawX: 640, rawY: 400, confidence: 0.9, hasFace: true,
      }),
    );
  });
});
