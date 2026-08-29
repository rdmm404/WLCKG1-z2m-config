// Some logic (like isOldOrDuplicate and isStale) adapted or copied from @chanronson's fork: https://github.com/chanronson/WLCKG1-z2m-config
const fz = require("zigbee-herdsman-converters/converters/fromZigbee");
const tz = require("zigbee-herdsman-converters/converters/toZigbee");
const exposes = require("zigbee-herdsman-converters/lib/exposes");
const reporting = require("zigbee-herdsman-converters/lib/reporting");
const logger = require("zigbee-herdsman-converters/lib/logger");

// Offset Position of the event type.
const IDX_EVENT_TYPE = 57;

// Offset Position of the event state.
const IDX_STATE = 46;
const IDX_SEQ = 13; // global lifetime counter — more robust than data[3]

const _seqHighWater = new Map(); // ieeeAddr → highest data[13] seen (0–255)
const _lastEventTime = new Map();

const e = exposes.presets;

function isOldOrDuplicate(msg) {
  const incoming = msg.data[IDX_SEQ];
  const id = msg.device.ieeeAddr;
  const highWater = _seqHighWater.get(id);

  if (highWater === undefined) {
    _seqHighWater.set(id, incoming);
    // _lastEventTime intentionally not set here — markEventProcessed() will do it
    return false;
  }

  const diff = (highWater - incoming + 256) % 256;
  if (diff < 128) {
    logger.logger.debug(
      `[wyze-lock] Dropping ${diff === 0 ? 'duplicate' : 'delayed'} frame ` +
      `from ${id} (counter=${incoming}, highWater=${highWater})`
    );
    return true;
  }

  _seqHighWater.set(id, incoming);
  // _lastEventTime intentionally not set here — markEventProcessed() will do it
  return false;
}

function isStale(msg, options, eventState) {
  // Only apply staleness detection to unlock events (state=103).
  // Lock events (state=96) and door events are never the stale phantom problem.
  if (eventState !== options.lock_unlocked) return false;

  const incoming = msg.data[IDX_SEQ];
  const id = msg.device.ieeeAddr;
  const now = Date.now();
  const last = _lastEventTime.get(id);

  if (!last) return false; // no prior processed event to compare against

  const counterDelta = (incoming - last.counter + 256) % 256;
  const timeDeltaMs = now - last.timestamp;
  const timeDeltaSec = Math.floor(timeDeltaMs / 1000);

  // Safety valve: after 2 hours of idle the stale queue is long gone.
  // Treat the device as waking from rest and process the event fresh.
  // (Prevents false positives when counter wraps overnight.)
  if (timeDeltaSec > 7200) return false;

  // Each event takes ~9-10 seconds per retry cycle. Allow 60s per counter step
  // (very generous) to avoid false positives on real events a minute or two apart.
  // Require a hard minimum of 300s (5 min) to never false-positive on normal use.
  const expectedMaxSec = counterDelta * 60;
  if (timeDeltaSec > expectedMaxSec && timeDeltaSec > 300) {
    logger.logger.warning(
      `[wyze-lock] Dropping stale unlock from ${id} ` +
      `(counter=${incoming}, Δcounter=${counterDelta}, ` +
      `Δtime=${timeDeltaSec}s, expected≤${expectedMaxSec}s) — ` +
      `event queued ~${Math.round(timeDeltaSec / 60)} min ago`
    );
    return true;
  }

  return false;
}

function markEventProcessed(msg) {
  const id = msg.device.ieeeAddr;
  _lastEventTime.set(id, { counter: msg.data[IDX_SEQ], timestamp: Date.now() });
}

