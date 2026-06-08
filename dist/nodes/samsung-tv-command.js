"use strict";

// src/nodes/samsung-tv-command.js
var STATUS_IDLE = Object.freeze({ fill: "grey", shape: "ring", text: "idle" });
var STATUS_NO_CFG = Object.freeze({ fill: "red", shape: "ring", text: "no TV configured" });
var STATUS_PAIRING = Object.freeze({ fill: "yellow", shape: "ring", text: "pairing\u2026" });
var STATUS_PAIRED = Object.freeze({ fill: "green", shape: "dot", text: "paired \u2014 token saved" });
var STATUS_PAIR_FAIL = Object.freeze({ fill: "red", shape: "dot", text: "pairing failed" });
var STATUS_PINGING = Object.freeze({ fill: "yellow", shape: "ring", text: "pinging\u2026" });
var STATUS_OFFLINE = Object.freeze({ fill: "red", shape: "dot", text: "TV offline" });
var STATUS_LAUNCHING = Object.freeze({ fill: "yellow", shape: "ring", text: "launching app\u2026" });
var STATUS_LAUNCHED = Object.freeze({ fill: "green", shape: "dot", text: "app launched" });
var STATUS_LAUNCH_FAIL = Object.freeze({ fill: "red", shape: "dot", text: "launch failed" });
var STATUS_CONNECTING = Object.freeze({ fill: "yellow", shape: "ring", text: "connecting\u2026" });
var STATUS_CONN_FAIL = Object.freeze({ fill: "red", shape: "dot", text: "connect failed" });
var STATUS_SENDING = Object.freeze({ fill: "yellow", shape: "ring", text: "sending\u2026" });
var STATUS_SEND_FAIL = Object.freeze({ fill: "red", shape: "dot", text: "send failed" });
var STATUS_VERIFYING = Object.freeze({ fill: "yellow", shape: "ring", text: "verifying\u2026" });
var STATUS_OFFLINE_AFT = Object.freeze({ fill: "red", shape: "dot", text: "offline after send" });
var STATUS_SENT = Object.freeze({ fill: "green", shape: "dot", text: "sent" });
module.exports = function(RED) {
  function SamsungTvCommandNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.configNode = RED.nodes.getNode(config.tv);
    node.mode = config.mode || "key";
    node.defaultKey = config.defaultKey || "";
    node.appId = config.appId || "";
    if (!node.configNode) {
      node.status(STATUS_NO_CFG);
      return;
    }
    node.status(STATUS_IDLE);
    const remote = node.configNode.remote;
    const _sendShim = function() {
      node.send.apply(node, arguments);
    };
    let busy = false;
    let _opId = 0;
    let _resetTimer = null;
    function scheduleIdle(ms) {
      if (_resetTimer) clearTimeout(_resetTimer);
      _resetTimer = setTimeout(() => {
        _resetTimer = null;
        node.status(STATUS_IDLE);
      }, ms);
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
      if (_resetTimer) {
        clearTimeout(_resetTimer);
        _resetTimer = null;
      }
      if (busy) {
        node.warn("samsung-tv-command: operation already in progress, ignoring message");
        send([null, { payload: null, status: "busy", error: "operation in progress", topic }]);
        done();
        return;
      }
      busy = true;
      const myOpId = ++_opId;
      const isCancelled = () => _opId !== myOpId;
      try {
        if (node.mode === "pair") {
          msg = null;
          node.status(STATUS_PAIRING);
          try {
            const result = await node.configNode.connect();
            remote.disconnect(result.ws);
            if (isCancelled()) {
              done();
              return;
            }
            node.status(STATUS_PAIRED);
            send([{ payload: true, status: "paired", token: result.token, topic }, null]);
            done();
          } catch (err) {
            if (isCancelled()) {
              done();
              return;
            }
            node.status(STATUS_PAIR_FAIL);
            send([null, { payload: null, status: "error", error: err.message, topic }]);
            done(err);
          }
          scheduleIdle(3e3);
          return;
        }
        if (node.mode === "app") {
          const appId = msg.payload && typeof msg.payload === "string" ? msg.payload : node.appId;
          msg = null;
          if (!appId) {
            done(new Error("No App ID provided in msg.payload and none configured in the node"));
            return;
          }
          node.status(STATUS_PINGING);
          const reachable2 = await remote.ping(1500);
          if (isCancelled()) {
            done();
            return;
          }
          if (!reachable2) {
            node.status(STATUS_OFFLINE);
            send([null, { payload: null, status: "offline", topic }]);
            done();
            scheduleIdle(3e3);
            return;
          }
          node.status(STATUS_LAUNCHING);
          const ok = await remote.launchApp(appId);
          if (isCancelled()) {
            done();
            return;
          }
          if (ok) {
            node.status(STATUS_LAUNCHED);
            send([{ payload: true, status: "ok", appId, topic }, null]);
            done();
            scheduleIdle(2e3);
          } else {
            node.status(STATUS_LAUNCH_FAIL);
            send([null, { payload: null, status: "error", error: "App launch returned failure", appId, topic }]);
            done();
            scheduleIdle(3e3);
          }
          return;
        }
        const commands = node.defaultKey;
        msg = null;
        if (!commands) {
          done(new Error("No key configured \u2014 open the node editor and select a key"));
          return;
        }
        node.status(STATUS_PINGING);
        const reachable = await remote.ping(1500);
        if (isCancelled()) {
          done();
          return;
        }
        if (!reachable) {
          node.status(STATUS_OFFLINE);
          send([null, { payload: null, status: "offline", topic }]);
          done();
          scheduleIdle(3e3);
          return;
        }
        node.status(STATUS_CONNECTING);
        let ws;
        try {
          const result = await node.configNode.connect();
          ws = result.ws;
        } catch (err) {
          if (isCancelled()) {
            done();
            return;
          }
          node.status(STATUS_CONN_FAIL);
          send([null, { payload: null, status: "error", error: err.message, topic }]);
          done(err);
          scheduleIdle(3e3);
          return;
        }
        if (isCancelled()) {
          remote.disconnect(ws);
          done();
          return;
        }
        node.status(STATUS_SENDING);
        try {
          await remote.sendCommands(ws, commands);
        } catch (err) {
          remote.disconnect(ws);
          if (isCancelled()) {
            done();
            return;
          }
          node.status(STATUS_SEND_FAIL);
          send([null, { payload: null, status: "error", error: err.message, topic }]);
          done(err);
          scheduleIdle(3e3);
          return;
        }
        remote.disconnect(ws);
        if (isCancelled()) {
          done();
          return;
        }
        node.status(STATUS_VERIFYING);
        const stillUp = await remote.ping(1500);
        if (isCancelled()) {
          done();
          return;
        }
        if (!stillUp) {
          node.status(STATUS_OFFLINE_AFT);
          send([null, { payload: null, status: "offline", error: "TV unreachable after command", commands, topic }]);
          done();
          scheduleIdle(3e3);
          return;
        }
        node.status(STATUS_SENT);
        send([{ payload: true, status: "ok", commands, topic }, null]);
        done();
        scheduleIdle(2e3);
      } finally {
        if (_opId === myOpId) busy = false;
      }
    });
    node.on("close", function() {
      _opId++;
      busy = false;
      if (_resetTimer) {
        clearTimeout(_resetTimer);
        _resetTimer = null;
      }
    });
  }
  RED.nodes.registerType("samsung-tv-command", SamsungTvCommandNode);
};
