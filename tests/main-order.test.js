import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Regression test: main.js once shipped `faceDetector` inside the
// LandmarkerGazeProvider initializer *before* its `const` declaration.
// Module evaluation threw (TDZ), init() never ran, and the enable button
// was dead — while `npm test` and `vite build` stayed green (neither
// executes the module). This asserts dependency-before-use order for the
// top-level provider wiring.
describe('main.js init order', () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.js'),
    'utf8',
  );

  function declLine(name) {
    const m = src.match(new RegExp(`^const ${name} =`, 'm'));
    assert.ok(m, `declaration of ${name} exists`);
    return src.slice(0, m.index).split('\n').length;
  }

  it('declares shared instances before the landmarker provider uses them', () => {
    const providerAt = declLine('landmarkerProvider');
    for (const dep of ['tracker', 'smoother', 'faceDetector']) {
      assert.ok(
        declLine(dep) < providerAt,
        `${dep} must be declared before landmarkerProvider (TDZ otherwise)`,
      );
    }
  });
});
