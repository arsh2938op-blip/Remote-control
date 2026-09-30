// ============================================================
//  Remote link — ESP-NOW transport to the ESP32-S3 robot
//  ------------------------------------------------------------
//  The remote is a pure controller: it reads buttons, turns them
//  into WalleCommand ids and sends them. It holds no robot logic
//  and never decides what the robot should do — that is entirely
//  the robot's job (command_dispatch.cpp on the S3 side).
//
//  Discovery is automatic. The remote broadcasts a HELLO, the robot
//  replies unicast, and from then on the remote knows the robot's
//  MAC and sends everything to it directly.
// ============================================================
#pragma once

#include <Arduino.h>
#include "config.h"
#include "walle_protocol.h"

enum RemoteStatus {
    RS_SEARCHING = 0,   // no robot heard yet
    RS_CONNECTED,       // robot acked us
    RS_LOST,            // had a robot, stopped hearing it
};

class RemoteLink {
public:
    bool begin();

    // Sends a command. `held` marks a held button so the robot can
    // tell a sustained press from a tap. Fire and forget: ESP-NOW
    // gives us no delivery guarantee, which is exactly why the
    // robot has a timeout and why held buttons re-send.
    void sendCommand(uint8_t command, bool held = false);

    // Call every loop(): keepalive + link state tracking.
    void update(uint32_t now);

    RemoteStatus status() const { return _status; }
    static const char* statusName(RemoteStatus s);
    bool connected() const { return _status == RS_CONNECTED; }
    bool foundRobot() const { return _haveRobot; }

    // Last robot state byte, forwarded to the caller for display.
    uint8_t robotState() const { return _robotState; }
    String lastAckName() const { return _lastAck; }

private:
    static void onReceive(const uint8_t* mac, const uint8_t* data, int len);
    void handlePacket(const uint8_t* mac, const uint8_t* data, int len);
    void setStatus(RemoteStatus s);
    void sendPacket(uint8_t type, uint8_t cmd, uint8_t value, uint8_t flags);

    bool     _initialised = false;
    bool     _haveRobot = false;
    uint8_t  _robotMac[6] = {0};
    uint8_t  _seq = 0;
    uint32_t _lastTxMs = 0;
    uint32_t _lastRxMs = 0;
    uint32_t _helloNextMs = 0;
    RemoteStatus _status = RS_SEARCHING;
    uint8_t  _robotState = 0;
    String    _lastAck;
};

extern RemoteLink remoteLink;
