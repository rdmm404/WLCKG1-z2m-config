const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const chain = new Proxy(() => chain, {get: () => chain});
const sandbox = {module: {exports: {}}, require: (name) => {
    if (name.endsWith('/exposes')) return {presets: chain, access: {SET: 2, STATE: 1}, enum: chain, numeric: chain, binary: chain};
    if (name.endsWith('/logger')) return {logger: {info() {}}};
    return {};
}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../zigbee2mqtt/external_converters/wyze-lock-ext.js'), 'utf8'), sandbox);
const convert = sandbox.module.exports.fromZigbee[1].convert;
const options = {source_door: 10, source_manual: 11, door_open: 1, door_closed: 2, lock_locked: 3, lock_unlocked: 4};
function decode(source, state, opts = options, length = 85) {
    const data = Buffer.alloc(length);
    data[46] = state; data[57] = source;
    const result = convert(null, {data, device: {ieeeAddr: 'test'}}, null, opts);
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
}
test('unconfigured events do not publish guessed states', () => {
    assert.equal(decode(0, 0, {}), undefined);
    assert.equal(decode(10, 2, {source_door: 10}), undefined);
});
test('door transitions are explicit and independent of bolt state', () => {
    assert.deepEqual(decode(10, 1), {door_state: 'open', contact: false});
    assert.deepEqual(decode(10, 2), {door_state: 'closed', contact: true});
    assert.equal(decode(10, 3), undefined);
});
test('lock transitions do not invent door position', () => {
    assert.deepEqual(decode(11, 3), {state: 'LOCK', lock_state: 'locked', action: 'manual'});
    assert.deepEqual(decode(11, 4), {state: 'UNLOCK', lock_state: 'unlocked', action: 'manual'});
    assert.equal(decode(11, 5), undefined);
});
test('heartbeat, short frames and unknown sources are ignored', () => {
    assert.equal(decode(10, 2, options, 123), undefined);
    assert.equal(decode(10, 2, options, 60), undefined);
    assert.equal(decode(99, 2), undefined);
});
test('ambiguous or invalid mappings do not publish', () => {
    assert.equal(decode(10, 2, {...options, door_open: 2}), undefined);
    assert.equal(decode(11, 3, {...options, lock_unlocked: 3}), undefined);
    assert.equal(decode(11, 3, {...options, source_auto: 11}), undefined);
    assert.equal(decode(10, 2, {...options, door_closed: '2'}), undefined);
});
test('upstream unreliable-unlocked option uses the declared name', () => {
    assert.equal(decode(11, 5, {...options, lock_unlocked_unreliable: 5}).state, 'UNLOCK');
});
