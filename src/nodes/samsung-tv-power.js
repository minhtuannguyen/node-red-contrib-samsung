'use strict';

const { sendWol } = require('../lib/wol');

// Module-level constants — allocated once, shared across all node instances.
const POWER_STATUS_LABELS = Object.freeze({
    on:      Object.freeze({ fill: 'green',  shape: 'dot',  text: 'on' }),
    standby: Object.freeze({ fill: 'yellow', shape: 'ring', text: 'standby' }),
    booting: Object.freeze({ fill: 'blue',   shape: 'ring', text: 'booting' }),
    offline: Object.freeze({ fill: 'red',    shape: 'ring', text: 'offline' }),
});

// Valid msg.payload values — one Set for all instances.
const VALID_INTENTS = new Set(['on', 'off', 'toggle', 'status']);

// wantedStates arrays for pollForState — reused across all calls.
const WANT_ON      = Object.freeze(['on']);
const WANT_OFF     = Object.freeze(['standby', 'offline']);

// Pre-frozen sendPowerKey result singletons for common paths.
const RESULT_OK           = Object.freeze({ success: true,  wentOffline: false });
const RESULT_WENT_OFFLINE = Object.freeze({ success: true,  wentOffline: true  });

// Status objects shared across all instances — never mutated after creation.
const STATUS_IDLE         = Object.freeze({ fill: 'grey',   shape: 'ring', text: 'idle' });
const STATUS_CHECKING     = Object.freeze({ fill: 'yellow', shape: 'ring', text: 'checking…' });
const STATUS_POWERING_ON  = Object.freeze({ fill: 'yellow', shape: 'ring', text: 'powering on…' });
const STATUS_POWERING_OFF = Object.freeze({ fill: 'yellow', shape: 'ring', text: 'powering off…' });
const STATUS_WAITING_ON   = Object.freeze({ fill: 'yellow', shape: 'ring', text: 'waiting for on…' });
const STATUS_WAITING_OFF  = Object.freeze({ fill: 'yellow', shape: 'ring', text: 'waiting for off…' });
const STATUS_TIMEOUT      = Object.freeze({ fill: 'red',    shape: 'ring', text: 'timeout' });
const STATUS_NO_CFG       = Object.freeze({ fill: 'red',    shape: 'ring', text: 'no TV configured' });
const STATUS_WOL_FAILED   = Object.freeze({ fill: 'red',    shape: 'dot',  text: 'WoL failed' });
const STATUS_WOL_SENT     = Object.freeze({ fill: 'blue',   shape: 'ring', text: 'WoL sent' });
const STATUS_ERROR        = Object.freeze({ fill: 'red',    shape: 'dot',  text: 'error' });
const STATUS_WOL_WAITING  = Object.freeze({ fill: 'blue',   shape: 'ring', text: 'waiting…' });

