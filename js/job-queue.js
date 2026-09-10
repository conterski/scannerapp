/* job-queue.js — runs jobs one after another, never two at once.
 *
 * For work that walks the whole document: adding a batch of photos,
 * re-compressing every scan, re-rendering every scan. Two of those interleaved
 * would each be working from a list the other is changing, and both would be
 * driving the same OpenCV worker. The busy overlay happens to block the taps
 * that would start a second one today, but that is the stylesheet's doing —
 * this is the same rule stated in code, where it also covers the console and
 * anything that runs without an overlay.
 *
 * Exposes window.JobQueue.
 */
(function () {
  "use strict";

  function create() {
    let tail = Promise.resolve();
    let running = 0;

    /**
     * Queues `job` to start once everything queued before it has finished.
     * @returns the job's own promise — it resolves and rejects exactly as the
     *          job does, so callers keep their existing error handling.
     */
    function run(job) {
      running++;
      const started = tail.then(() => job());
      const settle = () => { running--; };
      // The queue follows a settled promise, never a rejected one: a job that
      // throws must not stall everything behind it.
      tail = started.then(settle, settle);
      return started;
    }

    return { run, isBusy: () => running > 0 };
  }

  window.JobQueue = { create };
})();
