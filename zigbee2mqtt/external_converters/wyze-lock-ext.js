// Derived from JamesOsborn-SE/WLCKG1-z2m-config; see LICENSE and README.
// Targets Zigbee2MQTT 2.14.2 / zigbee-herdsman-converters 26.115.1.
const {definitions} = require('zigbee-herdsman-converters/devices/wyze');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const {logger} = require('zigbee-herdsman-converters/lib/logger');
const native = definitions.find((definition) => definition.model === 'WLCKG1');
if (!native) throw new Error('Native WLCKG1 definition not found');
const e = exposes.presets;
const NS = 'zhc:wyze-lock';
const recentDoorFrames = new Map();
const DOOR_DUPLICATE_WINDOW_MS = 2000;
const byte = (value) => Number.isInteger(value) && value >= 0 && value <= 255;

const doorEvents = {
    cluster: 64512,
    type: ['raw'],
    convert: (model, msg, publish, options = {}) => {
        const data = msg.data;
        if (!data || !Number.isInteger(data.length)) return;
        if (options.wyze_debug === true) {
            logger.info(`event device=${msg.device.ieeeAddr} length=${data.length} ` +
                `seq=${data[3]} state46=${data[46]} source57=${data[57]}`, NS);
        }
        // Only measured door events; never infer door position from bolt state.
        if (data.length !== 85 || !byte(options.source_door) || data[57] !== options.source_door) return;
        const open = byte(options.door_open) && data[46] === options.door_open;
        const closed = byte(options.door_closed) && data[46] === options.door_closed;
        if (open === closed) return;
        // The counter is shared with non-door messages and wraps. Comparing
        // sparse door counters can reject valid events indefinitely. Suppress
        // only an identical consecutive frame received within a short window.
        // This is duplicate suppression, not proof of chronological ordering.
        const id = `${msg.device.ieeeAddr}:${msg.endpoint.ID}`;
        const signature = Array.from(data).join(',');
        const now = Date.now();
        const last = recentDoorFrames.get(id);
        if (last && last.signature === signature && now >= last.receivedAt &&
            now - last.receivedAt <= DOOR_DUPLICATE_WINDOW_MS) return;
        recentDoorFrames.set(id, {signature, receivedAt: now});
        return {door_state: open ? 'open' : 'closed', contact: closed};
    },
};

const nativeLockCommands = native.toZigbee.find((converter) => converter.key.includes('state'));
if (!nativeLockCommands) throw new Error('Native lock command converter not found');
const verifiedLockCommands = {
    ...nativeLockCommands,
    convertSet: async (entity, key, value, meta) => {
        // Preserve native command validation and delivery failures. Never retry
        // movement merely because the subsequent status query failed.
        await nativeLockCommands.convertSet(entity, key, value, meta);
        try {
            const actual = await entity.read('closuresDoorLock', ['lockState']);
            // Not fully locked is not confirmation of either locked or unlocked.
            if (actual?.lockState === 1) return {state: {state: 'LOCK', lock_state: 'locked'}};
            if (actual?.lockState === 2) return {state: {state: 'UNLOCK', lock_state: 'unlocked'}};
            logger.warning('Lock command completed, but readback did not confirm locked/unlocked; displayed state may be stale', NS);
        } catch (error) {
            logger.warning(`Lock command completed, but status query failed; displayed state may be stale: ${error.message}`, NS);
        }
        // No optimistic position and no automatic command retry.
    },
};

module.exports = {
    ...native,
    description: 'Wyze Lock (native decoder + measured door events + command readback)',
    fromZigbee: [...native.fromZigbee, doorEvents],
    // Only the awaited command query is trusted; no standard report subscription.
    toZigbee: native.toZigbee.map((converter) => converter === nativeLockCommands ? verifiedLockCommands : converter),
    exposes: [
        ...native.exposes,
        e.contact(),
        exposes.enum('door_state', exposes.access.STATE, ['open', 'closed'])
            .withDescription('Last measured door-position event; may be stale after missed events'),
    ],
    options: [
        ...(native.options || []),
        exposes.binary('wyze_debug', exposes.access.SET, true, false)
            .withDescription('Log event length and candidate bytes, not full payloads'),
        ...[
            ['source_door', 'Measured door event source (byte 57)'],
            ['door_open', 'Measured door-open state (byte 46)'],
            ['door_closed', 'Measured door-closed state (byte 46)'],
        ].map(([name, description]) => exposes.numeric(name, exposes.access.SET)
            .withValueMin(0).withValueMax(255).withDescription(description)),
    ],
};