// Pure utility — no closure needed, defined once at module level.
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = function (RED) {
    function SamsungTvPowerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.configNode          = RED.nodes.getNode(config.tv);
        node.defaultAction       = config.defaultAction || 'toggle';
        // Default 12 retries: Samsung cold boot from mains power takes 60–90 s.
        // 12 × 8 s = 96 s polling window; covers even slow models with margin.
        node.wakeRetries         = Math.max(0, parseInt(config.wakeRetries, 10) || 12);
        node.wakeRetryIntervalMs = Math.max(1000, (parseFloat(config.wakeRetryInterval) || 8) * 1000);
        // Pre-compute once — same value for every message on this node instance.
        // Formula: retries × (intervalMs + 3 500) + 65 000
        //   Per waitForTvReady retry: delay(intervalMs) + ping(1 500) + getInfo(2 000) ≈ intervalMs + 3 500 ms.
        // Overhead beyond waitForTvReady:
        //   sendPowerKey ×3  = 3 × (connect 4 000 + sendKey 3 000 + delay 900 + gap 3 000) ≈ 33 000 ms
        //   pollForState     = 10 × (3 000 delay + 3 500 getPowerState) ≈ 65 000 ms
        //   Total non-retry overhead ≈ 65 000 ms safety margin.
        node._overallTimeoutMs   = (node.wakeRetries * (node.wakeRetryIntervalMs + 3500)) + 65000;

        if (!node.configNode) {
            node.status(STATUS_NO_CFG);
            return;
        }

        node.status(STATUS_IDLE);

        // Cache remote once — it's stable for the lifetime of this node instance.
        const remote = node.configNode.remote;

        // -----------------------------------------------------------------
        // Concurrency + cancellation state
        //
        // `busy`         – prevents a second operation from starting while one
        //                  is in progress.
        // `_currentOpId` – generation counter for cancellation checks.
        // `_overallTimer`– per-operation safety timeout handle.
        // -----------------------------------------------------------------
        let busy          = false;
        let _currentOpId  = 0;
        let _overallTimer = null;

        // Pre-built mutable status object for retry progress updates.
        // fill/shape never change; only text does. Reusing avoids one allocation
        // per retry iteration.
        const _retryStatus = { fill: 'yellow', shape: 'ring', text: '' };
        // Pre-compute the constant suffix, e.g. '/12…'.
        const _retrySuffix  = '/' + node.wakeRetries + '\u2026';

        // Pre-build the send shim once (Node-RED < 1.0 compatibility).
        const _sendShim = function () { node.send.apply(node, arguments); };

        // Verbose debug logger — only emits when enableLogging is on in the config node.
        // node.warn() calls are never gated; they are real operational warnings.
        const log = (msg) => { if (node.configNode.enableLogging) node.log(msg); };

        // Status auto-reset timer — clears transient statuses (e.g. STATUS_NO_POWER)
        // so the node doesn't show a stale error state indefinitely.
        let _statusTimer = null;

        function scheduleIdle(ms) {
            if (_statusTimer) clearTimeout(_statusTimer);
            _statusTimer = setTimeout(() => { _statusTimer = null; node.status(STATUS_IDLE); }, ms);
        }

        // ------------------------------------------------------------------ //
        // Helpers
        // ------------------------------------------------------------------ //

        /**
         * Get current TV power state. Never throws.
         * Returns: 'on' | 'standby' | 'booting' | 'offline'
         */
        async function getPowerState() {
            const reachable = await remote.ping(1500);
            if (!reachable) {
                log('[samsung-power] ping → unreachable (offline)');
                return 'offline';
            }

            const info = await remote.getInfo();
            if (!info) {
                log('[samsung-power] ping → reachable, getInfo → no HTTP response (booting)');
                return 'booting';
            }

            log('[samsung-power] ping → reachable, getInfo.PowerState → ' +
                (info.rawPowerState === undefined ? 'FIELD ABSENT' : JSON.stringify(info.rawPowerState)) +
                ' → state: ' + (info.powerState === null ? 'booting' : info.powerState === 'standby' ? 'standby' : 'on')
            );

            if (info.powerState === null) return 'booting';
            if (info.powerState === 'standby') return 'standby';
            return 'on';
        }

        /**
         * Accurate power state for use at the start of every command.
         *
         * getPowerState() returns 'booting' whenever the NIC is reachable but
         * the PowerState REST field is absent.  This happens on Samsung models
         * that never populate that field — both when the TV is fully on AND when
         * it is genuinely cold-booting.  A WebSocket probe is the only way to
         * tell them apart:
         *
         *   WS connects → TV is ON (remote-control channel open).
         *                 Models that go dark in eco-standby have NIC off in
         *                 that state, so 'booting' + WS-open ≡ TV on.
         *   WS fails    → TV is still cold-booting (firmware not ready).
         *
         * For all other raw states ('on', 'standby', 'offline') the probe is
         * skipped — no extra cost on TVs with a working PowerState field.
         *
         * @returns {'on'|'standby'|'booting'|'offline'}
         */
        async function getActualPowerState() {
            const raw = await getPowerState();
            if (raw !== 'booting') return raw;

            try {
                const { ws } = await node.configNode.connect();
                remote.disconnect(ws);
                log('[samsung-power] getActualPowerState: WS probe succeeded — TV is on (no PowerState field)');
                return 'on';
            } catch (_) {
                log('[samsung-power] getActualPowerState: WS probe failed — TV is genuinely cold-booting');
                return 'booting';
            }
        }

        /**
         * Poll until TV reaches one of wantedStates, or maxAttempts exhausted.
         * Special handling: if polling for 'on' and state is 'booting', try WS
         * as fallback — some models never populate PowerState but WS works.
         * @returns {string} last observed state
         */
        async function pollForState(wantedStates, intervalMs, maxAttempts, isCancelled) {
            const wantOn = wantedStates.includes('on');
            let lastState = 'offline';
            for (let i = 0; i < maxAttempts; i++) {
                await delay(intervalMs);
                if (isCancelled()) return lastState;
                lastState = await getPowerState();
                if (isCancelled()) return lastState;
                if (wantedStates.includes(lastState)) return lastState;

                // PowerState absent but polling for 'on' — try WebSocket as fallback.
                if (wantOn && lastState === 'booting') {
                    // Pre-check cancellation — connect() blocks for up to 4 s; skip
                    // the attempt entirely if we're already cancelled.
                    if (isCancelled()) return lastState;
                    try {
                        const { ws } = await node.configNode.connect();
                        remote.disconnect(ws);
                        if (isCancelled()) return lastState;
                        return 'on'; // WS confirmed display is active
                    } catch (_) {
                        if (isCancelled()) return lastState;
                        // WS failed — still booting, continue polling
                    }
                }
            }
            return lastState;
        }

        /**
         * Wait until TV REST API reports a settled power state.
         *
         * Re-sends WoL only when state is 'offline' — 'booting' means the NIC
         * is already up (TV has power), so WoL is pointless.
         *
         * For Samsung models that never populate the PowerState field the REST
         * response always looks like 'booting' even when the TV is in standby.
         * In that case we fall back to a WebSocket probe: if the WS remote-control
         * channel opens, the TV is ready for KEY_POWER — return 'standby'.
         * If WS fails the TV is still initialising — keep polling.
         *
         * This also handles Samsung's two-phase boot quirk where the NIC briefly
         * comes up ('booting'), goes dark again ('offline'), then fully comes up
         * ('booting' again). On the second 'booting' the WS is ready.
         *
         * @returns {'standby'|'on'|'offline'}
         */
        async function waitForTvReady(retries, intervalMs, mac, isCancelled) {
            log('[samsung-power] waitForTvReady: ' + retries + ' retries × ' + intervalMs + 'ms');
            for (let attempt = 1; attempt <= retries; attempt++) {
                if (isCancelled()) return 'offline';

                _retryStatus.text = 'waiting for TV \u2014 ' + attempt + _retrySuffix;
                node.status(_retryStatus);

                await delay(intervalMs);
                if (isCancelled()) return 'offline';

                const state = await getPowerState();
                log('[samsung-power] waitForTvReady attempt ' + attempt + '/' + retries + ': state=' + state);
                if (isCancelled()) return 'offline';

                // 'standby' or 'on' = firmware settled, PowerState field present.
                if (state === 'standby' || state === 'on') {
                    log('[samsung-power] waitForTvReady: TV ready, state=' + state);
                    return state;
                }

                // 'booting' = TCP port reachable but PowerState field absent.
                //
                // Distinguishing genuine cold-boot from standby-without-PowerState
                // via REST is impossible on models that never report PowerState.
                // WebSocket is the discriminator:
                //   WS connects → remote-control channel open → TV is ready.
                //                 Return 'standby' so KEY_POWER is sent.
                //   WS fails    → firmware not ready yet → keep polling.
                if (state === 'booting') {
                    try {
                        const { ws } = await node.configNode.connect();
                        remote.disconnect(ws);
                        if (isCancelled()) return 'offline';
                        log('[samsung-power] waitForTvReady: WS connected with PowerState absent — ' +
                            'model does not report PowerState; assuming standby, will send KEY_POWER');
                        return 'standby';
                    } catch (_) {
                        if (isCancelled()) return 'offline';
                        // WS failed → still genuinely booting, continue polling
                        log('[samsung-power] waitForTvReady attempt ' + attempt + ': WS probe failed — still booting');
                    }
                }

                // Only re-send WoL when truly offline — 'booting' means NIC is
                // already up so WoL is pointless.
                if (mac && attempt < retries && state === 'offline') {
                    try { await sendWol(mac); } catch (_) { /* best-effort */ }
                    if (isCancelled()) return 'offline';
                }
            }
            log('[samsung-power] waitForTvReady: exhausted all retries, returning offline');
            return 'offline';
        }
        /**
         * Connect to the TV and send KEY_POWER.
         * If WS fails and TV is now unreachable → TV powered off (success).
         * If WS fails and TV is still reachable → genuine error.
         * @returns {{ success: boolean, wentOffline: boolean, error?: Error }}
         */
        async function sendPowerKey() {
            try {
                const { ws } = await node.configNode.connect();
                try {
                    await remote.sendKey(ws, 'KEY_POWER');
                    // Samsung firmware needs ~900 ms of open-socket time after
                    // the key is sent before the connection closes.
                    await delay(900);
                } finally {
                    remote.disconnect(ws);
                }
                return RESULT_OK;
            } catch (err) {
                const stillUp = await remote.ping(1000);
                if (!stillUp) return RESULT_WENT_OFFLINE;
                return { success: false, wentOffline: false, error: err };
            }
        }

        // ------------------------------------------------------------------ //
        // Input handler
        // ------------------------------------------------------------------ //

        node.on('input', async function (msg, send, done) {
            send = send || _sendShim;
            // Fallback for Node-RED < 1.0 (no done passed).
            if (!done) {
                const _origMsg = msg;
                done = function (err) { if (err) node.error(err, _origMsg); };
            }

            // Extract only the fields we need from msg NOW, before any await.
            // This allows the msg object itself to be GC'd by Node-RED.
            const topic = msg.topic;

            // Cancel any pending status auto-reset before starting a real operation.
            if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = null; }

            // --- Concurrency guard ---
            // Messages arriving while an operation is running get immediate
            // rejection to output 2; Node-RED stays responsive for other flows.
            if (busy) {
                node.warn('samsung-tv-power: operation already in progress, ignoring message');
                send([null, { payload: null, status: 'busy', error: 'operation in progress', topic }]);
                done();
                return;
            }
            busy = true;

            // Capture generation for this operation.
            const opId = ++_currentOpId;
            const isCancelled = () => _currentOpId !== opId;

            // Safety timeout — value pre-computed at node init.
            let timedOut = false;
            _overallTimer = setTimeout(() => {
                timedOut = true;
                _currentOpId++;
                busy = false;
                _overallTimer = null;
                node.status(STATUS_TIMEOUT);
                send([null, { payload: null, status: 'error', error: 'timeout', topic }]);
                done(new Error('Power node timed out after ' + node._overallTimeoutMs + 'ms'));
            }, node._overallTimeoutMs);

            // finish() — must be called on EVERY exit path.
            const finish = (fn) => {
                if (timedOut) return;           // timeout already sent + called done()
                if (isCancelled()) {            // node was closed mid-operation
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

            // --- Resolve intent ---
            let intent = msg.payload;
            // Valid numeric intents: 0 (off) and 1 (on) only.
            // Timestamps, HomeKit Active values, etc. fall back to defaultAction.
            const isValid = intent === true || intent === false ||
                intent === 0 || intent === 1 ||
                (typeof intent === 'string' && VALID_INTENTS.has(intent));
            if (!isValid) intent = node.defaultAction;
            msg = null; // eslint-disable-line no-param-reassign

            // --- Read current state ---
            // getActualPowerState() resolves the ambiguous 'booting' state
            // (NIC up, PowerState field absent) via a WS probe before any
            // action is taken, so wantOn and alreadyDone are always accurate.
            node.status(STATUS_CHECKING);
            log('[samsung-power] reading initial state, intent=' + intent);
            const currentState = await getActualPowerState();
            log('[samsung-power] initial state=' + currentState + ', intent=' + intent);
            if (isCancelled()) { finish(() => done()); return; }

            // --- Status query — no action ---
            if (intent === 'status') {
                node.status(POWER_STATUS_LABELS[currentState]);
                finish(() => {
                    send([{ payload: currentState === 'on', state: currentState, topic }, null]);
                    done();
                });
                return;
            }

            // --- Resolve wantOn ---
            // State semantics:
            //   'offline' = hard-off (no power)   → "off" to the user
            //   'booting' = cold-booting           → "off" to the user (NIC up, display dark)
            //   'standby' = soft-off               → "off" to the user
            //   'on'      = active                 → "on"  to the user
            let wantOn;
            if (intent === true || intent === 'on' || intent === 1) {
                wantOn = true;
            } else if (intent === false || intent === 'off' || intent === 0) {
                wantOn = false;
            } else { // 'toggle'
                wantOn = currentState !== 'on';
            }

            // --- Already in the desired state? ---
            // By this point currentState is accurate: getActualPowerState() has
            // already resolved 'booting' via WS probe, so 'booting' here means
            // the TV is genuinely cold-booting (WS failed) — effectively off.
            const alreadyDone = wantOn
                ? currentState === 'on'
                : currentState === 'standby' || currentState === 'offline' || currentState === 'booting';

            if (alreadyDone) {
                node.status(POWER_STATUS_LABELS[currentState]);
                finish(() => {
                    send([{ payload: currentState === 'on', state: currentState, topic }, null]);
                    done();
                });
                return;
            }

            node.status(wantOn ? STATUS_POWERING_ON : STATUS_POWERING_OFF);

            // =================== POWER ON ===================
            if (wantOn) {

                if (currentState === 'offline' || currentState === 'booting') {
                    const mac = node.configNode.mac;
                    let wolSent = false;

                    // Only send WoL when the TV is fully offline (NIC dark).
                    // 'booting' means the NIC is already up — WoL is pointless.
                    if (currentState === 'offline') {
                        if (!mac) {
                            node.warn('samsung-tv-power: no MAC configured — will wait for TV to appear on network (no Wake-on-LAN)');
                        } else {
                            try {
                                await sendWol(mac);
                                wolSent = true;
                            } catch (err) {
                                node.status(STATUS_WOL_FAILED);
                                finish(() => {
                                    send([null, { payload: null, status: 'error', error: 'WoL failed: ' + err.message, topic }]);
                                    done(err);
                                });
                                return;
                            }
                            if (isCancelled()) { finish(() => done()); return; }
                        }
                    }

                    if (node.wakeRetries === 0) {
                        // Fire-and-forget mode — don't wait for TV to boot.
                        node.status(wolSent ? STATUS_WOL_SENT : STATUS_WOL_WAITING);
                        finish(() => {
                            send([{ payload: true, state: 'booting', status: wolSent ? 'wol-sent' : 'waiting', topic }, null]);
                            done();
                        });
                        return;
                    }

                    // Wait until the TV's REST API + WS confirm it is ready.
                    // 'booting' here means getActualPowerState() already ran the WS
                    // probe and it failed — the TV is genuinely cold-booting.
                    // waitForTvReady will retry until WS opens (or retries exhausted).
                    const readyState = await waitForTvReady(
                        node.wakeRetries,
                        node.wakeRetryIntervalMs,
                        mac || null,
                        isCancelled
                    );

                    if (isCancelled()) { finish(() => done()); return; }

                    if (readyState === 'offline') {
                        node.status(POWER_STATUS_LABELS.offline);
                        finish(() => {
                            send([null, {
                                payload: null, status: 'error',
                                error: `TV did not become ready after ${node.wakeRetries} retries`,
                                topic,
                            }]);
                            done();
                        });
                        return;
                    }

                    if (readyState === 'on') {
                        // TV firmware set to power-on-after-power-loss — no KEY_POWER needed.
                        node.status(POWER_STATUS_LABELS.on);
                        finish(() => {
                            send([{ payload: true, state: 'on', topic }, null]);
                            done();
                        });
                        return;
                    }

                    // readyState === 'standby' — TV is ready, fall through to KEY_POWER.
                    node.status(STATUS_POWERING_ON);
                }

                // currentState was 'standby' at arrival,
                // OR TV just cold-booted to 'standby' and fell through.
                // Retry KEY_POWER up to 3 times — WS may need a moment to open.
                let result;
                for (let keyAttempt = 0; keyAttempt < 3; keyAttempt++) {
                    result = await sendPowerKey();
                    if (isCancelled()) { finish(() => done()); return; }
                    if (result.success || result.wentOffline) break;
                    node.status({ fill: 'yellow', shape: 'ring', text: 'KEY_POWER retry ' + (keyAttempt + 1) + '/3\u2026' });
                    await delay(3000);
                    if (isCancelled()) { finish(() => done()); return; }
                }

                if (!result.success) {
                    const recheckState = await getPowerState();
                    if (isCancelled()) { finish(() => done()); return; }
                    node.status(POWER_STATUS_LABELS[recheckState] || POWER_STATUS_LABELS.offline);
                    finish(() => {
                        send([null, { payload: null, status: 'error', error: result.error ? result.error.message : 'send failed', state: recheckState, topic }]);
                        done(result.error || undefined);
                    });
                    return;
                }

                if (result.wentOffline) {
                    node.status(POWER_STATUS_LABELS.offline);
                    finish(() => {
                        send([null, { payload: null, status: 'error', error: 'TV went offline unexpectedly during power-on', state: 'offline', topic }]);
                        done();
                    });
                    return;
                }

                // KEY_POWER sent. Poll until REST confirms 'on' (3–15 s typical).
                node.status(STATUS_WAITING_ON);
                const verifiedState = await pollForState(WANT_ON, 3000, 10, isCancelled);
                if (isCancelled()) { finish(() => done()); return; }

                if (verifiedState === 'on') {
                    node.status(POWER_STATUS_LABELS.on);
                    finish(() => {
                        send([{ payload: true, state: 'on', topic }, null]);
                        done();
                    });
                } else {
                    node.status(POWER_STATUS_LABELS[verifiedState] || POWER_STATUS_LABELS.offline);
                    finish(() => {
                        send([null, { payload: null, state: verifiedState, status: 'error', error: 'TV did not turn on in time', topic }]);
                        done();
                    });
                }

            // =================== POWER OFF ===================
            } else {
                // currentState is 'on', or 'booting' where the WS probe above confirmed
                // the TV is on (models that never populate the PowerState REST field).
                const result = await sendPowerKey();
                if (isCancelled()) { finish(() => done()); return; }

                if (!result.success) {
                    node.status(STATUS_ERROR);
                    finish(() => {
                        send([null, { payload: null, status: 'error', error: result.error ? result.error.message : 'send failed', topic }]);
                        done(result.error || undefined);
                    });
                    return;
                }

                if (result.wentOffline) {
                    // TV hard-powered off during connect — valid "off".
                    node.status(POWER_STATUS_LABELS.offline);
                    finish(() => {
                        send([{ payload: false, state: 'offline', topic }, null]);
                        done();
                    });
                    return;
                }

                // KEY_POWER sent — poll for standby/offline (usually 2–4 s).
                node.status(STATUS_WAITING_OFF);
                let verifiedState = await pollForState(WANT_OFF, 2000, 10, isCancelled);
                if (isCancelled()) { finish(() => done()); return; }

                // On models without a PowerState REST field the TV may stay NIC-up
                // while its display turns off (normal standby, not eco-standby).
                // pollForState sees 'booting' the whole time and never matches
                // WANT_OFF.  A final WS probe resolves the ambiguity:
                //   WS fails    → remote-control channel closed → TV is off.
                //   WS connects → TV is still on, KEY_POWER was not accepted.
                if (verifiedState === 'booting') {
                    try {
                        const { ws } = await node.configNode.connect();
                        remote.disconnect(ws);
                        log('[samsung-power] power-off verify: WS probe connected — TV still on');
                        // verifiedState stays 'booting' → error path below
                    } catch (_) {
                        log('[samsung-power] power-off verify: WS probe failed — TV is off (no PowerState field)');
                        verifiedState = 'standby'; // remote-control down = effectively off
                    }
                    if (isCancelled()) { finish(() => done()); return; }
                }

                node.status(POWER_STATUS_LABELS[verifiedState] || POWER_STATUS_LABELS.standby);
                finish(() => {
                    if (verifiedState === 'standby' || verifiedState === 'offline') {
                        // standby or offline — both are "off" to the caller
                        send([{ payload: false, state: verifiedState, topic }, null]);
                    } else {
                        // 'on' or 'booting' (WS still open) — KEY_POWER not accepted
                        send([null, { payload: null, state: verifiedState, status: 'error', error: 'TV did not turn off in time', topic }]);
                    }
                    done();
                });
            }
        });

        node.on('close', function () {
            // Invalidate any in-flight operation.
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

    RED.nodes.registerType('samsung-tv-power', SamsungTvPowerNode);
};
