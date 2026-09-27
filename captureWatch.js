// Hyprland lists the RECORD reason on a monitor for as long as a screencopy
// session blocks its direct scanout, which is how the app learns it is being
// captured. Compositors without that state never report a session.
const { execFile } = require("child_process");

const RECORD_REASON = "RECORD";
const POLL_INTERVAL_MS = 250;
const HYPRCTL_TIMEOUT_MS = 2000;
const UNAVAILABLE_AFTER_FAILURES = 3;

function captureActiveFromMonitors(monitors) {
  if (!Array.isArray(monitors)) return false;
  return monitors.some(
    (monitor) =>
      Array.isArray(monitor?.directScanoutBlockedBy) &&
      monitor.directScanoutBlockedBy.includes(RECORD_REASON),
  );
}

function readMonitors(env, callback) {
  execFile(
    "hyprctl",
    ["-j", "monitors"],
    { env, timeout: HYPRCTL_TIMEOUT_MS },
    (error, stdout) => {
      if (error) {
        callback(error);
        return;
      }
      try {
        callback(null, JSON.parse(stdout));
      } catch (parseError) {
        callback(parseError);
      }
    },
  );
}

function createCaptureWatch({
  env = process.env,
  intervalMs = POLL_INTERVAL_MS,
  read = readMonitors,
  onCaptureChange,
  onUnavailable,
} = {}) {
  let timer = null;
  let polling = false;
  let captureActive = false;
  let hasReading = false;
  let failures = 0;
  let stopped = false;

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function poll() {
    if (polling || stopped) return;
    polling = true;
    read(env, (error, monitors) => {
      polling = false;
      if (stopped) return;
      if (error) {
        failures += 1;
        if (failures >= UNAVAILABLE_AFTER_FAILURES) {
          stop();
          if (onUnavailable) onUnavailable();
        }
        return;
      }
      failures = 0;
      const active = captureActiveFromMonitors(monitors);
      // The first reading is delivered even when no session is running, so the
      // caller can start out assuming a capture and then correct itself.
      if (hasReading && active === captureActive) return;
      hasReading = true;
      captureActive = active;
      if (onCaptureChange) onCaptureChange(active);
    });
  }

  function start() {
    if (stopped || timer) return;
    poll();
    timer = setInterval(poll, intervalMs);
    if (timer.unref) timer.unref();
  }

  return { start, stop, isCaptureActive: () => captureActive };
}

module.exports = {
  captureActiveFromMonitors,
  createCaptureWatch,
  RECORD_REASON,
  POLL_INTERVAL_MS,
};
