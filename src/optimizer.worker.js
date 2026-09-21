// Runs the greedy optimizer off the main thread so the UI stays responsive.
import { buildScene } from './propagation.js';
import { greedyPlacement } from './optimizer.js';

self.onmessage = (e) => {
  const { project, params, options } = e.data;
  try {
    const scene = buildScene(project, params);
    let last = 0;
    const result = greedyPlacement(scene, params, options, (fraction, message) => {
      const now = Date.now();
      if (now - last > 80 || fraction >= 1) { last = now; self.postMessage({ type: 'progress', fraction, message }); }
    });
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
