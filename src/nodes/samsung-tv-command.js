'use strict';

// Module-level status constants — allocated once, shared across all node instances.
const STATUS_IDLE        = Object.freeze({ fill: 'grey',   shape: 'ring', text: 'idle' });
const STATUS_NO_CFG      = Object.freeze({ fill: 'red',    shape: 'ring', text: 'no TV configured' });
const STATUS_PAIRING     = Object.freeze({ fill: 'yellow', shape: 'ring', text: 'pairing…' });
const STATUS_PAIRED      = Object.freeze({ fill: 'green',  shape: 'dot',  text: 'paired — token saved' });
const STATUS_PAIR_FAIL   = Object.freeze({ fill: 'red',    shape: 'dot',  text: 'pairing failed' });
const STATUS_PINGING     = Object.freeze({ fill: 'yellow', shape: 'ring', text: 'pinging…' });
const STATUS_OFFLINE     = Object.freeze({ fill: 'red',    shape: 'dot',  text: 'TV offline' });
const STATUS_LAUNCHING   = Object.freeze({ fill: 'yellow', shape: 'ring', text: 'launching app…' });
const STATUS_LAUNCHED    = Object.freeze({ fill: 'green',  shape: 'dot',  text: 'app launched' });
const STATUS_LAUNCH_FAIL = Object.freeze({ fill: 'red',    shape: 'dot',  text: 'launch failed' });
const STATUS_CONNECTING  = Object.freeze({ fill: 'yellow', shape: 'ring', text: 'connecting…' });
const STATUS_CONN_FAIL   = Object.freeze({ fill: 'red',    shape: 'dot',  text: 'connect failed' });
const STATUS_SENDING     = Object.freeze({ fill: 'yellow', shape: 'ring', text: 'sending…' });
const STATUS_SEND_FAIL   = Object.freeze({ fill: 'red',    shape: 'dot',  text: 'send failed' });
const STATUS_VERIFYING   = Object.freeze({ fill: 'yellow', shape: 'ring', text: 'verifying…' });
const STATUS_OFFLINE_AFT = Object.freeze({ fill: 'red',    shape: 'dot',  text: 'offline after send' });
const STATUS_SENT        = Object.freeze({ fill: 'green',  shape: 'dot',  text: 'sent' });