const fzLocal = {
  wyze_lock_event: {
    cluster: 64512,
    type: ["raw"],
    convert: async (model, msg, publish, options, meta) => {
      if (!fzLocal._clusterPatched) {
        try {
          let Zcl;
          try {
              // Try modern direct herdsman import
              const zh = require('zigbee-herdsman');
              Zcl = zh.Zcl || (zh.default && zh.default.Zcl);
              if (!Zcl) throw new Error("Not in root");
          } catch (err) {
              try {
                  // Try explicit dist path
                  Zcl = require('zigbee-herdsman/dist/zcl').Zcl || require('zigbee-herdsman/dist/zcl');
              } catch (err2) {
                  // Fallback to legacy herdsman-converters export
                  const zhc = require('zigbee-herdsman-converters');
                  Zcl = zhc.Zcl || (zhc.default && zhc.default.Zcl);
              }
          }

          if (Zcl && Zcl.Clusters && Zcl.Clusters.manuSpecificAssaDoorLock) {
            const cluster = Zcl.Clusters.manuSpecificAssaDoorLock;
            if (!cluster.commandsResponse) cluster.commandsResponse = {};

            // Only patch if not already present (idempotent)
            const hasCmd0 = Object.values(cluster.commandsResponse)
              .some(cmd => cmd.ID === 0x00);

            if (!hasCmd0) {
              cluster.commandsResponse.wyzeEvent = { ID: 0x00, parameters: [] };
              logger.logger.info(
                '[wyze-lock] Patched manuSpecificAssaDoorLock cluster: ' +
                'added wyzeEvent(0x00) to commandsResponse. ' +
                'zh will no longer throw "has no command 0" errors.'
              );
            } else {
              logger.logger.debug('[wyze-lock] Cluster already patched, skipping.');
            }
          } else {
            logger.logger.warning(
              '[wyze-lock] Could not locate Zcl.Clusters for patching. ' +
              'Retransmissions may continue.'
            );
          }
        } catch (e) {
          logger.logger.warning(
            `[wyze-lock] Cluster patch failed: ${e.message}. Retransmissions may continue.`
          );
        }
        fzLocal._clusterPatched = true;
      }
      if (msg.data.length < 70 || msg.data.length > 90) return;
      if (isOldOrDuplicate(msg)) return;

      const eventType = msg.data[IDX_EVENT_TYPE];
      const eventState = msg.data[IDX_STATE];

      if (isStale(msg, options, eventState)) return;
      markEventProcessed(msg);
      const counterStr = `counter=${msg.data[IDX_SEQ]}`;
      const result = {};

      const lock_event_types = new Set([options.source_manual,
      options.source_auto, options.source_app, options.source_app2]);

      const lock_map = {
        [options.lock_moving]: { locked: true, door: null, confirmed: false, note: 'locked, accelerometer movement' },
        [options.lock_locked]: { locked: true, door: null, confirmed: true, note: 'locked' },
        [options.lock_unlocked]: { locked: false, door: null, confirmed: true, note: 'unlocked, door position unreliable' },
        [options.lock_unlocked_open]: { locked: false, door: 'open', confirmed: true, note: 'unlocked, door open/ajar' },
        [options.lock_unlocked_unconfirmed]: { locked: false, door: null, confirmed: false, note: 'unlocked (unconfirmed state)' },
      };

      if (lock_event_types.has(eventType)) {
        const stateInfo = lock_map[eventState]
        if (!stateInfo) {
          logger.logger.warning(
            `[wyze-lock] Unknown state byte ${eventState} ` +
            `(0x${eventState.toString(16)}) at ${counterStr}, type=${eventType} — ` +
            `ignoring. Please report this value.`
          );
          return;
        }
        if (!stateInfo.confirmed) {
          logger.logger.warning(
            `[wyze-lock] Unconfirmed state byte ${eventState} at ${counterStr} — ` +
            `publishing best-guess (${stateInfo.note}).`
          );
        }
        const action = eventType === options.source_manual ? 'manual'
          : eventType === options.source_auto ? 'auto'
            : eventType === options.source_app ? 'app'
              : 'app';
        result.state = stateInfo.locked ? 'LOCK' : 'UNLOCK';
        result.lock_state = stateInfo.locked ? 'locked' : 'unlocked';
        result.action = action;
        if (stateInfo.door !== null) {
          result.door_state = stateInfo.door;
          result.contact = (stateInfo.door === 'closed');
        }
        logger.logger.debug(
          `[wyze-lock] ${result.lock_state} via ${action}` +
          `${stateInfo.door ? `, door ${stateInfo.door}` : ''} ` +
          `(${counterStr}, type=${eventType}, state=${eventState}) — ${stateInfo.note}`
        );
      }
      if (eventType === options.source_door) {
        if (eventState === options.door_closed || [options.lock_locked, options.lock_unlocked_unconfirmed].includes(eventState)) {
          result.door_state = 'closed';
          result.contact = true;
          logger.logger.debug(
            `[wyze-lock] door closed (accelerometer) (${counterStr}, state=${eventState})`
          );
        } else if (eventState === options.door_open || [options.lock_unlocked, options.lock_unlocked_open].includes(eventState)) {
          result.door_state = 'open';
          result.contact = false;
          if (eventState === options.lock_unlocked_open || eventState === options.door_open) {
            result.lock_state = 'unlocked';
          }
          logger.logger.debug(
            `[wyze-lock] door open (accelerometer) (${counterStr}, state=${eventState})`
          );
        } else if (eventState === options.lock_moving) {
          logger.logger.debug(
            `[wyze-lock] door movement while locked, no state update (${counterStr}, state=${eventState})`
          );
        } else {
          logger.logger.warning(
            `[wyze-lock] Unknown door event state byte ${eventState} ` +
            `(0x${eventState.toString(16)}) at ${counterStr} — ignoring. Please report.`
          );
          return;
        }
      }
      if (!lock_event_types.has(eventType) && eventType !== options.source_door) {
        logger.logger.warning(
          `[wyze-lock] Unknown event type ${eventType} (0x${eventType.toString(16)}) ` +
          `at ${counterStr}, state=${eventState} — ignoring. Please report.`
        );
        return;
      }
      return result;
    }
  }
};

