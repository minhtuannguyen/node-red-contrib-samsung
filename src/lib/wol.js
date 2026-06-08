'use strict';

const wol = require('wol');

/**
 * Send a Wake-on-LAN magic packet to a MAC address.
 *
 * @param {string} mac  - MAC address in any common format (xx:xx:xx:xx:xx:xx, xx-xx-xx-xx-xx-xx)
 * @param {object} [options]
 * @param {string} [options.address='255.255.255.255'] - Broadcast address
 * @param {number} [options.port=9]                   - UDP port (standard WoL port is 9)
 * @returns {Promise<void>}
 */
function sendWol(mac, options = {}) {
    return new Promise((resolve, reject) => {
        const wolOptions = {
            address: options.address || '255.255.255.255',
            port: options.port || 9,
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

module.exports = { sendWol };
