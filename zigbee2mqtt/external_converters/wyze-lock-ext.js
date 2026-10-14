// Fork of JamesOsborn-SE/WLCKG1-z2m-config. Event mappings must be measured
// on this lock. This converter never sends lock/unlock commands automatically.
const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const {logger} = require('zigbee-herdsman-converters/lib/logger');
const e = exposes.presets;
const NS = 'zhc:wyze-lock';
const IDX_STATE = 46;
const IDX_EVENT_TYPE = 57;
const byte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;
const matches = (options, name, value) => byte(options[name]) && options[name] === value;

const wyzeEvent = {
    // Z2M 2.6.3 dispatches this registered cluster by name, not numeric ID.
    cluster: 'manuSpecificAssaDoorLock',
    type: ['raw'],
    convert: (model, msg, publish, options = {}) => {
        const data = msg.data;
        if (!data || !Number.isInteger(data.length)) return;
        if (options.wyze_debug === true) {
            // Deliberately omit the full proprietary payload: it may contain identifiers/secrets.
            logger.info(`event device=${msg.device.ieeeAddr} length=${data.length} ` +
                `state=${data[IDX_STATE]} source=${data[IDX_EVENT_TYPE]} ` +
                `seq3=${data[3]} seq13=${data[13]}`, NS);
        }
        // Only the known event frame format is decoded. Pairing/heartbeat frames
        // must not change state. No guessed stale-event filters or cluster patches.
        if (data.length !== 85) return;
        const state = data[IDX_STATE];
        const source = data[IDX_EVENT_TYPE];
        const result = {};
        if (matches(options, 'source_door', source)) {
            const open = matches(options, 'door_open', state);
            const closed = matches(options, 'door_closed', state);
            // Missing/conflicting mappings must never manufacture a closed door.
            if (open === closed) return;
            return {door_state: open ? 'open' : 'closed', contact: closed};
        }
        const sources = [
            ['source_manual', 'manual'], ['source_auto', 'auto'],
            ['source_app', 'app'], ['source_app2', 'app'],
        ].filter(([name]) => matches(options, name, source));
        if (sources.length !== 1) return;
        const locked = matches(options, 'lock_locked', state);
        const unlocked = ['lock_unlocked', 'lock_unlocked_open', 'lock_unlocked_unreliable']
            .some((name) => matches(options, name, state));
        // Movement/unconfirmed states are not treated as confirmed lock position.
        if (locked === unlocked) return;
        result.state = locked ? 'LOCK' : 'UNLOCK';
        result.lock_state = locked ? 'locked' : 'unlocked';
        result.action = sources[0][1];
        // Door position is only updated by explicitly mapped door events.
        return result;
    },
};

const mappingOptions = {
    source_door: 'Event source byte for door-position reports',
    source_manual: 'Event source byte for manual lock/unlock',
    source_auto: 'Event source byte for auto-lock',
    source_app: 'Event source byte for app lock/unlock',
    source_app2: 'Second event source byte for app lock/unlock',
    door_open: 'State byte observed for an open door',
    door_closed: 'State byte observed for a closed door',
    lock_locked: 'State byte observed for a confirmed locked bolt',
    lock_moving: 'Reserved: movement is not confirmation of a locked bolt',
    lock_unlocked_open: 'State byte observed for a confirmed unlocked bolt with door open',
    lock_unlocked: 'State byte observed for a confirmed unlocked bolt',
    lock_unlocked_unreliable: 'State byte for confirmed unlocked bolt with unreliable door position',
};

module.exports = {
    zigbeeModel: ['Ford'],
    model: 'WLCKG1',
    vendor: 'Wyze',
    description: 'Wyze Lock (experimental, measured event mappings required)',
    // Preserve standard command/status behavior during calibration. These reports
    // are not sufficient evidence for safe auto-lock; validate physical transitions.
    fromZigbee: [fz.lock, fz.lock_operation_event, fz.battery, wyzeEvent],
    toZigbee: [tz.lock],
    configure: async (device, coordinatorEndpoint) => {
        const endpoint = device.endpoints[0];
        await reporting.bind(endpoint, coordinatorEndpoint, ['closuresDoorLock', 'genPowerCfg']);
        await reporting.batteryPercentageRemaining(endpoint);
    },
    exposes: [
        e.lock(), e.battery(), e.contact(),
        exposes.enum('door_state', exposes.access.STATE, ['open', 'closed'])
            .withDescription('Last explicitly reported door position; not a live query'),
        exposes.enum('action', exposes.access.STATE, ['manual', 'auto', 'app']),
    ],
    options: [
        exposes.binary('wyze_debug', exposes.access.SET, true, false)
            .withDescription('Log event length and candidate bytes for calibration; no full payload'),
        ...Object.entries(mappingOptions).map(([name, description]) =>
            exposes.numeric(name, exposes.access.SET).withValueMin(0).withValueMax(255)
                .withDescription(description)),
    ],
};
