const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const chain = new Proxy(() => chain, {get: () => chain});
const commandCalls = [];
const nativeRaw = {cluster: 64512, type: ['raw'], convert() {}};
const nativeCommands = {key: ['state'], async convertSet(...args) {commandCalls.push(args);}, async convertGet() {}};
const native = {model: 'WLCKG1', fromZigbee: [nativeRaw], toZigbee: [nativeCommands], exposes: [], configure() {}};
const sandbox = {module: {exports: {}}, require: (name) => {
    if (name.endsWith('/devices/wyze')) return {definitions: [native]};
    if (name.endsWith('/exposes')) return {presets: chain, access: {SET: 2, STATE: 1}, enum: chain, numeric: chain, binary: chain};
    if (name.endsWith('/logger')) return {logger: {info() {}}};
    throw new Error(name);
}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../zigbee2mqtt/external_converters/wyze-lock-ext.js'), 'utf8'), sandbox);
const definition = sandbox.module.exports;
const door = definition.fromZigbee[1];
const read = definition.fromZigbee[2];
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
    assert.equal(command.convertGet, nativeCommands.convertGet);
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
test('duplicate and delayed door frames are ignored; counter wraps', () => {
    assert.ok(decode(210, 0, 250, options, 85, 'sequence'));
    assert.equal(decode(210, 3, 250, options, 85, 'sequence'), undefined);
    assert.equal(decode(210, 3, 249, options, 85, 'sequence'), undefined);
    assert.ok(decode(210, 3, 1, options, 85, 'sequence'));
});
test('only explicit status reads are subscribed, not hourly reports or command acknowledgements', () => {
    assert.deepEqual(Array.from(read.type), ['readResponse']);
    assert.deepEqual(plain(read.convert(null, {data: {lockState: 1}})), {state: 'LOCK', lock_state: 'locked'});
    assert.deepEqual(plain(read.convert(null, {data: {lockState: 2}})), {state: 'UNLOCK', lock_state: 'unlocked'});
    assert.equal(read.convert(null, {data: {lockState: 99}}), undefined);
});
test('command publishes actual readback rather than requested position', async () => {
    let queried = false;
    const result = await command.convertSet({read: async (cluster, attrs) => {
        queried = true; assert.equal(cluster, 'closuresDoorLock');
        assert.deepEqual(Array.from(attrs), ['lockState']); return {lockState: 2};
    }}, 'state', 'LOCK', {});
    assert.equal(queried, true);
    assert.equal(commandCalls.length, 1);
    assert.deepEqual(plain(result), {state: {state: 'UNLOCK', lock_state: 'unlocked'}});
});
test('read failure/unknown position never produces optimistic success', async () => {
    await assert.rejects(command.convertSet({read: async () => {throw new Error('timeout');}}, 'state', 'LOCK', {}), /timeout/);
    await assert.rejects(command.convertSet({read: async () => ({lockState: 255})}, 'state', 'LOCK', {}), /unknown/);
});
