// A note is only invisible while nothing captures the screen, and Linux has no
// API that answers "is a capture running". This watch combines the signals that
// exist across desktops and distros: a compositor session that reports itself
// (Hyprland), a screen recorder running as a process, and a screencast stream
// on PipeWire. Any one of them keeps the notes hidden.
const fs = require("fs");
const net = require("net");
const path = require("path");
const { execFile } = require("child_process");

const HYPRLAND_RECORD_REASON = "RECORD";
const HYPRCTL_TIMEOUT_MS = 2000;
const PIPEWIRE_TIMEOUT_MS = 3000;
const TICK_MS = 250;
const RELEASE_DELAY_MS = 1500;
const FAILURES_BEFORE_DROP = 3;
const PIPEWIRE_MAX_BUFFER = 32 * 1024 * 1024;

// Long-running screen recorders, by executable name. One-shot screenshots
// (grim, scrot, flameshot, ...) are left out: they finish before the app could
// hide anything, and hiding for them would only make the notes flicker.
const RECORDER_COMMANDS = [
  "byzanz-record",
  "captura",
  "gnome-screenshot",
  "gpu-screen-recorder",
  "green-recorder",
  "kazam",
  "kooha",
  "obs",
  "peek",
  "recordmydesktop",
  "simplescreenrecorder",
  "vokoscreen",
  "vokoscreen-ng",
  "wf-recorder",
  "wl-screenrec",
];

// ffmpeg and gstreamer count as recorders only when the command line names a
// capture input, so transcoding a file does not hide the notes.
const GENERIC_RECORDERS = ["ffmpeg", "gst-launch-1.0", "gst-launch"];
const CAPTURE_ARGUMENTS =
  /(?:^|\s)(?:-f\s+)?(?:x11grab|kmsgrab|gdigrab|pipewire|pipewiresrc|avfoundation)\b/;

// Portal screencast streams name themselves after the portal or compositor
// that produces them, and carry media.role=Screen. Webcams are Video/Source
// too, which is why the role and name both matter.
const PORTAL_NODE_HINTS = [
  "xdg-desktop-portal",
  "xdpw-stream",
  "kwin-screen-cast",
  "gnome-shell",
  "screencast",
  "screen-cast",
];

function captureActiveFromMonitors(monitors) {
  if (!Array.isArray(monitors)) return false;
  return monitors.some(
    (monitor) =>
      Array.isArray(monitor?.directScanoutBlockedBy) &&
      monitor.directScanoutBlockedBy.includes(HYPRLAND_RECORD_REASON),
  );
}

function processCapturesScreen(entry) {
  const command = typeof entry?.command === "string" ? entry.command : "";
  const names = new Set();
  if (typeof entry?.name === "string" && entry.name.trim())
    names.add(path.basename(entry.name.trim()));
  for (const token of command.split(" ").slice(0, 2)) {
    if (token) names.add(path.basename(token));
  }
  for (const name of names) {
    if (RECORDER_COMMANDS.includes(name)) return true;
  }
  for (const name of names) {
    if (GENERIC_RECORDERS.includes(name))
      return CAPTURE_ARGUMENTS.test(command);
  }
  return false;
}

function captureActiveFromProcesses(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => processCapturesScreen(entry));
}

