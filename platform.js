const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

// Linux has no OS-level content protection, so the app watches for captures
// itself. Every Linux desktop gets the process and PipeWire probes; Hyprland
// adds its own session state on top.
function captureWatchSupported() {
  return isLinux;
}

function hideDockIconIfMac(app) {
  if (isMac && app.dock) app.dock.hide();
}

function isCommandOrControlPressed(input) {
  return isMac
    ? !!input.meta && !input.control
    : !!input.control && !input.meta;
}

const MAC_SYMBOLS = {
  CommandOrControl: "⌘",
  CmdOrCtrl: "⌘",
  Command: "⌘",
  Cmd: "⌘",
  Control: "⌃",
  Ctrl: "⌃",
  Alt: "⌥",
  Option: "⌥",
  Shift: "⇧",
};
const MAC_MODIFIER_ORDER = ["⌃", "⌥", "⇧", "⌘"];
const WINDOWS_NAMES = {
  CommandOrControl: "Ctrl",
  CmdOrCtrl: "Ctrl",
  Command: "Ctrl",
  Cmd: "Ctrl",
  Control: "Ctrl",
  Ctrl: "Ctrl",
  Alt: "Alt",
  Option: "Alt",
  Shift: "Shift",
};

function displayKey(part) {
  return part.length === 1 ? part.toUpperCase() : part;
}

function formatAccelerator(accelerator) {
  const parts = String(accelerator || "")
    .split("+")
    .filter(Boolean);
  if (parts.length === 0) return "";
  if (isMac) {
    const symbols = parts.map((part) => MAC_SYMBOLS[part] || displayKey(part));
    const modifiers = symbols
      .filter((symbol) => MAC_MODIFIER_ORDER.includes(symbol))
      .sort(
        (a, b) => MAC_MODIFIER_ORDER.indexOf(a) - MAC_MODIFIER_ORDER.indexOf(b),
      );
    const keys = symbols.filter(
      (symbol) => !MAC_MODIFIER_ORDER.includes(symbol),
    );
    return modifiers.join("") + keys.join("");
  }
  return parts.map((part) => WINDOWS_NAMES[part] || displayKey(part)).join("+");
}

function setPinned(win, pinned) {
  if (pinned) {
    win.setAlwaysOnTop(true, "screen-saver");
    if (isMac)
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenSpaces: true });
  } else {
    win.setAlwaysOnTop(false);
    if (isMac) win.setVisibleOnAllWorkspaces(false);
  }
}

function captureExclusionCaveat() {
  if (isWindows) {
    return "Screen-capture exclusion requires Windows 10 (build 19041) or later. On older Windows versions, notes may be visible to screen recordings.";
  }
  if (isLinux) {
    return "Capture detection covers compositor sessions and running recorders. A recorder that reads the display straight from the kernel can still see notes that are on screen.";
  }
  return null;
}

module.exports = {
  isMac,
  isWindows,
  isLinux,
  captureWatchSupported,
  hideDockIconIfMac,
  isCommandOrControlPressed,
  formatAccelerator,
  setPinned,
  captureExclusionCaveat,
};
