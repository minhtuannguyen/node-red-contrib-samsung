'use strict';

const net = require('net');
const http = require('http');
const WebSocket = require('ws');

const WS_PORT = 8002;
const WS_PORT_LEGACY = 8001;
const HTTP_PORT = 8001;
const INFO_PATH = '/api/v2/';
const REMOTE_PATH = '/api/v2/channels/samsung.remote.control';
const APP_PATH = '/api/v2/applications/';

const CONNECT_TIMEOUT_MS = 3000;
const SEND_KEY_TIMEOUT_MS = 3000;
const POST_CONNECT_DELAY_MS = 1000;
const POST_SEND_DELAY_MS = 500;

// Pure utility — allocated once at module level, shared across all instances.
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class SamsungRemote {
    /**
     * @param {object} options
     * @param {string} options.ip   - TV IP address
     * @param {string} options.name - Client name shown on TV pairing dialog
     */
    constructor(options) {
        this.ip = options.ip;
        this.name = options.name || 'NodeRED';
        this._ws = null;
        // Pre-compute the stable WebSocket URL parts.
        // Buffer.from().toString('base64') and template literal assembly happen
        // once here instead of on every connect() call.
        const encodedName = Buffer.from(this.name).toString('base64');
        const basePath = REMOTE_PATH + '?name=' + encodedName;
        this._wsUrlLegacy = 'ws://' + this.ip + ':' + WS_PORT_LEGACY + basePath;
        this._wsUrlBase   = 'wss://' + this.ip + ':' + WS_PORT + basePath;
    }

    // ------------------------------------------------------------------ //
    // Reachability
    // ------------------------------------------------------------------ //

    /**
     * TCP-connect to port 8001.  Resolves true/false, never rejects.
     * @param {number} [timeout=1000]
     * @returns {Promise<boolean>}
     */
    ping(timeout = 1000) {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            let resolved = false;

            const done = (result) => {
                if (!resolved) {
                    resolved = true;
                    socket.destroy();
                    resolve(result);
                }
            };

            socket.setTimeout(timeout);
            socket.once('connect', () => done(true));
            socket.once('timeout', () => done(false));
            socket.once('error', () => done(false));
            socket.connect(HTTP_PORT, this.ip);
        });
    }

    // ------------------------------------------------------------------ //
    // TV info via REST
    // ------------------------------------------------------------------ //

    /**
     * Fetch TV info from the local REST API.
     * Returns null on any error (TV off / unreachable).
     * @returns {Promise<{powerState:string, tokenAuthSupport:boolean, frameTv:boolean}|null>}
     */
    getInfo() {
        return new Promise((resolve) => {
            const url = 'http://' + this.ip + ':' + HTTP_PORT + INFO_PATH;
            const req = http.get(url, { timeout: 2000 }, (res) => {
                // Suppress 'error' emitted on the response stream when req.destroy()
                // fires mid-response (e.g. on timeout). Without this handler Node.js
                // would throw an unhandled 'error' event.
                res.on('error', () => {});
                const chunks = [];
                res.on('data', (chunk) => { chunks.push(chunk); });
                res.on('end', () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        const device = body.device || {};
                        // IMPORTANT: do NOT default to 'on' when PowerState is absent.
                        // During cold boot, REST responds but PowerState field is missing
                        // until firmware fully initialises. null = boot phase (not settled).
                        const rawPowerState = device.PowerState;
                        resolve({
                            powerState: rawPowerState ? rawPowerState.toLowerCase() : null,
                            rawPowerState: rawPowerState,          // original value for logging
                            tokenAuthSupport: device.TokenAuthSupport === 'true' || device.TokenAuthSupport === true,
                            frameTv: device.FrameTVSupport === 'true' || device.FrameTVSupport === true,
                        });
                    } catch (_) {
                        resolve(null);
                    }
                });
            });
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.on('error', () => resolve(null));
        });
    }

    // ------------------------------------------------------------------ //
    // App control via REST
    // ------------------------------------------------------------------ //

    /**
     * Launch an app by its Samsung app ID.
     * @param {string} appId
     * @returns {Promise<boolean>}
     */
    launchApp(appId) {
        return new Promise((resolve) => {
            const options = {
                hostname: this.ip,
                port: HTTP_PORT,
                path: `${APP_PATH}${encodeURIComponent(appId)}`,
                method: 'POST',
                timeout: 5000,
            };
            const req = http.request(options, (res) => {
                res.resume();
                resolve(res.statusCode >= 200 && res.statusCode < 300);
            });
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.on('error', () => resolve(false));
            req.end();
        });
    }

    // ------------------------------------------------------------------ //
    // WebSocket connection
    // ------------------------------------------------------------------ //

    /**
     * Open a WebSocket connection to the TV.
     * Resolves once the channel is confirmed open.
     * Rejects with an error if the connection fails within CONNECT_TIMEOUT_MS.
     *
     * @param {string|null} token  - Stored pairing token (null for first pairing)
     * @param {boolean} [useLegacy=false] - Use WS port 8001 instead of WSS 8002
     * @returns {Promise<{ws: WebSocket, token: string|null}>}
     */
    connect(token = null, useLegacy = false) {
        return new Promise((resolve, reject) => {
            // Use pre-computed URL bases — no Buffer.from/base64/template work per call.
            let url;
            if (useLegacy) {
                url = this._wsUrlLegacy;
            } else {
                url = token ? this._wsUrlBase + '&token=' + encodeURIComponent(token) : this._wsUrlBase;
            }

            const ws = new WebSocket(url, {
                rejectUnauthorized: false,
            });

            let settled = false;
            let resolvedToken = token;

            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    ws.terminate();
                    reject(new Error('WebSocket connection timed out'));
                }
            }, CONNECT_TIMEOUT_MS);

            ws.on('message', (data) => {
                let msg;
                try { msg = JSON.parse(data); } catch (_) { return; }

                if (msg.event === 'ms.channel.connect') {
                    // Extract token from TV response (present on first pairing or renewal)
                    const newToken = msg.data && msg.data.token;
                    if (newToken) {
                        resolvedToken = String(newToken);
                    }
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        this._ws = ws;
                        // Wait for TV to be ready to accept commands.
                        // During this delay the WS could still close (TV abort).
                        // Track it with a flag so we reject instead of resolving
                        // with a dead socket.
                        let closedDuringDelay = false;
                        const onEarlyClose = () => { closedDuringDelay = true; };
                        ws.once('close', onEarlyClose);
                        setTimeout(() => {
                            ws.removeListener('close', onEarlyClose);
                            if (closedDuringDelay) {
                                if (this._ws === ws) this._ws = null;
                                reject(new Error('WebSocket closed during post-connect delay'));
                            } else {
                                resolve({ ws, token: resolvedToken });
                            }
                        }, POST_CONNECT_DELAY_MS);
                    }
                } else if (msg.event === 'ms.channel.unauthorized') {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        ws.terminate();
                        reject(new Error('TV denied pairing — accept the dialog on the TV remote'));
                    }
                }
            });

            ws.once('error', (err) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(err);
                }
            });

            ws.once('close', () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error('WebSocket closed before channel was confirmed'));
                }
                if (this._ws === ws) {
                    this._ws = null;
                }
            });
        });
    }

    // ------------------------------------------------------------------ //
    // Key commands
    // ------------------------------------------------------------------ //

    /**
     * Send a remote key via an already-open WebSocket.
     *
     * @param {WebSocket} ws
     * @param {string} key    - e.g. "KEY_MUTE"
     * @param {number} [holdMs=0] - Duration to hold (0 = click)
     * @returns {Promise<void>}
     */
    async sendKey(ws, key, holdMs = 0) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not open');
        }
        if (!key || typeof key !== 'string') {
            throw new Error(`Invalid key: "${key}". Must be a non-empty string like "KEY_MUTE"`);
        }

        // Inner closure captures ws+key once per sendKey call.
        // Rewriting sendKey as async eliminates the outer Promise executor
        // closure and the execute() IIFE that the previous implementation used.
        const sendFrame = (action) => new Promise((resolve, reject) => {
            const payload = JSON.stringify({
                method: 'ms.remote.control',
                params: {
                    Cmd: action,
                    DataOfCmd: key,
                    Option: 'false',
                    TypeOfRemote: 'SendRemoteKey',
                },
            });
            ws.send(payload, (err) => { if (err) reject(err); else resolve(); });
        });

        let timerId;
        // For a hold sequence the budget must cover Press + holdMs delay + Release.
        // A flat SEND_KEY_TIMEOUT_MS would expire mid-hold for any holdMs > ~2 900 ms.
        const totalTimeoutMs = holdMs > 0
            ? holdMs + SEND_KEY_TIMEOUT_MS * 2
            : SEND_KEY_TIMEOUT_MS;
        const timeoutP = new Promise((_, reject) => {
            timerId = setTimeout(() => reject(new Error('sendKey timed out')), totalTimeoutMs);
        });

        try {
            if (holdMs > 0) {
                await Promise.race([sendFrame('Press'), timeoutP]);
                await delay(holdMs);
                await Promise.race([sendFrame('Release'), timeoutP]);
            } else {
                await Promise.race([sendFrame('Click'), timeoutP]);
            }
        } finally {
            clearTimeout(timerId);
        }
    }

    /**
     * Send a sequence of key commands in order.
     *
     * Each item is either:
     *   - a string: "KEY_MUTE"
     *   - an object: { key, hold, repeat, delay }
     *     - hold (ms): press-and-hold duration
     *     - repeat: number of times to send the key
     *     - delay (ms): pause after this key before next (default 400ms)
     *
     * @param {WebSocket} ws
     * @param {string|object|Array<string|object>} commands
     * @returns {Promise<void>}
     */
    async sendCommands(ws, commands) {
        const list = Array.isArray(commands) ? commands : [commands];

        for (const item of list) {
            // Rename destructured `delay` to `itemDelay` to avoid shadowing the
            // module-level delay() utility used for the post-send pause.
            const { key, hold = 0, repeat = 1, delay: itemDelay = 400 } =
                typeof item === 'string' ? { key: item } : item;

            for (let i = 0; i < repeat; i++) {
                await this.sendKey(ws, key, hold);
                if (i < repeat - 1) {
                    await delay(itemDelay);
                }
            }

            await delay(itemDelay);
        }

        // Give the TV time to process the last command before the caller closes the socket
        await delay(POST_SEND_DELAY_MS);
    }

    // ------------------------------------------------------------------ //
    // Disconnect
    // ------------------------------------------------------------------ //

    /**
     * Gracefully close the WebSocket connection if open.
     * @param {WebSocket} [ws] - specific ws instance; falls back to this._ws
     */
    disconnect(ws) {
        const target = ws || this._ws;
        if (target && target.readyState === WebSocket.OPEN) {
            target.close();
        }
        if (target === this._ws) {
            this._ws = null;
        }
    }
}

module.exports = SamsungRemote;
