// ============================================================
//  WALL-E shared control protocol
//  ------------------------------------------------------------
//  ONE source of truth for the command/status vocabulary used by
//  every WALL-E controller (the ESP32-WROOM remote today, and any
//  other remote / bridge later) and by the ESP32-S3 robot.
//
//  This header is deliberately LOGIC-FREE: constants and a fixed
//  size POD packet only. It is included by both PlatformIO
//  projects through build_flags, so the two firmwares can never
//  disagree about a command id, yet no code is ever shared between
//  them (each project still compiles only its own src/).
//
//  Wire format: 10 bytes, little endian, no padding.
//  Transport:   ESP-NOW (see robot_s3/src/remote_link.cpp).
// ============================================================
#pragma once

#include <stdint.h>

#define WALLE_PROTO_MAGIC        0xA5
#define WALLE_PROTO_VERSION      0x01
#define WALLE_PROTO_PACKET_SIZE  10

// ------------------------------------------------------------
//  Message types
// ------------------------------------------------------------
enum WalleMsgType : uint8_t {
    WALLE_MSG_COMMAND = 0x01,   // controller -> robot
    WALLE_MSG_STATUS  = 0x02,   // robot -> controller
};

// ------------------------------------------------------------
//  Commands (controller -> robot).
//
//  The robot owns ALL behaviour. A controller only ever names an
//  intent; it never sends motor speeds, durations or expressions
//  as raw values. That is what lets a second remote, the phone
//  app or a web page reuse this exact list unchanged.
// ------------------------------------------------------------
enum WalleCommand : uint8_t {
    WALLE_CMD_NONE = 0x00,

    // ---- locomotion (held buttons keep these alive) ----
    WALLE_CMD_MOVE_FORWARD  = 0x01,
    WALLE_CMD_MOVE_BACKWARD = 0x02,
    WALLE_CMD_TURN_LEFT     = 0x03,
    WALLE_CMD_TURN_RIGHT    = 0x04,
    WALLE_CMD_ROTATE_LEFT   = 0x05,
    WALLE_CMD_ROTATE_RIGHT  = 0x06,

    // ---- the single "everything off" command ----
    // Highest priority from every source. Never ignored.
    WALLE_CMD_STOP          = 0x07,

    // ---- modes ----
    WALLE_CMD_DANCE         = 0x10,
    WALLE_CMD_EXPLORE       = 0x11,
    WALLE_CMD_IDLE          = 0x12,
    WALLE_CMD_AUTONOMOUS_ON = 0x13,
    WALLE_CMD_AUTONOMOUS_OFF= 0x14,

    // ---- expressions ----
    WALLE_CMD_EXPR_HAPPY     = 0x20,
    WALLE_CMD_EXPR_THINKING  = 0x21,
    WALLE_CMD_EXPR_SURPRISED = 0x22,
    WALLE_CMD_EXPR_CONFUSED  = 0x23,
    WALLE_CMD_EXPR_IDLE      = 0x24,

    // ---- link housekeeping ----
    WALLE_CMD_HELLO = 0x30,   // "remote is powered on, who is out there?"
    WALLE_CMD_PING  = 0x31,   // keepalive, also refreshes the safety timer
    WALLE_CMD_BYE   = 0x32,   // clean shutdown, robot stops immediately

    WALLE_CMD_MAX
};

// Is this a command that drives the wheels? These are the ones
// that put the robot into REMOTE_MANUAL and that the timeout
// watchdog is allowed to stop.
static inline bool walle_cmd_is_motion(uint8_t c) {
    return c >= WALLE_CMD_MOVE_FORWARD && c <= WALLE_CMD_ROTATE_RIGHT;
}

static inline const char* walle_command_name(uint8_t c) {
    switch (c) {
        case WALLE_CMD_MOVE_FORWARD:  return "move_forward";
        case WALLE_CMD_MOVE_BACKWARD: return "move_backward";
        case WALLE_CMD_TURN_LEFT:     return "turn_left";
        case WALLE_CMD_TURN_RIGHT:    return "turn_right";
        case WALLE_CMD_ROTATE_LEFT:   return "rotate_left";
        case WALLE_CMD_ROTATE_RIGHT:  return "rotate_right";
        case WALLE_CMD_STOP:          return "stop";
        case WALLE_CMD_DANCE:         return "dance";
        case WALLE_CMD_EXPLORE:       return "explore";
        case WALLE_CMD_IDLE:           return "idle";
        case WALLE_CMD_AUTONOMOUS_ON: return "autonomous_on";
        case WALLE_CMD_AUTONOMOUS_OFF:return "autonomous_off";
        case WALLE_CMD_EXPR_HAPPY:     return "expression_happy";
        case WALLE_CMD_EXPR_THINKING:  return "expression_thinking";
        case WALLE_CMD_EXPR_SURPRISED: return "expression_surprised";
        case WALLE_CMD_EXPR_CONFUSED:  return "expression_confused";
        case WALLE_CMD_EXPR_IDLE:      return "expression_idle";
        case WALLE_CMD_HELLO:          return "hello";
        case WALLE_CMD_PING:           return "ping";
        case WALLE_CMD_BYE:            return "bye";
        default:                       return "?";
    }
}

