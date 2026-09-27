const test = require("node:test");
const assert = require("node:assert/strict");

const {
  captureActiveFromMonitors,
  createCaptureWatch,
} = require("../captureWatch");
const platform = require("../platform");

const monitor = (reasons) => ({
  name: "TEST-1",
  directScanoutBlockedBy: reasons,
});

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

test("announces a capture session once and then its end", async () => {
  const states = [
    monitor(["USER", "SW"]),
    monitor(["USER", "RECORD"]),
    monitor(["USER", "RECORD"]),
    monitor(["USER", "SW"]),
  ];
  const changes = [];
  const watch = createCaptureWatch({
    intervalMs: 5,
    read: (env, callback) =>
      callback(null, [states.shift() || monitor(["USER"])]),
    onCaptureChange: (active) => changes.push(active),
  });

  watch.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  watch.stop();

  assert.deepEqual(changes, [false, true, false]);
});

test("delivers the first reading even when no session is running", async () => {
  const changes = [];
  const watch = createCaptureWatch({
    intervalMs: 5,
    read: (env, callback) => callback(null, [monitor(["USER", "SW"])]),
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
    intervalMs: 5,
    read: (env, callback) => {
      reads += 1;
      if (reads === 1) callback(new Error("hyprctl hiccup"));
      else callback(null, [monitor(["RECORD"])]);
    },
    onCaptureChange: (active) => changes.push(active),
    onUnavailable: () => unavailable++,
  });

  watch.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  watch.stop();

  assert.deepEqual(changes, [true]);
  assert.equal(unavailable, 0);
});

test("ignores a reading that arrives after stop", () => {
  let deliver = null;
  const changes = [];
  const watch = createCaptureWatch({
    read: (env, callback) => {
      deliver = callback;
    },
    onCaptureChange: (active) => changes.push(active),
  });

  watch.start();
  watch.stop();
  deliver(null, [monitor(["RECORD"])]);

  assert.deepEqual(changes, []);
  assert.equal(watch.isCaptureActive(), false);
});

test("reports the state while a session runs", async () => {
  const watch = createCaptureWatch({
    intervalMs: 5,
    read: (env, callback) => callback(null, [monitor(["RECORD"])]),
  });

  watch.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(watch.isCaptureActive(), true);
  watch.stop();
});

test("gives up when the compositor state cannot be read", async () => {
  let unavailable = 0;
  const watch = createCaptureWatch({
    intervalMs: 5,
    read: (env, callback) => callback(new Error("hyprctl is missing")),
    onUnavailable: () => unavailable++,
  });

  watch.start();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(unavailable, 1);
  assert.equal(watch.isCaptureActive(), false);
});

test("offers the capture watch only on Linux inside a Hyprland session", () => {
  assert.equal(platform.captureWatchSupported({}), false);
  assert.equal(
    platform.captureWatchSupported({ HYPRLAND_INSTANCE_SIGNATURE: "abc" }),
    platform.isLinux,
  );
});
