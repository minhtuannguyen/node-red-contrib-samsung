"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// node_modules/wol/index.js
var require_wol = __commonJS({
  "node_modules/wol/index.js"(exports2, module2) {
    var net = require("net");
    var udp = require("dgram");
    function createMagicPacket(mac) {
      const MAC_REPEAT = 16;
      const MAC_LENGTH = 6;
      const PACKET_HEADER = 6;
      const parts = mac.match(/[0-9a-fA-F]{2}/g);
      if (!parts || parts.length != MAC_LENGTH)
        throw new Error(`malformed MAC address "${mac}"`);
      var buffer = Buffer.alloc(PACKET_HEADER);
      var bufMac = Buffer.from(parts.map((p) => parseInt(p, 16)));
      buffer.fill(255);
      for (var i = 0; i < MAC_REPEAT; i++) {
        buffer = Buffer.concat([buffer, bufMac]);
      }
      return buffer;
    }
    function wake(mac, options, callback) {
      options = options || {};
      if (typeof options == "function") {
        callback = options;
      }
      const { address, port } = Object.assign({
        address: "255.255.255.255",
        port: 9
      }, options);
      var magicPacket = createMagicPacket(mac);
      var socket = udp.createSocket(
        net.isIPv6(address) ? "udp6" : "udp4"
      ).on("error", function(err) {
        socket.close();
        callback && callback(err);
      }).once("listening", function() {
        socket.setBroadcast(true);
      });
      return new Promise((resolve, reject) => {
        socket.send(
          magicPacket,
          0,
          magicPacket.length,
          port,
          address,
          function(err, res) {
            let result = res == magicPacket.length;
            if (err) reject(err);
            else resolve(result);
            callback && callback(err, result);
            socket.close();
          }
        );
      });
    }
    module2.exports = {
      wake,
      createMagicPacket
    };
  }
});

// src/lib/wol.js
var require_wol2 = __commonJS({
  "src/lib/wol.js"(exports2, module2) {
    "use strict";
    var wol = require_wol();
    function sendWol2(mac, options = {}) {
      return new Promise((resolve, reject) => {
        const wolOptions = {
          address: options.address || "255.255.255.255",
          port: options.port || 9
        };
        wol.wake(mac, wolOptions, (err) => {
          if (err) {
            reject(new Error(`Wake-on-LAN failed: ${err.message || err}`));
          } else {
            resolve();
          }
        });
      });
    }
    module2.exports = { sendWol: sendWol2 };
  }
});

