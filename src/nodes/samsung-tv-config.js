'use strict';

const fs = require('fs');
const path = require('path');
const SamsungRemote = require('../lib/samsung-remote');

// ------------------------------------------------------------------
// Module-level token cache
//
// `_tokensFilePath` — computed once on first access (RED.settings is
//   available by then); avoids rebuilding the path string on every call.
// `_tokensCache`   — in-memory copy of samsung-tv-tokens.json; loaded
//   from disk at most once per process lifetime.  All reads go to this
//   object (O(1), zero I/O).  All writes update it in-place and then
//   flush to disk asynchronously so the Node-RED event loop is never
//   blocked by a synchronous writeFileSync.
// ------------------------------------------------------------------
let _tokensFilePath = null;
let _tokensCache    = null; // null = not yet loaded from disk

module.exports = function (RED) {

    // ------------------------------------------------------------------
    // Token persistence helpers
    // ------------------------------------------------------------------

    function getFilePath() {
        if (!_tokensFilePath) {
            _tokensFilePath = path.join(RED.settings.userDir, 'samsung-tv-tokens.json');
        }
        return _tokensFilePath;
    }

    function getCache() {
        if (_tokensCache === null) {
            try {
                const raw = fs.readFileSync(getFilePath(), 'utf8');
                _tokensCache = JSON.parse(raw);
            } catch (_) {
                _tokensCache = {};
            }
        }
        return _tokensCache;
    }

    function saveToken(nodeId, token) {
        const tokens = getCache();
        tokens[nodeId] = token;
        // Async write — never blocks the Node-RED event loop.
        fs.writeFile(getFilePath(), JSON.stringify(tokens, null, 2), 'utf8', (err) => {
            if (err) RED.log.warn('[samsung-tv-config] Could not save token: ' + err.message);
        });
    }

    function readToken(nodeId) {
        return getCache()[nodeId] || null;
    }

    function deleteToken(nodeId) {
        const tokens = getCache();
        delete tokens[nodeId];
        fs.writeFile(getFilePath(), JSON.stringify(tokens, null, 2), 'utf8', (err) => {
            if (err) RED.log.warn('[samsung-tv-config] Could not delete token: ' + err.message);
        });
    }

    // ------------------------------------------------------------------

    function SamsungTvConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.ip            = config.ip;
        node.tvName        = config.tvName || 'NodeRED';
        node.useLegacy     = config.useLegacy === true;
        node.enableLogging = config.enableLogging === true;

        // MAC from credentials (editor field)
        node.mac = node.credentials.mac || '';

        // Token: prefer the persisted file token (updated at runtime after pairing)
        // over the credentials token (set manually in editor).
        node.token = readToken(node.id) || node.credentials.token || null;

        node.remote = new SamsungRemote({
            ip:   node.ip,
            name: node.tvName,
        });

        /**
         * Open a WebSocket to the TV and resolve with {ws, token}.
         * If a new token is received from the TV (first pairing or renewal)
         * it is persisted immediately to samsung-tv-tokens.json.
         *
         * @returns {Promise<{ws: import('ws'), token: string|null}>}
         */
        node.connect = async function () {
            const result = await node.remote.connect(node.token, node.useLegacy);

            if (result.token && result.token !== node.token) {
                node.token = result.token;
                saveToken(node.id, node.token);
                if (node.enableLogging) {
                    RED.log.info('[samsung-tv-config] Token saved for node ' + node.id);
                }
            }

            return result;
        };

        node.on('close', function (removed, done) {
            if (removed) {
                deleteToken(node.id);
            }
            // Wrap in try/finally so done() is guaranteed even if disconnect() throws.
            try {
                node.remote.disconnect();
            } finally {
                done();
            }
        });
    }

    RED.nodes.registerType('samsung-tv-config', SamsungTvConfigNode, {
        credentials: {
            mac:   { type: 'text' },
            token: { type: 'text' },
        },
    });
};
