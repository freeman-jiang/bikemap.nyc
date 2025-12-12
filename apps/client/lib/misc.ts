export function createThrottledSampler(options: { intervalMs: number }) {
  const { intervalMs } = options;
  let lastSampleTime = 0;

  return {
    sample: (callback: () => void) => {
      const now = performance.now();
      if (now - lastSampleTime >= intervalMs) {
        callback();
        lastSampleTime = now;
      }
    },
    reset: () => {
      lastSampleTime = 0;
    },
  };
}
