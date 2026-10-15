// Derived from JamesOsborn-SE/WLCKG1-z2m-config; see LICENSE and README.
// Targets Zigbee2MQTT 2.14.2 / zigbee-herdsman-converters 26.115.1.
const {definitions} = require('zigbee-herdsman-converters/devices/wyze');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const {logger} = require('zigbee-herdsman-converters/lib/logger');
const native = definitions.find((definition) => definition.model === 'WLCKG1');
if (!native) throw new Error('Native WLCKG1 definition not found');
const e = exposes.presets;
const NS = 'zhc:wyze-lock';
const doorSequences = new Map();
const byte = (value) => Number.isInteger(value) && value >= 0 && value <= 255;

function readState(data) {
    const states = {0: 'not_fully_locked', 1: 'locked', 2: 'unlocked'};
    if (!Object.prototype.hasOwnProperty.call(states, data?.lockState)) return;
    return {state: data.lockState === 1 ? 'LOCK' : 'UNLOCK', lock_state: states[data.lockState]};
}

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
        // Match native Wyze duplicate/out-of-order suppression, independently.
        const id = `${msg.device.ieeeAddr}:${msg.endpoint.ID}`;
        const seq = data[3];
        const last = doorSequences.get(id);
        if (last !== undefined && seq <= last && last - seq < 50) return;
        doorSequences.set(id, seq);
        return {door_state: open ? 'open' : 'closed', contact: closed};
    },
};

const requestedState = {
    cluster: 'closuresDoorLock',
    // Deliberately exclude attributeReport: upstream documents false hourly
    // "locked" reports. An explicit query is a separate, observed working path.
    type: ['readResponse'],
    convert: (model, msg) => readState(msg.data),
};

const nativeLockCommands = native.toZigbee.find((converter) => converter.key.includes('state'));
if (!nativeLockCommands) throw new Error('Native lock command converter not found');
const verifiedLockCommands = {
    ...nativeLockCommands,
    convertSet: async (entity, key, value, meta) => {
        // Native implementation validates input and awaits command success.
        // Do not publish the requested state as if it were confirmed position.
        await nativeLockCommands.convertSet(entity, key, value, meta);
        const actual = await entity.read('closuresDoorLock', ['lockState']);
        const state = readState(actual);
        if (state) return {state};
        throw new Error('Lock command completed, but state readback was unknown');
    },
};

module.exports = {
    ...native,
    description: 'Wyze Lock (native decoder + measured door events + command readback)',
    fromZigbee: [...native.fromZigbee, doorEvents, requestedState],
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
