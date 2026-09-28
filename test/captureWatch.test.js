const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  captureActiveFromMonitors,
  captureActiveFromProcesses,
  captureActiveFromPipeWire,
  createCaptureWatch,
  processesFromDir,
} = require("../captureWatch");
const platform = require("../platform");

const monitor = (reasons) => ({
  name: "TEST-1",
  directScanoutBlockedBy: reasons,
});

const process = (name, command) => ({ pid: 4242, name, command });

function fakeProcDir(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-notes-proc-"));
  for (const [pid, command] of entries) {
    const dir = path.join(root, String(pid));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "comm"), `${path.basename(command)} \n`);
    fs.writeFileSync(
      path.join(dir, "cmdline"),
      `${command.split(" ").join("\0")}\0`,
    );
  }
  return root;
}

function pipewireNode(props) {
  return { type: "PipeWire:Interface:Node", info: { props } };
}

test("reads an open capture session from the record reason", () => {
  assert.equal(
    captureActiveFromMonitors([monitor(["USER", "RECORD", "SW"])]),
    true,
  );
});

test("reports no session when the record reason is absent", () => {
  assert.equal(
    captureActiveFromMonitors([monitor(["USER", "SW", "CANDIDATE"])]),
    false,
  );
});

test("ignores payloads that are not a monitor list", () => {
  assert.equal(captureActiveFromMonitors(null), false);
  assert.equal(captureActiveFromMonitors({}), false);
  assert.equal(
    captureActiveFromMonitors([{}, { directScanoutBlockedBy: "RECORD" }]),
    false,
  );
});

test("recognizes screen recorders by name", () => {
  assert.equal(
    captureActiveFromProcesses([
      process("gpu-screen-recorder", "gpu-screen-recorder -w screen -f 60"),
    ]),
    true,
  );
  assert.equal(captureActiveFromProcesses([process("obs", "obs")]), true);
  assert.equal(
    captureActiveFromProcesses([
      process("python3", "/usr/bin/python3 /usr/bin/kooha"),
    ]),
    true,
  );
  assert.equal(
    captureActiveFromProcesses([
      process("wf-recorder", "wf-recorder -f out.mp4"),
    ]),
    true,
  );
});

test("recognizes ffmpeg only when it captures the screen", () => {
  assert.equal(
    captureActiveFromProcesses([
      process("ffmpeg", "ffmpeg -f kmsgrab -i - -c:v libx264 out.mp4"),
    ]),
    true,
  );
  assert.equal(
    captureActiveFromProcesses([
      process("ffmpeg", "ffmpeg -i clip.mp4 -c:v libx264 out.mp4"),
    ]),
    false,
  );
  assert.equal(
    captureActiveFromProcesses([
      process("gst-launch-1.0", "gst-launch-1.0 pipewiresrc ! fakesink"),
    ]),
    true,
  );
});

test("leaves one-shot screenshot tools and unrelated processes alone", () => {
  assert.equal(
    captureActiveFromProcesses([process("grim", "grim shot.png")]),
    false,
  );
  assert.equal(
    captureActiveFromProcesses([process("electron", "electron .")]),
    false,
  );
  assert.equal(captureActiveFromProcesses([]), false);
  assert.equal(captureActiveFromProcesses(null), false);
});

test("reads recorder processes off a proc tree", () => {
  const root = fakeProcDir([
    [11, "gpu-screen-recorder -w screen"],
    [12, "bash -lc echo hello"],
  ]);
  assert.equal(captureActiveFromProcesses(processesFromDir(root)), true);

  const quiet = fakeProcDir([[13, "bash -lc echo hello"]]);
  assert.equal(captureActiveFromProcesses(processesFromDir(quiet)), false);
});

test("reads a screencast stream from the PipeWire graph", () => {
  assert.equal(
    captureActiveFromPipeWire([
      pipewireNode({
        "media.class": "Video/Source",
        "media.role": "Screen",
        "node.name": "xdpw-stream-0x55",
      }),
    ]),
    true,
  );
  assert.equal(
    captureActiveFromPipeWire([
      pipewireNode({
        "media.class": "Video/Source",
        "node.name": "xdg-desktop-portal-hyprland",
      }),
    ]),
    true,
  );
});

