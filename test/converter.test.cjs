const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const chain = new Proxy(() => chain, {get: () => chain});
const commandCalls = [];
const warnings = [];
let now = 10000;
const nativeRaw = {cluster: 64512, type: ['raw'], convert() {}};
const nativeCommands = {key: ['state'], async convertSet(...args) {commandCalls.push(args);}, async convertGet() {}};
const native = {model: 'WLCKG1', fromZigbee: [nativeRaw], toZigbee: [nativeCommands], exposes: [], configure() {}};
const sandbox = {Date: {now: () => now}, module: {exports: {}}, require: (name) => {
    if (name.endsWith('/devices/wyze')) return {definitions: [native]};
    if (name.endsWith('/exposes')) return {presets: chain, access: {SET: 2, STATE: 1}, enum: chain, numeric: chain, binary: chain};
    if (name.endsWith('/logger')) return {logger: {info() {}, warning(message) {warnings.push(message);}}};
    throw new Error(name);
}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../zigbee2mqtt/external_converters/wyze-lock-ext.js'), 'utf8'), sandbox);
const definition = sandbox.module.exports;
const door = definition.fromZigbee[1];
const command = definition.toZigbee[0];
const options = {source_door: 210, door_open: 0, door_closed: 3};
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function decode(source, state, seq, opts = options, length = 85, id = 'door-test') {
    const data = Buffer.alloc(length);
    data[3] = seq; data[46] = state; data[57] = source;
    return plain(door.convert(null, {data, device: {ieeeAddr: id}, endpoint: {ID: 1}}, null, opts));
}
test('inherits native lock decoding, configuration and get without modification', () => {
    assert.equal(definition.fromZigbee[0], nativeRaw);
    assert.equal(definition.configure, native.configure);
    assert.equal(command.key, nativeCommands.key);
    assert.equal(command.convertGet, nativeCommands.convertGet);
    assert.equal(definition.fromZigbee.length, native.fromZigbee.length + 1);
    assert.equal(door.cluster, 64512);
});
test('measured open and closed events do not invent bolt status', () => {
    assert.deepEqual(decode(210, 0, 76), {door_state: 'open', contact: false});
    assert.deepEqual(decode(210, 3, 77), {door_state: 'closed', contact: true});
});
test('missing, conflicting and unknown mappings are ignored', () => {
    assert.equal(decode(210, 0, 80, {}), undefined);
    assert.equal(decode(210, 0, 80, {...options, door_closed: 0}), undefined);
    assert.equal(decode(210, 0, 80, {...options, door_open: '0'}), undefined);
    assert.equal(decode(210, 19, 80), undefined);
});
test('manual operations and heartbeat frames do not change door position', () => {
    assert.equal(decode(40, 19, 80), undefined);
    assert.equal(decode(210, 3, 80, options, 123), undefined);
    assert.equal(decode(210, 3, 80, options, 60), undefined);
});
test('sparse door events cannot be rejected as stale after shared counter wraps', () => {
    assert.ok(decode(210, 3, 120, options, 85, 'sparse'));
    // Other messages consume counter values. The next door event may have any
    // counter, including a slightly lower number or the same number.
    assert.deepEqual(decode(210, 0, 90, options, 85, 'sparse'), {door_state: 'open', contact: false});
    assert.deepEqual(decode(210, 3, 91, options, 85, 'sparse'), {door_state: 'closed', contact: true});
    assert.ok(decode(210, 0, 91, options, 85, 'sparse'));
    assert.ok(decode(210, 3, 255, options, 85, 'sparse'));
    assert.ok(decode(210, 0, 0, options, 85, 'sparse'));
});
test('only identical consecutive frames within two seconds are suppressed', () => {
    assert.ok(decode(210, 0, 89, options, 85, 'duplicates'));
    now += 1000;
    assert.equal(decode(210, 0, 89, options, 85, 'duplicates'), undefined);
    now += 1001;
    assert.ok(decode(210, 0, 89, options, 85, 'duplicates'));
    assert.ok(decode(210, 3, 89, options, 85, 'duplicates'));
    assert.ok(decode(210, 0, 89, options, 85, 'duplicates'));
    assert.ok(decode(210, 0, 89, options, 85, 'another-device'));
});
test('no additional standard lock response/report subscriptions', () => {
    assert.deepEqual(Array.from(door.type), ['raw']);
    assert.equal(definition.fromZigbee[0], nativeRaw);
    assert.equal(definition.fromZigbee.length, 2);
});
test('command delegates to native then publishes actual readback, not requested state', async () => {
    const before = commandCalls.length;
    let reads = 0;
    const entity = {read: async (cluster, attrs) => {
        reads++;
        assert.equal(commandCalls.length, before + 1);
        assert.equal(cluster, 'closuresDoorLock');
        assert.deepEqual(Array.from(attrs), ['lockState']);
        return {lockState: 2};
    }};
    const meta = {};
    assert.deepEqual(plain(await command.convertSet(entity, 'state', 'LOCK', meta)),
        {state: {state: 'UNLOCK', lock_state: 'unlocked'}});
    assert.equal(reads, 1);
    assert.deepEqual(commandCalls[before], [entity, 'state', 'LOCK', meta]);
    assert.deepEqual(plain(await command.convertSet({read: async () => ({lockState: 1})}, 'state', 'LOCK', {})),
        {state: {state: 'LOCK', lock_state: 'locked'}});
});
test('read failure or ambiguous state warns without failing or retrying movement', async () => {
    for (const read of [async () => {throw Error('timeout');}, ...[0, 255, undefined].map(lockState => async () => ({lockState}))]) {
        const before = commandCalls.length;
        const warned = warnings.length;
        assert.equal(await command.convertSet({read}, 'state', 'LOCK', {}), undefined);
        assert.equal(commandCalls.length, before + 1);
        assert.equal(warnings.length, warned + 1);
    }
});
test('native delivery failure propagates without a read or retry', async () => {
    const original = nativeCommands.convertSet;
    let calls = 0;
    nativeCommands.convertSet = async () => {calls++; throw Error('NWK_NO_ROUTE');};
    try {
        await assert.rejects(command.convertSet({read: async () => assert.fail('must not read after failed command')}, 'state', 'LOCK', {}), /NWK_NO_ROUTE/);
        assert.equal(calls, 1);
    } finally {
        nativeCommands.convertSet = original;
    }
});