const definition = {
  zigbeeModel: ['Ford'],
  model: 'WLCKG1',
  vendor: 'Wyze',
  description: 'Wyze Lock',
  fromZigbee: [fz.lock, fz.lock_operation_event, fzLocal.wyze_lock_event, fz.battery],
  toZigbee: [tz.lock],
  configure: async (device, coordinatorEndpoint) => {
    const endpoint = device.endpoints[0];
    await reporting.bind(endpoint, coordinatorEndpoint, [
      'closuresDoorLock',
      'genPowerCfg',
    ]);
    await reporting.lockState(endpoint);
    await reporting.batteryPercentageRemaining(endpoint);
  },
  exposes: [
    e.lock(),
    e.battery(),
    exposes
      .enum('door_state', exposes.access.STATE, ['open', 'closed'])
      .withDescription('Door position — only updated when hardware explicitly reports it'),
    e.contact(),
    exposes
      .enum('action', exposes.access.STATE, ['manual', 'auto', 'app'])
      .withDescription('Source of the last lock/unlock operation'),
  ],
  options: [
    exposes
      .numeric("source_door", exposes.access.SET)
      .withDescription("Event type value for door events")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("source_manual", exposes.access.SET)
      .withDescription("Event type value for manual lock/unlock")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("source_auto", exposes.access.SET)
      .withDescription("Event type value for auto lock")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("source_app", exposes.access.SET)
      .withDescription("Event type value for app lock/unlock")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("source_app2", exposes.access.SET)
      .withDescription("Event type value for app2 lock/unlock")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("door_open", exposes.access.SET)
      .withDescription("State value when door is open")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("door_closed", exposes.access.SET)
      .withDescription("State value when door is closed")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("lock_locked", exposes.access.SET)
      .withDescription("State value when lock is locked")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("lock_moving", exposes.access.SET)
      .withDescription("State value when lock is moving")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("lock_unlocked_open", exposes.access.SET)
      .withDescription("State value when lock is unlocked, door open/ajar")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("lock_unlocked", exposes.access.SET)
      .withDescription("State value when lock is unlocked (unconfirmed state)?")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("lock_unlocked_unreliable", exposes.access.SET)
      .withDescription("State value when lock is unlocked, door position unreliable")
      .withValueMin(0)
      .withValueMax(255),
  ],
};

module.exports = definition;