test("does not mistake a camera or an unrelated node for a capture", () => {
  assert.equal(
    captureActiveFromPipeWire([
      pipewireNode({
        "media.class": "Video/Source",
        "media.role": "Camera",
        "node.name": "v4l2_input",
      }),
      pipewireNode({ "media.class": "Audio/Sink", "node.name": "speakers" }),
    ]),
    false,
  );
  assert.equal(captureActiveFromPipeWire(null), false);
});

function probe(name, readings, { intervalMs = 5, available } = {}) {
  return {
    name,
    intervalMs,
    available,
    read: (env, callback) => {
      const next = readings.length > 1 ? readings.shift() : readings[0];
      if (next instanceof Error) callback(next);
      else callback(null, typeof next === "function" ? next() : next);
    },
  };
}

test("hides while any probe reports a capture", async () => {
  const changes = [];
  const watch = createCaptureWatch({
    tickMs: 2,
    releaseDelayMs: 10,
    probes: [
      probe("sessions", [false, () => true, () => true], { intervalMs: 4 }),
      probe("processes", [false, false, false]),
    ],
    onCaptureChange: (active) => changes.push(active),
  });

  watch.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  watch.stop();

  assert.deepEqual(changes, [false, true]);
});

test("delivers the first reading even when nothing is capturing", async () => {
  const changes = [];
  const watch = createCaptureWatch({
    tickMs: 2,
    probes: [probe("processes", [false, false, false, false])],
    onCaptureChange: (active) => changes.push(active),
  });

  watch.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  watch.stop();

  assert.deepEqual(changes, [false]);
});

test("keeps watching after a single failed read", async () => {
  let reads = 0;
  let unavailable = 0;
  const changes = [];
  const watch = createCaptureWatch({
    tickMs: 2,
    probes: [
      {
        name: "processes",
        intervalMs: 4,
        read: (env, callback) => {
          reads += 1;
          if (reads === 1) callback(new Error("unreadable"));
          else callback(null, true);
        },
      },
    ],
    onCaptureChange: (active) => changes.push(active),
    onUnavailable: () => unavailable++,
  });

  watch.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  watch.stop();

  assert.deepEqual(changes, [true]);
  assert.equal(unavailable, 0);
});

test("gives up once every probe has failed", async () => {
  let unavailable = 0;
  const watch = createCaptureWatch({
    tickMs: 2,
    probes: [
      probe("sessions", [new Error("no hyprctl")]),
      probe("processes", [new Error("no /proc")]),
    ],
    onUnavailable: () => unavailable++,
  });

  watch.start();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(unavailable, 1);
  assert.equal(watch.isCaptureActive(), false);
});

test("does not raise unavailability for a probe that is not applicable", () => {
  let unavailable = 0;
  const watch = createCaptureWatch({
    tickMs: 2,
    probes: [
      probe("sessions", [false], { available: () => false }),
      probe("processes", [false]),
    ],
    onUnavailable: () => unavailable++,
  });

  watch.start();
  watch.stop();

  assert.equal(unavailable, 0);
});

test("gives up when no probe applies to this system", () => {
  let unavailable = 0;
  const watch = createCaptureWatch({
    tickMs: 2,
    probes: [probe("sessions", [false], { available: () => false })],
    onUnavailable: () => unavailable++,
  });

  watch.start();

  assert.equal(unavailable, 1);
});

test("ignores a reading that arrives after stop", () => {
  let deliver = null;
  const changes = [];
  const watch = createCaptureWatch({
    tickMs: 2,
    probes: [
      {
        name: "processes",
        intervalMs: 4,
        read: (env, callback) => {
          deliver = callback;
        },
      },
    ],
    onCaptureChange: (active) => changes.push(active),
  });

  watch.start();
  watch.stop();
  deliver(null, true);

  assert.deepEqual(changes, []);
  assert.equal(watch.isCaptureActive(), false);
});

test("offers the capture watch on Linux only", () => {
  assert.equal(platform.captureWatchSupported(), platform.isLinux);
});
