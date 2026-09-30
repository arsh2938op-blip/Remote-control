// ============================================================
//  Remote link — ESP-NOW transport to the ESP32-S3 robot
//  See remote_link.h.
// ============================================================
#include "remote_link.h"

#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_now.h>
#include <string.h>

static const char* TAG = "WROOM";

RemoteLink remoteLink;

namespace {
const uint8_t kBroadcast[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
}  // namespace

const char* RemoteLink::statusName(RemoteStatus s) {
    switch (s) {
        case RS_SEARCHING: return "searching";
        case RS_CONNECTED: return "connected";
        case RS_LOST:      return "lost";
        default:           return "?";
    }
}

bool RemoteLink::begin() {
    // The remote does not need to join a network. STA mode with no
    // SSID is exactly what ESP-NOW wants: full radio, no router.
    WiFi.mode(WIFI_STA);
    WiFi.disconnect(false, false);
    delay(50);

    // Power save would add tens of ms per packet - fatal for a
    // handheld remote.
    esp_wifi_set_ps(WIFI_PS_NONE);

    uint8_t channel = REMOTE_CHANNEL;
    if (!channel) channel = REMOTE_FALLBACK_CHANNEL;
    esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);

    if (esp_now_init() != ESP_OK) {
        Serial.printf("[WROOM] esp_now_init failed\n");
        return false;
    }

    esp_now_register_recv_cb(onReceive);
    esp_now_register_send_cb(nullptr);

    // Broadcast peer: this is how we discover the robot, and it is
    // also how a command reaches it before we know its MAC.
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, kBroadcast, 6);
    peer.channel = 0;
    peer.ifidx   = WIFI_IF_STA;
    peer.encrypt = false;
    if (esp_now_add_peer(&peer) != ESP_OK) {
        Serial.printf("[WROOM] could not add broadcast peer\n");
        esp_now_deinit();
        return false;
    }

    // An explicitly configured robot MAC replaces discovery.
    const uint8_t configured[6] = REMOTE_PEER_MAC;
    if (configured[0] | configured[1] | configured[2] |
        configured[3] | configured[4] | configured[5]) {
        memcpy(_robotMac, configured, 6);
        _haveRobot = true;
    }

    _initialised = true;
    _helloNextMs = 0;      // announce immediately
    Serial.printf("[WROOM] ESP-NOW ready on channel %u\n", channel);
    return true;
}

void RemoteLink::onReceive(const uint8_t* mac, const uint8_t* data, int len) {
    remoteLink.handlePacket(mac, data, len);
}

void RemoteLink::handlePacket(const uint8_t* mac, const uint8_t* data, int len) {
    if (len != WALLE_PROTO_PACKET_SIZE) return;

    WallePacket p;
    memcpy(&p, data, sizeof(p));
    if (!walle_packet_valid(p, (uint8_t)len)) return;
    if (p.type != WALLE_MSG_STATUS) return;      // only robots answer us

    const uint32_t now = millis();
    _lastRxMs = now;

    // Learn (or refresh) the robot's MAC from anything it sends.
    if (!_haveRobot || memcmp(_robotMac, mac, 6) != 0) {
        memcpy(_robotMac, mac, 6);
        _haveRobot = true;
        Serial.printf("[WROOM] Robot found: %02X:%02X:%02X:%02X:%02X:%02X\n",
                      mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    }

    switch (p.cmd) {
        case WALLE_ST_WELCOME:
        case WALLE_ST_ACK:
            _lastAck = walle_command_name(p.cmd);
            if (_status != RS_CONNECTED) setStatus(RS_CONNECTED);
            break;

        case WALLE_ST_PONG:
            _robotState = p.value;
            if (_status != RS_CONNECTED) setStatus(RS_CONNECTED);
            break;

        case WALLE_ST_ROBOT_STATE:
            _robotState = p.value;
            break;

        case WALLE_ST_REMOTE_STATE:
            // The robot is telling us what it thinks our link is.
            if (p.value == WALLE_REMOTE_TIMEOUT) {
                _lastAck = "remote_lost_on_robot";
            }
            break;

        case WALLE_ST_ERROR:
            _lastAck = String("error ") + String(p.value);
            if (_status != RS_CONNECTED) setStatus(RS_CONNECTED);
            break;

        default:
            break;
    }

#if REMOTE_VERBOSE_LOG
    Serial.printf("[WROOM] rx type=0x%02X cmd=0x%02X value=%u\n", p.type, p.cmd, p.value);
#endif
}

void RemoteLink::setStatus(RemoteStatus s) {
    if (_status == s) return;
    _status = s;
    Serial.printf("[WROOM] Link %s\n", statusName(s));
}

void RemoteLink::sendPacket(uint8_t type, uint8_t cmd, uint8_t value, uint8_t flags) {
    if (!_initialised) return;
    const WallePacket p = walle_make_packet(type, cmd, value, flags, 0, _seq++);

    // Until we know the robot's MAC everything goes out broadcast;
    // the robot filters by magic/version and answers unicast.
    const uint8_t* dest = _haveRobot ? _robotMac : kBroadcast;
    esp_now_send(dest, (const uint8_t*)&p, sizeof(p));
    _lastTxMs = millis();
}

void RemoteLink::sendCommand(uint8_t command, bool held) {
    sendPacket(WALLE_MSG_COMMAND, command, 0, held ? WALLE_FLAG_HELD : 0);
    Serial.printf("[WROOM] Sending: %s%s\n", walle_command_name(command),
                  held ? " (held)" : "");
}

void RemoteLink::update(uint32_t now) {
    if (!_initialised) return;

    // Announce ourselves until the robot answers, so a remote that
    // powered on after the robot is picked up automatically.
    if (!_haveRobot && (int32_t)(now - _helloNextMs) >= 0) {
        sendPacket(WALLE_MSG_COMMAND, WALLE_CMD_HELLO, 0, 0);
        _helloNextMs = now + 500;
        return;
    }

    if (_haveRobot) {
        // Keepalive. The robot's REMOTE_TIMEOUT_MS is much larger
        // than this interval, so an idle remote never trips it.
        if ((now - _lastTxMs) >= REMOTE_PING_INTERVAL_MS) {
            sendPacket(WALLE_MSG_COMMAND, WALLE_CMD_PING, 0, 0);
        }

        // Two missed windows plus slack means the robot is gone.
        if (_lastRxMs != 0 && (now - _lastRxMs) > REMOTE_LOST_TIMEOUT_MS) {
            if (_status != RS_LOST) setStatus(RS_LOST);
        }
    }
}
