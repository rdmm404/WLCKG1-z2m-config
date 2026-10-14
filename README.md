# WLCKG1-z2m-config

## rdmm404 fork: conservative event decoding

This fork is experimental. It preserves standard lock/unlock commands and battery
reporting, but requires measured per-lock mappings before publishing proprietary
lock or door states. Until configured, state may remain unknown or stale.

Changes from upstream:
- Fix the `lock_unlocked_unreliable` option-name mismatch.
- Do not guess door position from bolt state, or treat movement as confirmed locking.
- Ignore non-85-byte frames and missing/conflicting mappings.
- Remove speculative sequence/time filtering and global Zigbee cluster patching.
- Preserve standard lock-state/operation reporting during calibration. Those reports
  can be inaccurate; they are not sufficient evidence for enabling auto-lock.
- Add `wyze_debug` diagnostics: frame length and candidate bytes only, not full payloads.

### Install (Zigbee2MQTT 2.6.3)

Copy `zigbee2mqtt/external_converters/wyze-lock-ext.js` into the running
Zigbee2MQTT data directory's `external_converters/` folder, then restart Z2M.
It automatically loads that folder; no `external_converters:` YAML entry is needed.
The converter was registration-tested against the installed Z2M libraries.

Enable `wyze_debug` in the device options, then perform labeled manual lock/unlock
and door-open/closed transitions. Measure the source/state values before setting
any mappings. Disable diagnostics afterward. The upstream web helper below is
historical: its YAML installation instructions do not apply to this Z2M version.
Do not infer a confirmed locked bolt or closed door from an ambiguous event.

Door status is the last reported event, not a live query. Missed/delayed events
can leave it stale; automatic locking is not enabled by this converter and must
stay disabled until physical testing (including restarts and ajar positions) passes.
If bytes do not distinguish events reliably, do not enable automatic locking.

Rollback: move the converter out of `external_converters/` and restart Z2M.
No re-pairing or firmware change is needed to return to standard Z2M support.

Run decoder tests with `node --test test/converter.test.cjs`.

## Original upstream notes

Include nice to haves for getting the Wyse WLCKG1 working with zigbee2mqtt
use this external converter: [wyze-lock-ext.js](zigbee2mqtt/external_converters/wyze-lock-ext.js)

[Live Page here.](https://jamesosborn-se.github.io/WLCKG1-z2m-config/) No server needed use link or download the `index.html` and `wyze-lock-ext.js`

## Credits

- [zigbee2mqtt](https://www.zigbee2mqtt.io/)
- [gmallapp](https://github.com/gmallapp)
- [this thread](https://github.com/Koenkk/zigbee2mqtt/issues/3018)

### Disclaimer

I've tested this an use it myself but, I used generative AI to bootstrap a lot of this. I'm a lazy dev and wouldn't have made this if not for free generative AI tools.