// src/nodes/samsung-tv-power.js
var { sendWol } = require_wol2();
var POWER_STATUS_LABELS = Object.freeze({
  on: Object.freeze({ fill: "green", shape: "dot", text: "on" }),
  standby: Object.freeze({ fill: "yellow", shape: "ring", text: "standby" }),
  booting: Object.freeze({ fill: "blue", shape: "ring", text: "booting" }),
  offline: Object.freeze({ fill: "red", shape: "ring", text: "offline" })
});
var VALID_INTENTS = /* @__PURE__ */ new Set(["on", "off", "toggle", "status"]);
var WANT_ON = Object.freeze(["on"]);
var WANT_OFF = Object.freeze(["standby", "offline"]);
var RESULT_OK = Object.freeze({ success: true, wentOffline: false });
var RESULT_WENT_OFFLINE = Object.freeze({ success: true, wentOffline: true });
var STATUS_IDLE = Object.freeze({ fill: "grey", shape: "ring", text: "idle" });
var STATUS_CHECKING = Object.freeze({ fill: "yellow", shape: "ring", text: "checking\u2026" });
var STATUS_POWERING_ON = Object.freeze({ fill: "yellow", shape: "ring", text: "powering on\u2026" });
var STATUS_POWERING_OFF = Object.freeze({ fill: "yellow", shape: "ring", text: "powering off\u2026" });
var STATUS_WAITING_ON = Object.freeze({ fill: "yellow", shape: "ring", text: "waiting for on\u2026" });
var STATUS_WAITING_OFF = Object.freeze({ fill: "yellow", shape: "ring", text: "waiting for off\u2026" });
var STATUS_TIMEOUT = Object.freeze({ fill: "red", shape: "ring", text: "timeout" });
var STATUS_NO_CFG = Object.freeze({ fill: "red", shape: "ring", text: "no TV configured" });
var STATUS_WOL_FAILED = Object.freeze({ fill: "red", shape: "dot", text: "WoL failed" });
var STATUS_WOL_SENT = Object.freeze({ fill: "blue", shape: "ring", text: "WoL sent" });
var STATUS_ERROR = Object.freeze({ fill: "red", shape: "dot", text: "error" });
var STATUS_WOL_WAITING = Object.freeze({ fill: "blue", shape: "ring", text: "waiting\u2026" });
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
module.exports = function(RED) {
  function SamsungTvPowerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.configNode = RED.nodes.getNode(config.tv);
    node.defaultAction = config.defaultAction || "toggle";
    node.wakeRetries = Math.max(0, parseInt(config.wakeRetries, 10) || 12);
    node.wakeRetryIntervalMs = Math.max(1e3, (parseFloat(config.wakeRetryInterval) || 8) * 1e3);
    node._overallTimeoutMs = node.wakeRetries * (node.wakeRetryIntervalMs + 3500) + 65e3;
    if (!node.configNode) {
      node.status(STATUS_NO_CFG);
      return;
    }
    node.status(STATUS_IDLE);
    const remote = node.configNode.remote;
    let busy = false;
    let _currentOpId = 0;
    let _overallTimer = null;
    const _retryStatus = { fill: "yellow", shape: "ring", text: "" };
    const _retrySuffix = "/" + node.wakeRetries + "\u2026";
    const _sendShim = function() {
      node.send.apply(node, arguments);
    };
    const log = (msg) => {
      if (node.configNode.enableLogging) node.log(msg);
    };
    let _statusTimer = null;
    function scheduleIdle(ms) {
      if (_statusTimer) clearTimeout(_statusTimer);
      _statusTimer = setTimeout(() => {
        _statusTimer = null;
        node.status(STATUS_IDLE);
      }, ms);
    }
    async function getPowerState() {
      const reachable = await remote.ping(1500);
      if (!reachable) {
        log("[samsung-power] ping \u2192 unreachable (offline)");
        return "offline";
      }
      const info = await remote.getInfo();
      if (!info) {
        log("[samsung-power] ping \u2192 reachable, getInfo \u2192 no HTTP response (booting)");
        return "booting";
      }
      log(
        "[samsung-power] ping \u2192 reachable, getInfo.PowerState \u2192 " + (info.rawPowerState === void 0 ? "FIELD ABSENT" : JSON.stringify(info.rawPowerState)) + " \u2192 state: " + (info.powerState === null ? "booting" : info.powerState === "standby" ? "standby" : "on")
      );
      if (info.powerState === null) return "booting";
      if (info.powerState === "standby") return "standby";
      return "on";
    }
    async function getActualPowerState() {
      const raw = await getPowerState();
      if (raw !== "booting") return raw;
      try {
        const { ws } = await node.configNode.connect();
        remote.disconnect(ws);
        log("[samsung-power] getActualPowerState: WS probe succeeded \u2014 TV is on (no PowerState field)");
        return "on";
      } catch (_) {
        log("[samsung-power] getActualPowerState: WS probe failed \u2014 TV is genuinely cold-booting");
        return "booting";
      }
    }
    async function pollForState(wantedStates, intervalMs, maxAttempts, isCancelled) {
      const wantOn = wantedStates.includes("on");
      let lastState = "offline";
      for (let i = 0; i < maxAttempts; i++) {
        await delay(intervalMs);
        if (isCancelled()) return lastState;
        lastState = await getPowerState();
        if (isCancelled()) return lastState;
        if (wantedStates.includes(lastState)) return lastState;
        if (wantOn && lastState === "booting") {
          if (isCancelled()) return lastState;
          try {
            const { ws } = await node.configNode.connect();
            remote.disconnect(ws);
            if (isCancelled()) return lastState;
            return "on";
          } catch (_) {
            if (isCancelled()) return lastState;
          }
        }
      }
      return lastState;
    }
    async function waitForTvReady(retries, intervalMs, mac, isCancelled) {
      log("[samsung-power] waitForTvReady: " + retries + " retries \xD7 " + intervalMs + "ms");
      for (let attempt = 1; attempt <= retries; attempt++) {
        if (isCancelled()) return "offline";
        _retryStatus.text = "waiting for TV \u2014 " + attempt + _retrySuffix;
        node.status(_retryStatus);
        await delay(intervalMs);
        if (isCancelled()) return "offline";
        const state = await getPowerState();
        log("[samsung-power] waitForTvReady attempt " + attempt + "/" + retries + ": state=" + state);
        if (isCancelled()) return "offline";
        if (state === "standby" || state === "on") {
          log("[samsung-power] waitForTvReady: TV ready, state=" + state);
          return state;
        }
        if (state === "booting") {
          try {
            const { ws } = await node.configNode.connect();
            remote.disconnect(ws);
            if (isCancelled()) return "offline";
            log("[samsung-power] waitForTvReady: WS connected with PowerState absent \u2014 model does not report PowerState; assuming standby, will send KEY_POWER");
            return "standby";
          } catch (_) {
            if (isCancelled()) return "offline";
            log("[samsung-power] waitForTvReady attempt " + attempt + ": WS probe failed \u2014 still booting");
          }
        }
        if (mac && attempt < retries && state === "offline") {
          try {
            await sendWol(mac);
          } catch (_) {
          }
          if (isCancelled()) return "offline";
        }
      }
      log("[samsung-power] waitForTvReady: exhausted all retries, returning offline");
      return "offline";
    }
    async function sendPowerKey() {
      try {
        const { ws } = await node.configNode.connect();
        try {
          await remote.sendKey(ws, "KEY_POWER");
          await delay(900);
        } finally {
          remote.disconnect(ws);
        }
        return RESULT_OK;
      } catch (err) {
        const stillUp = await remote.ping(1e3);
        if (!stillUp) return RESULT_WENT_OFFLINE;
        return { success: false, wentOffline: false, error: err };
      }
    }
    node.on("input", async function(msg, send, done) {
      send = send || _sendShim;
      if (!done) {
        const _origMsg = msg;
        done = function(err) {
          if (err) node.error(err, _origMsg);
        };
      }
      const topic = msg.topic;
      if (_statusTimer) {
        clearTimeout(_statusTimer);
        _statusTimer = null;
      }
      if (busy) {
        node.warn("samsung-tv-power: operation already in progress, ignoring message");
        send([null, { payload: null, status: "busy", error: "operation in progress", topic }]);
        done();
        return;
      }
      busy = true;
      const opId = ++_currentOpId;
      const isCancelled = () => _currentOpId !== opId;
      let timedOut = false;
      _overallTimer = setTimeout(() => {
        timedOut = true;
        _currentOpId++;
        busy = false;
        _overallTimer = null;
        node.status(STATUS_TIMEOUT);
        send([null, { payload: null, status: "error", error: "timeout", topic }]);
        done(new Error("Power node timed out after " + node._overallTimeoutMs + "ms"));
      }, node._overallTimeoutMs);
      const finish = (fn) => {
        if (timedOut) return;
        if (isCancelled()) {
          clearTimeout(_overallTimer);
          _overallTimer = null;
          busy = false;
          done();
          return;
        }
        clearTimeout(_overallTimer);
        _overallTimer = null;
        busy = false;
        fn();
      };
      let intent = msg.payload;
      const isValid = intent === true || intent === false || intent === 0 || intent === 1 || typeof intent === "string" && VALID_INTENTS.has(intent);
      if (!isValid) intent = node.defaultAction;
      msg = null;
      node.status(STATUS_CHECKING);
      log("[samsung-power] reading initial state, intent=" + intent);
      const currentState = await getActualPowerState();
      log("[samsung-power] initial state=" + currentState + ", intent=" + intent);
      if (isCancelled()) {
        finish(() => done());
        return;
      }
      if (intent === "status") {
        node.status(POWER_STATUS_LABELS[currentState]);
        finish(() => {
          send([{ payload: currentState === "on", state: currentState, topic }, null]);
          done();
        });
        return;
      }
      let wantOn;
      if (intent === true || intent === "on" || intent === 1) {
        wantOn = true;
      } else if (intent === false || intent === "off" || intent === 0) {
        wantOn = false;
      } else {
        wantOn = currentState !== "on";
      }
      const alreadyDone = wantOn ? currentState === "on" : currentState === "standby" || currentState === "offline" || currentState === "booting";
      if (alreadyDone) {
        node.status(POWER_STATUS_LABELS[currentState]);
        finish(() => {
          send([{ payload: currentState === "on", state: currentState, topic }, null]);
          done();
        });
        return;
      }
      node.status(wantOn ? STATUS_POWERING_ON : STATUS_POWERING_OFF);
      if (wantOn) {
        if (currentState === "offline" || currentState === "booting") {
          const mac = node.configNode.mac;
          let wolSent = false;
          if (currentState === "offline") {
            if (!mac) {
              node.warn("samsung-tv-power: no MAC configured \u2014 will wait for TV to appear on network (no Wake-on-LAN)");
            } else {
              try {
                await sendWol(mac);
                wolSent = true;
              } catch (err) {
                node.status(STATUS_WOL_FAILED);
                finish(() => {
                  send([null, { payload: null, status: "error", error: "WoL failed: " + err.message, topic }]);
                  done(err);
                });
                return;
              }
              if (isCancelled()) {
                finish(() => done());
                return;
              }
            }
          }
          if (node.wakeRetries === 0) {
            node.status(wolSent ? STATUS_WOL_SENT : STATUS_WOL_WAITING);
            finish(() => {
              send([{ payload: true, state: "booting", status: wolSent ? "wol-sent" : "waiting", topic }, null]);
              done();
            });
            return;
          }
          const readyState = await waitForTvReady(
            node.wakeRetries,
            node.wakeRetryIntervalMs,
            mac || null,
            isCancelled
          );
          if (isCancelled()) {
            finish(() => done());
            return;
          }
          if (readyState === "offline") {
            node.status(POWER_STATUS_LABELS.offline);
            finish(() => {
              send([null, {
                payload: null,
                status: "error",
                error: `TV did not become ready after ${node.wakeRetries} retries`,
                topic
              }]);
              done();
            });
            return;
          }
          if (readyState === "on") {
            node.status(POWER_STATUS_LABELS.on);
            finish(() => {
              send([{ payload: true, state: "on", topic }, null]);
              done();
            });
            return;
          }
          node.status(STATUS_POWERING_ON);
        }
        let result;
        for (let keyAttempt = 0; keyAttempt < 3; keyAttempt++) {
          result = await sendPowerKey();
          if (isCancelled()) {
            finish(() => done());
            return;
          }
          if (result.success || result.wentOffline) break;
          node.status({ fill: "yellow", shape: "ring", text: "KEY_POWER retry " + (keyAttempt + 1) + "/3\u2026" });
          await delay(3e3);
          if (isCancelled()) {
            finish(() => done());
            return;
          }
        }
        if (!result.success) {
          const recheckState = await getPowerState();
          if (isCancelled()) {
            finish(() => done());
            return;
          }
          node.status(POWER_STATUS_LABELS[recheckState] || POWER_STATUS_LABELS.offline);
          finish(() => {
            send([null, { payload: null, status: "error", error: result.error ? result.error.message : "send failed", state: recheckState, topic }]);
            done(result.error || void 0);
          });
          return;
        }
        if (result.wentOffline) {
          node.status(POWER_STATUS_LABELS.offline);
          finish(() => {
            send([null, { payload: null, status: "error", error: "TV went offline unexpectedly during power-on", state: "offline", topic }]);
            done();
          });
          return;
        }
        node.status(STATUS_WAITING_ON);
        const verifiedState = await pollForState(WANT_ON, 3e3, 10, isCancelled);
        if (isCancelled()) {
          finish(() => done());
          return;
        }
        if (verifiedState === "on") {
          node.status(POWER_STATUS_LABELS.on);
          finish(() => {
            send([{ payload: true, state: "on", topic }, null]);
            done();
          });
        } else {
          node.status(POWER_STATUS_LABELS[verifiedState] || POWER_STATUS_LABELS.offline);
          finish(() => {
            send([null, { payload: null, state: verifiedState, status: "error", error: "TV did not turn on in time", topic }]);
            done();
          });
        }
      } else {
        const result = await sendPowerKey();
        if (isCancelled()) {
          finish(() => done());
          return;
        }
        if (!result.success) {
          node.status(STATUS_ERROR);
          finish(() => {
            send([null, { payload: null, status: "error", error: result.error ? result.error.message : "send failed", topic }]);
            done(result.error || void 0);
          });
          return;
        }
        if (result.wentOffline) {
          node.status(POWER_STATUS_LABELS.offline);
          finish(() => {
            send([{ payload: false, state: "offline", topic }, null]);
            done();
          });
          return;
        }
        node.status(STATUS_WAITING_OFF);
        let verifiedState = await pollForState(WANT_OFF, 2e3, 10, isCancelled);
        if (isCancelled()) {
          finish(() => done());
          return;
        }
        if (verifiedState === "booting") {
          try {
            const { ws } = await node.configNode.connect();
            remote.disconnect(ws);
            log("[samsung-power] power-off verify: WS probe connected \u2014 TV still on");
          } catch (_) {
            log("[samsung-power] power-off verify: WS probe failed \u2014 TV is off (no PowerState field)");
            verifiedState = "standby";
          }
          if (isCancelled()) {
            finish(() => done());
            return;
          }
        }
        node.status(POWER_STATUS_LABELS[verifiedState] || POWER_STATUS_LABELS.standby);
        finish(() => {
          if (verifiedState === "standby" || verifiedState === "offline") {
            send([{ payload: false, state: verifiedState, topic }, null]);
          } else {
            send([null, { payload: null, state: verifiedState, status: "error", error: "TV did not turn off in time", topic }]);
          }
          done();
        });
      }
    });
    node.on("close", function() {
      _currentOpId++;
      busy = false;
      if (_overallTimer) {
        clearTimeout(_overallTimer);
        _overallTimer = null;
      }
      if (_statusTimer) {
        clearTimeout(_statusTimer);
        _statusTimer = null;
      }
    });
  }
  RED.nodes.registerType("samsung-tv-power", SamsungTvPowerNode);
};