// ------------------------------------------------------------
//  Status messages (robot -> controller).
//  Small and event driven: the robot NEVER sends a status stream,
//  it only answers a command, a state change or a ping.
// ------------------------------------------------------------
enum WalleStatus : uint8_t {
    WALLE_ST_NONE = 0x00,
    WALLE_ST_WELCOME = 0x80,   // robot saw a HELLO; arg = robot state
    WALLE_ST_ACK,              // command executed, cmd = what ran
    WALLE_ST_ERROR,            // arg = WalleError
    WALLE_ST_ROBOT_STATE,      // arg = RobotState
    WALLE_ST_REMOTE_STATE,     // arg = WalleRemoteState
    WALLE_ST_BATTERY,          // arg = millivolts, 0 = unknown/no sensor
    WALLE_ST_PONG,             // reply to PING, arg = robot state
};

enum WalleError : uint8_t {
    WALLE_ERR_NONE = 0,
    WALLE_ERR_BAD_PACKET,      // magic/version/len wrong
    WALLE_ERR_UNKNOWN_CMD,     // not in WalleCommand
    WALLE_ERR_NOT_CONFIGURED,  // e.g. motors have no pins
    WALLE_ERR_BUSY,            // another source owns the motors
};

// Mirrors RemoteLinkState in robot_s3/src/remote_link.h so the
// remote can render it without including robot firmware.
enum WalleRemoteState : uint8_t {
    WALLE_REMOTE_DISCONNECTED = 0,
    WALLE_REMOTE_CONNECTING   = 1,
    WALLE_REMOTE_CONNECTED    = 2,
    WALLE_REMOTE_TIMEOUT      = 3,
};

static inline const char* walle_remote_state_name(uint8_t s) {
    switch (s) {
        case WALLE_REMOTE_DISCONNECTED: return "DISCONNECTED";
        case WALLE_REMOTE_CONNECTING:   return "CONNECTING";
        case WALLE_REMOTE_CONNECTED:    return "CONNECTED";
        case WALLE_REMOTE_TIMEOUT:      return "TIMEOUT";
        default:                        return "?";
    }
}

// ------------------------------------------------------------
//  Packet flags
// ------------------------------------------------------------
#define WALLE_FLAG_HELD  0x01   // button is physically down (vs. a tap)

// ------------------------------------------------------------
//  The packet
// ------------------------------------------------------------
//  Wire layout (10 bytes, little endian):
//    [0] magic    0xA5
//    [1] version  0x01
//    [2] type     WalleMsgType
//    [3] cmd      WalleCommand / WalleStatus
//    [4] value    small argument (speed bucket, state, error, ...)
//    [5] seq      rolling counter, wraps at 255
//    [6] flags    WALLE_FLAG_*
//    [7] reserved 0
//    [8..9] arg   uint16 LE, optional (e.g. millivolts)
struct WallePacket {
    uint8_t  magic;
    uint8_t  version;
    uint8_t  type;
    uint8_t  cmd;
    uint8_t  value;
    uint8_t  seq;
    uint8_t  flags;
    uint8_t  reserved;
    uint16_t arg;
};

static_assert(sizeof(WallePacket) == WALLE_PROTO_PACKET_SIZE,
              "WallePacket must stay exactly 10 bytes for the ESP-NOW payload");

// Build a packet with every field initialised. Using an
// aggregate initialiser also guarantees `reserved` is zeroed,
// which keeps the bytes deterministic and cheap to compare.
static inline WallePacket walle_make_packet(uint8_t type, uint8_t cmd,
                                            uint8_t value = 0, uint8_t flags = 0,
                                            uint16_t arg = 0, uint8_t seq = 0) {
    WallePacket p;
    p.magic    = WALLE_PROTO_MAGIC;
    p.version  = WALLE_PROTO_VERSION;
    p.type     = type;
    p.cmd      = cmd;
    p.value    = value;
    p.seq      = seq;
    p.flags    = flags;
    p.reserved = 0;
    p.arg      = arg;
    return p;
}

// Reject anything that is not exactly our protocol. Also guards
// against a peer that is running an older/newer revision.
static inline bool walle_packet_valid(const WallePacket& p, uint8_t len) {
    return len == WALLE_PROTO_PACKET_SIZE &&
           p.magic   == WALLE_PROTO_MAGIC &&
           p.version == WALLE_PROTO_VERSION;
}
