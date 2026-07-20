"use strict";

function createLifecycleState({ startedAt = new Date() } = {}) {
  let draining = false;
  let drainStartedAt = null;
  let shutdownSignal = null;

  return {
    beginDrain(signal = "shutdown") {
      if (!draining) {
        draining = true;
        drainStartedAt = new Date();
        shutdownSignal = String(signal || "shutdown");
      }

      return this.snapshot();
    },

    isDraining() {
      return draining;
    },

    snapshot() {
      return {
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)),
        draining,
        drainStartedAt: drainStartedAt ? drainStartedAt.toISOString() : null,
        shutdownSignal,
      };
    },
  };
}

const runtimeLifecycle = createLifecycleState();

module.exports = {
  createLifecycleState,
  runtimeLifecycle,
};