module.exports = function (RED) {
    function SamsungTvCommandNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.configNode = RED.nodes.getNode(config.tv);
        node.mode       = config.mode || 'key';
        node.defaultKey = config.defaultKey || '';
        node.appId      = config.appId || '';

        if (!node.configNode) {
            node.status(STATUS_NO_CFG);
            return;
        }

        node.status(STATUS_IDLE);

        // Cache remote reference — stable for the node instance lifetime.
        const remote = node.configNode.remote;

        // Pre-build send shim once — avoids one closure allocation per message.
        const _sendShim = function () { node.send.apply(node, arguments); };

        // -----------------------------------------------------------------
        // Concurrency + cancellation state
        //
        // `busy`  — prevents a second operation from starting while one is
        //            in progress; messages arriving while busy are rejected
        //            to output 2 immediately.
        // `_opId` — generation counter; incremented on close so any in-flight
        //            async callbacks can detect the node is dead and bail
        //            without calling status/send/done on a stale instance.
        // -----------------------------------------------------------------
        let busy  = false;
        let _opId = 0;

        // Idle-reset timer — clears transient statuses after a delay so the
        // node doesn't show a stale error/success state indefinitely.
        let _resetTimer = null;

        function scheduleIdle(ms) {
            if (_resetTimer) clearTimeout(_resetTimer);
            _resetTimer = setTimeout(() => { _resetTimer = null; node.status(STATUS_IDLE); }, ms);
        }

        node.on('input', async function (msg, send, done) {
            send = send || _sendShim;
            // Fallback for Node-RED < 1.0 (no done passed). Capture msg NOW into
            // _origMsg so the shim can pass it to node.error() — the msg variable
            // is nulled later for GC. On modern NR this branch never executes.
            if (!done) {
                const _origMsg = msg;
                done = function (err) { if (err) node.error(err, _origMsg); };
            }

            // Extract the fields we need NOW — release msg so Node-RED can GC it
            // freely across async awaits (which can take several seconds each).
            const topic = msg.topic;

            // Cancel any pending status auto-reset before starting a real operation.
            if (_resetTimer) { clearTimeout(_resetTimer); _resetTimer = null; }

            // --- Concurrency guard ---
            // Messages arriving while an operation is running get immediate
            // rejection to output 2; Node-RED stays responsive for other flows.
            if (busy) {
                node.warn('samsung-tv-command: operation already in progress, ignoring message');
                send([null, { payload: null, status: 'busy', error: 'operation in progress', topic }]);
                done();
                return;
            }
            busy = true;
            const myOpId = ++_opId;
            const isCancelled = () => _opId !== myOpId;

            // try/finally guarantees busy is always reset on every exit path,
            // including unhandled rejections from the async body.
            try {
                // ----------------------------------------------------------------
                // PAIR mode — just connect to trigger the TV pairing dialog
                // ----------------------------------------------------------------
                if (node.mode === 'pair') {
                    msg = null; // eslint-disable-line no-param-reassign
                    node.status(STATUS_PAIRING);
                    try {
                        const result = await node.configNode.connect();
                        // Disconnect the probe WS; we only needed the token.
                        // Do this before isCancelled check so we never leak the socket.
                        remote.disconnect(result.ws);
                        if (isCancelled()) { done(); return; }
                        node.status(STATUS_PAIRED);
                        send([{ payload: true, status: 'paired', token: result.token, topic }, null]);
                        done();
                    } catch (err) {
                        if (isCancelled()) { done(); return; }
                        node.status(STATUS_PAIR_FAIL);
                        send([null, { payload: null, status: 'error', error: err.message, topic }]);
                        done(err);
                    }
                    scheduleIdle(3000);
                    return;
                }

                // ----------------------------------------------------------------
                // APP mode — launch an app via REST
                // ----------------------------------------------------------------
                if (node.mode === 'app') {
                    // Extract appId from msg before nulling msg.
                    const appId = (msg.payload && typeof msg.payload === 'string') ? msg.payload : node.appId;
                    msg = null; // eslint-disable-line no-param-reassign
                    if (!appId) {
                        done(new Error('No App ID provided in msg.payload and none configured in the node'));
                        return;
                    }

                    node.status(STATUS_PINGING);
                    const reachable = await remote.ping(1500);
                    if (isCancelled()) { done(); return; }
                    if (!reachable) {
                        node.status(STATUS_OFFLINE);
                        send([null, { payload: null, status: 'offline', topic }]);
                        done();
                        scheduleIdle(3000);
                        return;
                    }

                    node.status(STATUS_LAUNCHING);
                    const ok = await remote.launchApp(appId);
                    if (isCancelled()) { done(); return; }
                    if (ok) {
                        node.status(STATUS_LAUNCHED);
                        send([{ payload: true, status: 'ok', appId, topic }, null]);
                        done();
                        scheduleIdle(2000);
                    } else {
                        node.status(STATUS_LAUNCH_FAIL);
                        send([null, { payload: null, status: 'error', error: 'App launch returned failure', appId, topic }]);
                        done();
                        scheduleIdle(3000);
                    }
                    return;
                }

                // ----------------------------------------------------------------
                // KEY mode (default) — always send the key configured in the node editor.
                // msg.payload is intentionally ignored in this mode.
                // ----------------------------------------------------------------
                const commands = node.defaultKey;
                msg = null; // eslint-disable-line no-param-reassign
                if (!commands) {
                    done(new Error('No key configured — open the node editor and select a key'));
                    return;
                }

                // -- 1. Ping --
                node.status(STATUS_PINGING);
                const reachable = await remote.ping(1500);
                if (isCancelled()) { done(); return; }
                if (!reachable) {
                    node.status(STATUS_OFFLINE);
                    send([null, { payload: null, status: 'offline', topic }]);
                    done();
                    scheduleIdle(3000);
                    return;
                }

                // -- 2. Connect --
                node.status(STATUS_CONNECTING);
                let ws;
                try {
                    const result = await node.configNode.connect();
                    ws = result.ws;
                } catch (err) {
                    if (isCancelled()) { done(); return; }
                    node.status(STATUS_CONN_FAIL);
                    send([null, { payload: null, status: 'error', error: err.message, topic }]);
                    done(err);
                    scheduleIdle(3000);
                    return;
                }
                // Disconnect the socket if cancelled before we even start sending.
                if (isCancelled()) { remote.disconnect(ws); done(); return; }

                // -- 3. Send command(s) --
                node.status(STATUS_SENDING);
                try {
                    await remote.sendCommands(ws, commands);
                } catch (err) {
                    remote.disconnect(ws);
                    if (isCancelled()) { done(); return; }
                    node.status(STATUS_SEND_FAIL);
                    send([null, { payload: null, status: 'error', error: err.message, topic }]);
                    done(err);
                    scheduleIdle(3000);
                    return;
                }

                remote.disconnect(ws);
                if (isCancelled()) { done(); return; }

                // -- 4. Verify TV is still reachable after command --
                node.status(STATUS_VERIFYING);
                const stillUp = await remote.ping(1500);
                if (isCancelled()) { done(); return; }
                if (!stillUp) {
                    node.status(STATUS_OFFLINE_AFT);
                    send([null, { payload: null, status: 'offline', error: 'TV unreachable after command', commands, topic }]);
                    done();
                    scheduleIdle(3000);
                    return;
                }

                node.status(STATUS_SENT);
                send([{ payload: true, status: 'ok', commands, topic }, null]);
                done();
                scheduleIdle(2000);

            } finally {
                // Reset busy only for this operation's generation — if close fired
                // (_opId incremented), leave busy=false as the close handler set it.
                if (_opId === myOpId) busy = false;
            }
        });

        node.on('close', function () {
            // Invalidate any in-flight operation — isCancelled() returns true for
            // anything still awaiting after this point.
            _opId++;
            busy = false;
            if (_resetTimer) {
                clearTimeout(_resetTimer);
                _resetTimer = null;
            }
        });
    }

    RED.nodes.registerType('samsung-tv-command', SamsungTvCommandNode);
};
