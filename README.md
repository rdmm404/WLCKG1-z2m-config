# Wyze WLCKG1: native Z2M support plus door reporting

Fork of [JamesOsborn-SE/WLCKG1-z2m-config](https://github.com/JamesOsborn-SE/WLCKG1-z2m-config).
The upstream project identified the candidate event bytes and supplied the log
analyzer. This fork now extends the installed native Wyze definition rather than
maintaining a separate lock decoder. See LICENSE and Git history for provenance.

## Target and behavior

Targets **Zigbee2MQTT 2.14.2 / zigbee-herdsman-converters 26.115.1**.

- Reuses the native WLCKG1 definition, battery handling, configuration and raw
  lock-state decoder, including its duplicate/out-of-order filtering.
- Adds door position from measured 85-byte proprietary frames: source at byte 57,
  state at byte 46. Does not infer door position from bolt position.
- Door decoding suppresses only identical consecutive frames within two seconds.
  It does not infer event order from the wrapping counter shared by all messages.
- Delegates commands to native Z2M, then queries lockState once after completion.
  Publishes only a confirmed locked/unlocked readback, never the requested state.
- A failed/ambiguous readback logs a warning without claiming movement failed or
  retrying it. Native command failures still propagate. No standard report or
  read-response subscriptions are added, preserving false-hourly-report filtering.
- Adds a contact sensor and `door_state`. Does not issue automatic lock commands.
- Optional `wyze_debug` logs length and selected bytes, never the full payload.

## Measured device options

For the currently tested lock/pairing, two labeled open/close cycles matched:

```yaml
source_door: 210
door_open: 0
door_closed: 3
```

These are **per-device options**, not global settings. They are not hardcoded defaults.
Manual events measured source 40 and state 19/20, but this fork does not need those
mappings: it reuses the native decoder's byte-80 lock-state interpretation.
Other units, firmware or a new pairing may need different door mappings.

## Install

1. Copy `zigbee2mqtt/external_converters/wyze-lock-ext.js` into the running
   Z2M data directory's `external_converters/` folder.
2. Enable `advanced.enable_external_js` if necessary (external code is gated in
   newer Z2M versions). Restart only Z2M.
3. Set the measured door options through the device's settings or the
   `bridge/request/device/options` MQTT API.
4. Verify command readback, door transitions and native manual reporting/control.

No firmware change, gateway, cloud integration or re-pairing is required.
A Z2M update may change the imported native API: retest before upgrading.

Rollback: move the converter outside the auto-loaded extensions and restart Z2M.
This returns to native support, including its limitations for this unit's
Z2M-command status responses and lack of a door sensor.

## Validation and limitations

The decoder has local tests (`node --test test/converter.test.cjs`) and should be
registration-tested against the installed dependencies before deployment. Tests
with mocks do not prove real-world reliability. Physical command, thumb-turn,
open/closed/ajar, delayed-event and restart tests are required before automations.

Door position is **the last reported event**, not a live query. It may be stale
if an event is missed, including while Z2M is offline. Door frames are accepted
in arrival order; a delayed frame can still temporarily publish an old position.
The native bolt decoder's sequence heuristic is unchanged. Physical testing of
resets, delayed messages and command-readback accuracy is still required.
A successful command or read does not prove the door is physically secured.
Keep automatic locking disabled during validation.

## Historical log analyzer

`index.html` is the original static, browser-side analyzer:
[upstream live page](https://jamesosborn-se.github.io/WLCKG1-z2m-config/).
It lets a human label source/state bytes and generate mappings. Its old YAML
registration instructions and cluster-name log filter do not match current Z2M;
new logs may use numeric cluster `64512`. It has not yet been updated in this fork.
