// ============================================================
//  Button input — debounce, edge detect and hold-repeat
//  See remote_input.h.
// ============================================================
#include "remote_input.h"

RemoteInput remoteInput;

// ------------------------------------------------------------
//  The single button table. Pin assignments come from config.h.
// ------------------------------------------------------------
void RemoteInput::begin() {
    _buttons[RBTN_FORWARD].attach(BTN_FORWARD_PIN);
    _buttons[RBTN_BACK].attach(BTN_BACK_PIN);
    _buttons[RBTN_LEFT].attach(BTN_LEFT_PIN);
    _buttons[RBTN_RIGHT].attach(BTN_RIGHT_PIN);
    _buttons[RBTN_STOP].attach(BTN_STOP_PIN);
    _buttons[RBTN_DANCE].attach(BTN_DANCE_PIN);
    _buttons[RBTN_MODE].attach(BTN_MODE_PIN);
    _buttons[RBTN_EXPR].attach(BTN_EXPR_PIN);
    _buttons[RBTN_SURPRISE].attach(BTN_SURPRISE_PIN);
}

void Button::attach(int8_t pin) {
    _pin = pin;
    if (_pin < 0) return;                 // placeholder: leave it alone

    pinMode(_pin, INPUT_PULLUP);
#if !REMOTE_ACTIVE_LOW
    pinMode(_pin, INPUT);
#endif
    // Seed the debouncer from the current level so a button that was
    // already held at boot does not fire a phantom press.
    const bool level = digitalRead(_pin);
    _raw = _stable = _down = _wasDown = (REMOTE_ACTIVE_LOW ? !level : level);
}

void Button::sample(uint32_t now) {
    if (_pin < 0) return;

    const bool level = digitalRead(_pin);
    const bool active = REMOTE_ACTIVE_LOW ? !level : level;

    if (active != _raw) {
        _raw = active;
        _lastEdgeMs = now;                // restart the settle window
        return;
    }

    // Stable only after the reading stopped bouncing for long enough.
    if (_raw != _stable && (now - _lastEdgeMs) >= REMOTE_DEBOUNCE_MS) {
        _stable = _raw;
    }

    if (_stable != _down) {
        _wasDown = _down;
        _down = _stable;
        if (_down) _pressedMs = now;
    } else {
        _wasDown = _down;
    }
}

void RemoteInput::update(uint32_t now) {
    for (uint8_t i = 0; i < RBTN_COUNT; i++) {
        _buttons[i].sample(now);
    }
}

uint8_t RemoteInput::commandFor(RemoteButtonId id) {
    switch (id) {
        case RBTN_FORWARD: return WALLE_CMD_MOVE_FORWARD;
        case RBTN_BACK:    return WALLE_CMD_MOVE_BACKWARD;
        case RBTN_LEFT:    return WALLE_CMD_TURN_LEFT;
        case RBTN_RIGHT:   return WALLE_CMD_TURN_RIGHT;
        case RBTN_STOP:    return WALLE_CMD_STOP;
        case RBTN_DANCE:   return WALLE_CMD_DANCE;
        case RBTN_EXPR:    return WALLE_CMD_EXPR_HAPPY;
        case RBTN_SURPRISE:return WALLE_CMD_EXPR_SURPRISED;
        default:           return WALLE_CMD_NONE;   // MODE is a toggle
    }
}

bool RemoteInput::anyConfigured() const {
    for (uint8_t i = 0; i < RBTN_COUNT; i++) {
        if (_buttons[i].configured()) return true;
    }
    return false;
}

uint8_t RemoteInput::missingCount() const {
    uint8_t n = 0;
    for (uint8_t i = 0; i < RBTN_COUNT; i++) {
        if (!_buttons[i].configured()) n++;
    }
    return n;
}

String RemoteInput::describe() const {
    String s;
    for (uint8_t i = 0; i < RBTN_COUNT; i++) {
        if (!_buttons[i].configured()) continue;
        if (s.length()) s += " ";
        s += String((uint8_t)_buttons[i].pin());
    }
    return s.length() ? s : String("(none)");
}

// Resolve what the wheels should be doing right now.
//
// This is deliberately a fixed priority, not "last pressed wins":
// while forward+back are both held the result must not flicker, or
// the robot would twitch. STOP is handled by the caller and always
// beats everything here.
uint8_t RemoteInput::heldDirection() const {
    // First match wins, so this is a stable, predictable order.
    if (_buttons[RBTN_FORWARD].down()) return WALLE_CMD_MOVE_FORWARD;
    if (_buttons[RBTN_BACK].down())    return WALLE_CMD_MOVE_BACKWARD;
    if (_buttons[RBTN_LEFT].down())    return WALLE_CMD_TURN_LEFT;
    if (_buttons[RBTN_RIGHT].down())   return WALLE_CMD_TURN_RIGHT;
    return WALLE_CMD_NONE;
}
