// ============================================================
//  Button input — debounce, edge detect and hold-repeat
//  ------------------------------------------------------------
//  All the pin numbers live in config.h. This file only knows how
//  to turn physical button state into logical button state.
//
//  Low-latency model: a direction button sends its command on the
//  press edge and then keeps re-sending every REMOTE_HOLD_REPEAT_MS
//  while it is held. That refresh is what keeps the robot's
//  REMOTE_TIMEOUT_MS watchdog from firing during a long drive, and
//  it means a packet lost to interference costs 50 ms, not a stop.
// ============================================================
#pragma once

#include <Arduino.h>
#include "config.h"
#include "walle_protocol.h"

#define REMOTE_MAX_BUTTONS 9

class Button {
public:
    void attach(int8_t pin);
    bool configured() const { return _pin >= 0; }
    int8_t pin() const { return _pin; }

    // Samples the pin and updates the debounced state.
    void sample(uint32_t now);

    bool down() const { return _down; }
    bool justPressed() const { return _down && !_wasDown; }
    bool justReleased() const { return !_down && _wasDown; }
    uint32_t heldMs(uint32_t now) const { return _down ? (now - _pressedMs) : 0; }

private:
    int8_t  _pin = -1;
    bool    _raw = false;
    bool    _stable = false;
    bool    _down = false;
    bool    _wasDown = false;
    uint32_t _lastEdgeMs = 0;
    uint32_t _pressedMs = 0;
};

// Which logical button a Button is. Kept next to the pin so the
// button table and the command mapping are readable in one place.
enum RemoteButtonId {
    RBTN_FORWARD = 0,
    RBTN_BACK,
    RBTN_LEFT,
    RBTN_RIGHT,
    RBTN_STOP,
    RBTN_DANCE,
    RBTN_MODE,
    RBTN_EXPR,
    RBTN_SURPRISE,
    RBTN_COUNT
};

class RemoteInput {
public:
    void begin();

    // Samples every button. Call as often as possible.
    void update(uint32_t now);

    // The command a button press means. WALLE_CMD_NONE for buttons
    // that are momentary and handled by the caller.
    static uint8_t commandFor(RemoteButtonId id);

    bool down(RemoteButtonId id) const { return _buttons[id].down(); }
    bool justPressed(RemoteButtonId id) const { return _buttons[id].justPressed(); }
    bool justReleased(RemoteButtonId id) const { return _buttons[id].justReleased(); }
    uint32_t heldMs(RemoteButtonId id, uint32_t now) const { return _buttons[id].heldMs(now); }
    bool configured(RemoteButtonId id) const { return _buttons[id].configured(); }

    // True when at least one button has a real pin.
    bool anyConfigured() const;
    // Number of buttons still on a placeholder pin.
    uint8_t missingCount() const;
    // Human readable list of the configured pins, for the boot log.
    String describe() const;

    // The direction currently being held, or WALLE_CMD_NONE.
    // Resolves conflicts (e.g. forward + back) by a fixed order so
    // the remote never sends two contradictory directions.
    uint8_t heldDirection() const;

private:
    Button _buttons[REMOTE_MAX_BUTTONS];
};

extern RemoteInput remoteInput;