function captureActiveFromPipeWire(nodes) {
  if (!Array.isArray(nodes)) return false;
  return nodes.some((node) => {
    const props = node?.info?.props;
    if (!props || props["media.class"] !== "Video/Source") return false;
    if (String(props["media.role"] || "").toLowerCase() === "screen")
      return true;
    const label = [
      props["node.name"],
      props["application.name"],
      props["node.description"],
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return PORTAL_NODE_HINTS.some((hint) => label.includes(hint));
  });
}

function processesFromDir(root) {
  const processes = [];
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (_) {
    return processes;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const dir = path.join(root, name);
    try {
      processes.push({
        pid: Number(name),
        name: fs.readFileSync(path.join(dir, "comm"), "utf8").trim(),
        command: fs
          .readFileSync(path.join(dir, "cmdline"), "utf8")
          .split("\0")
          .join(" ")
          .trim(),
      });
    } catch (_) {
      // The process ended while it was being read.
    }
  }
  return processes;
}

function execJson(command, args, env, timeout, callback) {
  execFile(
    command,
    args,
    { env, timeout, maxBuffer: PIPEWIRE_MAX_BUFFER },
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

// The compositor answers on its own socket, which costs a fraction of spawning
// hyprctl, so the session probe can run often. hyprctl is the fallback when the
// socket is not where the environment says it should be.
function requestOverSocket(socketPath, command, callback) {
  const socket = net.createConnection(socketPath);
  let body = "";
  let done = false;
  const finish = (error, reply) => {
    if (done) return;
    done = true;
    socket.destroy();
    callback(error, reply);
  };
  socket.setEncoding("utf8");
  socket.setTimeout(HYPRCTL_TIMEOUT_MS, () => finish(new Error("timeout")));
  socket.on("connect", () => socket.write(command));
  socket.on("data", (chunk) => {
    body += chunk;
  });
  socket.on("end", () => finish(null, body));
  socket.on("error", (error) => finish(error));
}

function hyprlandCommandSocket(env) {
  if (!env.XDG_RUNTIME_DIR || !env.HYPRLAND_INSTANCE_SIGNATURE) return null;
  return path.join(
    env.XDG_RUNTIME_DIR,
    "hypr",
    env.HYPRLAND_INSTANCE_SIGNATURE,
    ".socket.sock",
  );
}

function readHyprlandSessions(env, callback) {
  const report = (error, data) => {
    if (error) {
      callback(error);
      return;
    }
    callback(null, captureActiveFromMonitors(data));
  };
  const socketPath = hyprlandCommandSocket(env);
  if (!socketPath) {
    execJson("hyprctl", ["-j", "monitors"], env, HYPRCTL_TIMEOUT_MS, report);
    return;
  }
  requestOverSocket(socketPath, "j/monitors", (error, body) => {
    if (error) {
      execJson("hyprctl", ["-j", "monitors"], env, HYPRCTL_TIMEOUT_MS, report);
      return;
    }
    try {
      report(null, JSON.parse(body));
    } catch (parseError) {
      callback(parseError);
    }
  });
}

function readRecorderProcesses(env, callback) {
  callback(null, captureActiveFromProcesses(processesFromDir("/proc")));
}

function readPortalStreams(env, callback) {
  execJson("pw-dump", [], env, PIPEWIRE_TIMEOUT_MS, (error, data) =>
    callback(error, error ? null : captureActiveFromPipeWire(data)),
  );
}

function defaultProbes(env = process.env) {
  const onHyprland = !!env.HYPRLAND_INSTANCE_SIGNATURE;
  return [
    {
      name: "hyprland",
      intervalMs: 250,
      available: () => onHyprland,
      read: readHyprlandSessions,
    },
    { name: "processes", intervalMs: 500, read: readRecorderProcesses },
    {
      name: "pipewire",
      // On Hyprland the session probe already covers portal shares, so this one
      // only runs as a slow backstop there.
      intervalMs: onHyprland ? 2000 : 1000,
      available: () => !!env.XDG_RUNTIME_DIR,
      read: readPortalStreams,
    },
  ];
}

function createCaptureWatch({
  env = process.env,
  probes = defaultProbes(env),
  tickMs = TICK_MS,
  releaseDelayMs = RELEASE_DELAY_MS,
  onCaptureChange,
  onUnavailable,
} = {}) {
  const states = probes.map((probe) => ({
    probe,
    applicable: probe.available ? !!probe.available(env) : true,
    active: null,
    failures: 0,
    dropped: false,
    inFlight: false,
    dueAt: 0,
  }));
  let timer = null;
  let releaseTimer = null;
  let captureActive = false;
  let hasReading = false;
  let stopped = false;
  let finished = false;

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    if (releaseTimer) clearTimeout(releaseTimer);
    timer = null;
    releaseTimer = null;
  }

  function giveUp() {
    if (finished) return;
    finished = true;
    stop();
    if (onUnavailable) onUnavailable();
  }

  function publish() {
    const active = states.some(
      (state) => state.applicable && !state.dropped && state.active === true,
    );
    if (active) {
      if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      // The first reading is delivered even when nothing is capturing, so the
      // caller can start out assuming a capture and then correct itself.
      if (hasReading && captureActive) return;
      hasReading = true;
      captureActive = true;
      if (onCaptureChange) onCaptureChange(true);
      return;
    }
    if (!hasReading) {
      hasReading = true;
      captureActive = false;
      if (onCaptureChange) onCaptureChange(false);
      return;
    }
    // Compositor session state can drop out for a sample mid-capture, so the
    // notes stay hidden through a short quiet period instead of flickering.
    if (!captureActive || releaseTimer) return;
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (stopped) return;
      captureActive = false;
      if (onCaptureChange) onCaptureChange(false);
    }, releaseDelayMs);
    if (releaseTimer.unref) releaseTimer.unref();
  }

  function drop(state) {
    state.dropped = true;
    if (states.every((other) => !other.applicable || other.dropped)) giveUp();
  }

  function pollProbe(state, now) {
    state.inFlight = true;
    state.dueAt = now + state.probe.intervalMs;
    state.probe.read(env, (error, active) => {
      state.inFlight = false;
      if (stopped) return;
      if (error) {
        state.failures += 1;
        if (state.failures >= FAILURES_BEFORE_DROP) drop(state);
        return;
      }
      state.failures = 0;
      state.active = !!active;
      publish();
    });
  }

  function tick() {
    if (stopped) return;
    const now = Date.now();
    for (const state of states) {
      if (!state.applicable || state.dropped || state.inFlight) continue;
      if (now < state.dueAt) continue;
      pollProbe(state, now);
    }
  }

  function start() {
    if (stopped || timer) return;
    if (states.every((state) => !state.applicable)) {
      giveUp();
      return;
    }
    tick();
    timer = setInterval(tick, tickMs);
    if (timer.unref) timer.unref();
  }

  return { start, stop, isCaptureActive: () => captureActive };
}

module.exports = {
  captureActiveFromMonitors,
  captureActiveFromProcesses,
  captureActiveFromPipeWire,
  createCaptureWatch,
  defaultProbes,
  processesFromDir,
  readHyprlandSessions,
  HYPRLAND_RECORD_REASON,
};
