/*
 * imx_bridge: talks ISB to an Inertial Sense IMX-5 through the SDK's ISComm
 * layer and writes one JSON object per received data set to stdout (NDJSON).
 * Field names follow the SDK structs in data_sets.h so the stream can be read
 * against the SDK docs. Commands arrive one per line on stdin.
 *
 *   imx_bridge [--port auto|DEV] [--baud 921600] [--nav-mult 1] [--raw-mult 0]
 *
 * --raw-mult N also streams DID_IMU_RAW every N ms (1 = 1 kHz) as "imuraw".
 *
 * With --port auto (the default) it finds the unit itself and follows it
 * across unplug and replug, whatever ttyACM number it comes back as. A glob
 * (--port '/dev/ttyACM*') searches those ports the same way.
 *
 * stdin commands:
 *   magrecal multi|single|abort    start or abort a magnetometer recalibration
 *   zeromotion                     tell the filter the unit is stationary (gyro bias)
 *   clearfault                     clear the latched DID_SYS_PARAMS.genFaultCode
 *   reset                          software reset of the IMX
 *   info                           re-request device info and flash config
 */

#include <cerrno>
#include <cmath>
#include <csignal>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>

#include <climits>
#include <cstdlib>
#include <map>
#include <vector>

#include <glob.h>
#include <poll.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "ISComm.h"
#include "ISPose.h"
#include "serialPortPlatform.h"

static serial_port_t s_port;
static is_comm_instance_t s_comm;
static uint8_t s_commBuf[PKT_BUF_SIZE];
static volatile sig_atomic_t s_running = 1;
static double s_lastRx = 0;
static bool s_gotPacket = false; // a checksummed ISB packet arrived: whoever is on this port speaks IMX
static bool s_gotInfo = false, s_gotCfg = false; // the one-shot replies; a unit still booting can miss the request
static int s_navMult = 1;
static int s_rawMult = 0; // DID_IMU_RAW period multiple of the 1 ms IMU sample; 0 = off

static double now_s()
{
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}

// ---- JSON output -------------------------------------------------------------

static char s_line[4096];
static int s_len;

static void jbegin(const char* type)
{
    s_len = snprintf(s_line, sizeof(s_line), "{\"t\":\"%s\"", type);
}

static void jraw(const char* fmt, ...)
{
    if (s_len >= (int)sizeof(s_line)) return;
    va_list ap;
    va_start(ap, fmt);
    s_len += vsnprintf(s_line + s_len, sizeof(s_line) - s_len, fmt, ap);
    va_end(ap);
}

// NaN and inf are not JSON; they go out as null
static void jnum(double v, const char* fmt)
{
    if (std::isfinite(v)) jraw(fmt, v);
    else jraw("null");
}

static void jf(const char* key, double v, const char* fmt = "%.7g")
{
    jraw(",\"%s\":", key);
    jnum(v, fmt);
}

static void ju(const char* key, uint32_t v) { jraw(",\"%s\":%u", key, v); }

static void jarr(const char* key, const float* v, int n, const char* fmt = "%.7g")
{
    jraw(",\"%s\":[", key);
    for (int i = 0; i < n; i++)
    {
        if (i) jraw(",");
        jnum(v[i], fmt);
    }
    jraw("]");
}

static void jarrd(const char* key, const double* v, int n, const char* fmt)
{
    jraw(",\"%s\":[", key);
    for (int i = 0; i < n; i++)
    {
        if (i) jraw(",");
        jnum(v[i], fmt);
    }
    jraw("]");
}

static void jstr(const char* key, const char* s)
{
    jraw(",\"%s\":\"", key);
    for (; *s && s_len < (int)sizeof(s_line) - 8; s++)
    {
        if (*s == '"' || *s == '\\') jraw("\\%c", *s);
        else if ((unsigned char)*s >= 0x20) jraw("%c", *s);
    }
    jraw("\"");
}

static void jend()
{
    if (s_len >= (int)sizeof(s_line) - 2) return;   // truncated, drop rather than emit broken JSON
    s_line[s_len++] = '}';
    s_line[s_len++] = '\n';
    fwrite(s_line, 1, s_len, stdout);
}

static void emit_link(bool up, const char* port, const char* why)
{
    char real[PATH_MAX];
    jbegin("link");
    jraw(",\"up\":%s", up ? "true" : "false");
    jstr("port", port);
    if (realpath(port, real)) jstr("dev", real); // the ttyACM behind a by-id link
    if (why) jstr("why", why);
    jend();
    fflush(stdout);
}

static void emit_log(const char* fmt, ...)
{
    char msg[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);
    jbegin("log");
    jstr("msg", msg);
    jend();
    fflush(stdout);
}

// ---- device requests ---------------------------------------------------------

static void send_buf(const uint8_t* buf, int len)
{
    if (len > 0) serialPortWrite(&s_port, buf, len);
}

static void request(uint32_t did, uint32_t periodMultiple)
{
    uint8_t buf[64];
    send_buf(buf, is_comm_get_data_to_buf(buf, sizeof(buf), &s_comm, did, 0, 0, periodMultiple));
}

static void stop_broadcasts()
{
    uint8_t buf[64];
    send_buf(buf, is_comm_write_to_buf(buf, sizeof(buf), &s_comm, PKT_TYPE_STOP_BROADCASTS_ALL_PORTS, 0, 0, 0, NULL));
}

static void sys_cmd(uint32_t command)
{
    system_command_t cmd;
    cmd.command = command;
    cmd.invCommand = ~command;
    uint8_t buf[64];
    send_buf(buf, is_comm_set_data_to_buf(buf, sizeof(buf), &s_comm, DID_SYS_CMD, sizeof(cmd), 0, &cmd));
}

static void request_info()
{
    request(DID_DEV_INFO, 0);       // period 0: one packet, no broadcast
    request(DID_FLASH_CONFIG, 0);
}

// Periods are multiples of each data set's source period, which differs per
// set. Measured on fw 2.7.0 with startupNavDtMs 7: INS 143 Hz, IMU 71 Hz (nav
// update period), mag and baro 50 Hz; the diagnostic sets below land near 10 Hz.
static void request_streams()
{
    request(DID_INS_1, s_navMult);
    request(DID_INS_2, s_navMult);
    request(DID_IMU, s_navMult);
    request(DID_MAGNETOMETER, 1);
    request(DID_BAROMETER, 1);
    request(DID_INL2_NED_SIGMA, 20);
    request(DID_INL2_STATES, 100);
    request(DID_INL2_MAG_OBS_INFO, 100);
    request(DID_SYS_PARAMS, 100);
    request(DID_MAG_CAL, 100);
    if (s_rawMult > 0) request(DID_IMU_RAW, s_rawMult);
}

// ---- incoming ISB --------------------------------------------------------------

static void emit_flash(const nvm_flash_cfg_t& f)
{
    jbegin("cfg");
    ju("sensorConfig", f.sensorConfig);
    ju("dynamicModel", f.dynamicModel);
    ju("startupImuDtMs", f.startupImuDtMs);
    ju("startupNavDtMs", f.startupNavDtMs);
    ju("startupGPSDtMs", f.startupGPSDtMs);
    ju("sysCfgBits", f.sysCfgBits);
    ju("platformConfig", f.platformConfig);
    ju("ioConfig", f.ioConfig);
    ju("ser0BaudRate", f.ser0BaudRate);
    ju("ser1BaudRate", f.ser1BaudRate);
    ju("ser2BaudRate", f.ser2BaudRate);
    jf("magDeclination", f.magDeclination);
    jarr("insRotation", f.insRotation, 3);
    jarr("insOffset", f.insOffset, 3);
    jend();
}

static int on_isb(void* ctx, p_data_t* data, port_handle_t port)
{
    (void)ctx; (void)port;
    s_lastRx = now_s();
    s_gotPacket = true;
    const uDatasets* d = (const uDatasets*)data->ptr;

    switch (data->hdr.id)
    {
    case DID_DEV_INFO:
    {
        s_gotInfo = true;
        const dev_info_t& v = d->devInfo;
        char fw[32], hw[32], build[32];
        snprintf(fw, sizeof(fw), "%u.%u.%u", v.firmwareVer[0], v.firmwareVer[1], v.firmwareVer[2]);
        snprintf(hw, sizeof(hw), "%u.%u.%u", v.hardwareVer[0], v.hardwareVer[1], v.hardwareVer[2]);
        snprintf(build, sizeof(build), "20%02u-%02u-%02u", v.buildYear, v.buildMonth, v.buildDay);
        jbegin("dev");
        ju("serialNumber", v.serialNumber);
        ju("hardwareType", v.hardwareType);
        jstr("hardwareVer", hw);
        jstr("firmwareVer", fw);
        jstr("buildDate", build);
        jstr("manufacturer", v.manufacturer);
        jstr("addInfo", v.addInfo);
        jend();
        break;
    }
    case DID_FLASH_CONFIG:
        // A partial read (offset != 0) would be a fragment; only whole configs are emitted.
        if (data->hdr.offset == 0 && data->hdr.size >= sizeof(nvm_flash_cfg_t))
        {
            s_gotCfg = true;
            emit_flash(d->flashCfg);
        }
        break;
    case DID_INS_1:
    {
        const ins_1_t& v = d->ins1;
        jbegin("ins1");
        ju("week", v.week);
        jf("timeOfWeek", v.timeOfWeek, "%.4f");
        ju("insStatus", v.insStatus);
        ju("hdwStatus", v.hdwStatus);
        jarr("theta", v.theta, 3);
        jarr("uvw", v.uvw, 3);
        jarrd("lla", v.lla, 3, "%.9f");
        jarr("ned", v.ned, 3);
        jend();
        break;
    }
    case DID_INS_2:
    {
        const ins_2_t& v = d->ins2;
        jbegin("ins2");
        jf("timeOfWeek", v.timeOfWeek, "%.4f");
        ju("insStatus", v.insStatus);
        ju("hdwStatus", v.hdwStatus);
        jarr("qn2b", v.qn2b, 4);
        jend();
        break;
    }
    case DID_IMU:
    {
        const imu_t& v = d->imu;
        jbegin("imu");
        jf("time", v.time, "%.4f");
        ju("status", v.status);
        jarr("pqr", v.I.pqr, 3);
        jarr("acc", v.I.acc, 3);
        jend();
        break;
    }
    case DID_IMU_RAW:
    {
        const imu_t& v = d->imu;
        jbegin("imuraw");
        jf("time", v.time, "%.4f");
        ju("status", v.status);
        jarr("pqr", v.I.pqr, 3);
        jarr("acc", v.I.acc, 3);
        jend();
        break;
    }
    case DID_MAGNETOMETER:
        jbegin("mag");
        jf("time", d->mag.time, "%.4f");
        jarr("mag", d->mag.mag, 3);
        jend();
        break;
    case DID_BAROMETER:
        jbegin("baro");
        jf("time", d->baro.time, "%.4f");
        jf("bar", d->baro.bar);
        jf("mslBar", d->baro.mslBar);
        jf("barTemp", d->baro.barTemp);
        jf("humidity", d->baro.humidity);
        jend();
        break;
    case DID_SYS_PARAMS:
    {
        const sys_params_t& v = d->sysParams;
        jbegin("sys");
        ju("insStatus", v.insStatus);
        ju("hdwStatus", v.hdwStatus);
        jf("imuTemp", v.imuTemp);
        jf("baroTemp", v.baroTemp);
        jf("mcuTemp", v.mcuTemp);
        ju("sysStatus", v.sysStatus);
        ju("imuSamplePeriodMs", v.imuSamplePeriodMs);
        ju("navOutputPeriodMs", v.navOutputPeriodMs);
        ju("navUpdatePeriodMs", v.navUpdatePeriodMs);
        ju("genFaultCode", v.genFaultCode);
        jf("upTime", v.upTime, "%.3f");
        jend();
        break;
    }
    case DID_INL2_STATES:
    {
        const inl2_states_t& v = d->inl2States;
        jbegin("inl2");
        jarr("biasPqr", v.biasPqr, 3);
        jarr("biasAcc", v.biasAcc, 3);
        jf("biasBaro", v.biasBaro);
        jf("magDec", v.magDec);
        jf("magInc", v.magInc);
        jend();
        break;
    }
    case DID_INL2_NED_SIGMA:
    {
        const inl2_ned_sigma_t& v = d->inl2NedSigma;
        jbegin("sigma");
        jarr("StdAttNed", v.StdAttNed, 3);
        jarr("StdVelNed", v.StdVelNed, 3);
        jarr("StdGyrBias", v.StdGyrBias, 3);
        jarr("StdAccBias", v.StdAccBias, 3);
        jf("StdMagDeclination", v.StdMagDeclination);
        jend();
        break;
    }
    case DID_INL2_MAG_OBS_INFO:
    {
        const inl2_mag_obs_info_t& v = *(const inl2_mag_obs_info_t*)data->ptr;   // not in uDatasets
        jbegin("magobs");
        ju("Ncal_samples", v.Ncal_samples);
        ju("calibrated", v.calibrated);
        ju("auto_recal", v.auto_recal);
        ju("outlier", v.outlier);
        jf("magHdg", v.magHdg);
        jf("insHdg", v.insHdg);
        jf("magInsHdgDelta", v.magInsHdgDelta);
        jf("nis", v.nis);
        jf("nis_threshold", v.nis_threshold);
        jf("Tcal", v.Tcal);
        jarr("bias_cal", v.bias_cal, 3);
        jend();
        break;
    }
    case DID_MAG_CAL:
        jbegin("magcal");
        ju("state", d->magCal.state);
        jf("progress", d->magCal.progress);
        jf("declination", d->magCal.declination);
        jend();
        break;
    }
    return 0;
}

// ---- stdin commands --------------------------------------------------------------

static void handle_command(const std::string& line)
{
    char word[32] = {0}, arg[32] = {0};
    if (sscanf(line.c_str(), "%31s %31s", word, arg) < 1) return;
    std::string cmd(word), a(arg);

    if (cmd == "magrecal")
    {
        uint32_t state = a == "single" ? MAG_CAL_STATE_SINGLE_AXIS
                       : a == "abort"  ? MAG_CAL_STATE_ABORT
                                       : MAG_CAL_STATE_MULTI_AXIS;
        uint8_t buf[64];
        send_buf(buf, is_comm_set_data_to_buf(buf, sizeof(buf), &s_comm, DID_MAG_CAL, sizeof(state), offsetof(mag_cal_t, state), &state));
        request(DID_MAG_CAL, 20);  // watch progress faster while it runs
        emit_log("mag recal: %s", a.empty() ? "multi" : a.c_str());
    }
    else if (cmd == "clearfault")
    {
        // genFaultCode latches (e.g. GFC_SENSOR_SATURATION); writing zero clears it
        uint32_t zero = 0;
        uint8_t buf[64];
        send_buf(buf, is_comm_set_data_to_buf(buf, sizeof(buf), &s_comm, DID_SYS_PARAMS, sizeof(zero), offsetof(sys_params_t, genFaultCode), &zero));
        emit_log("fault code cleared");
    }
    else if (cmd == "zeromotion") { sys_cmd(SYS_CMD_ZERO_MOTION); emit_log("zero motion sent"); }
    else if (cmd == "reset")      { sys_cmd(SYS_CMD_SOFTWARE_RESET); emit_log("software reset sent"); }
    else if (cmd == "info")       request_info();
    else emit_log("unknown command: %s", cmd.c_str());
}

// stdin as a pipe means a parent (imuctl) is driving us: its end closing
// means it is gone. Any other stdin (a terminal, /dev/null) that ends just stops commands.
static bool s_stdinOpen = true;
static void stdin_ended()
{
    struct stat st;
    if (fstat(STDIN_FILENO, &st) == 0 && S_ISFIFO(st.st_mode)) s_running = 0;
    s_stdinOpen = false;
}

static void poll_stdin()
{
    static std::string pending;
    pollfd p = { STDIN_FILENO, POLLIN, 0 };
    while (s_stdinOpen && poll(&p, 1, 0) > 0)
    {
        // a closed pipe reports POLLHUP without POLLIN
        if (!(p.revents & POLLIN)) return stdin_ended();
        char buf[256];
        ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
        if (n <= 0) return stdin_ended();
        pending.append(buf, n);
        size_t nl;
        while ((nl = pending.find('\n')) != std::string::npos)
        {
            handle_command(pending.substr(0, nl));
            pending.erase(0, nl + 1);
        }
    }
}

// ---- finding the unit ----------------------------------------------------------

/*
 * Where an IMX can appear when --port is "auto", best first: the udev symlink
 * from scripts/99-imx5.rules, then udev's stock by-id links. Those survive
 * re-enumeration (ttyACM0 coming back as ttyACM1) and vanish on unplug.
 * Betaflight and other STM32 boards share VID:PID 0483:5740, so a candidate
 * is only kept once it answers in ISB.
 */
static bool is_search(const std::string& port)
{
    return port == "auto" || port.find_first_of("*?[") != std::string::npos;
}

/** --port auto, a glob such as '/dev/ttyACM*', or one fixed device. */
static std::vector<std::string> candidates(const std::string& port)
{
    if (!is_search(port)) return { port };
    std::vector<std::string> out;
    if (port == "auto" && access("/dev/imx5", F_OK) == 0) out.push_back("/dev/imx5");
    std::vector<std::string> patterns;
    if (port == "auto")
        patterns = { "/dev/serial/by-id/usb-STMicroelectronics_STM32_Virtual_ComPort_*", "/dev/serial/by-id/usb-Inertial_Sense*" };
    else
        patterns = { port };
    for (const std::string& pattern : patterns)
    {
        glob_t g;
        if (glob(pattern.c_str(), 0, NULL, &g) == 0)
            for (size_t i = 0; i < g.gl_pathc; i++) out.push_back(g.gl_pathv[i]);
        globfree(&g);
    }
    return out;
}

static bool node_of(const std::string& path, dev_t* rdev)
{
    struct stat st;
    if (stat(path.c_str(), &st) != 0 || !S_ISCHR(st.st_mode)) return false;
    *rdev = st.st_rdev;
    return true;
}

// The SDK's Linux read treats a hangup (POLLHUP) as "no data", so an unplugged
// port just goes quiet. Watch the device node instead: on unplug it disappears,
// and a replugged unit gets a new one.
static bool still_there(const std::string& path, dev_t rdev)
{
    dev_t now;
    return node_of(path, &now) && now == rdev;
}

// ---- main loop -------------------------------------------------------------------

static void on_signal(int) { s_running = 0; }

int main(int argc, char* argv[])
{
    std::string portArg = "auto";
    int baud = IS_BAUDRATE_921600;
    for (int i = 1; i < argc; i++)
    {
        if (!strcmp(argv[i], "--port") && i + 1 < argc) portArg = argv[++i];
        else if (!strcmp(argv[i], "--baud") && i + 1 < argc) baud = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--nav-mult") && i + 1 < argc) s_navMult = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--raw-mult") && i + 1 < argc) s_rawMult = atoi(argv[++i]);
        else
        {
            fprintf(stderr, "usage: %s [--port auto|DEV] [--baud N] [--nav-mult N] [--raw-mult N]\n", argv[0]);
            return 2;
        }
    }
    const bool autoPort = is_search(portArg);

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGPIPE, on_signal);
#ifdef __linux__
    prctl(PR_SET_PDEATHSIG, SIGTERM); // never outlive the server and keep the port held
#endif
    serialPortPlatformInit(&s_port);

    std::string current = portArg;     // the path we have open
    dev_t currentDev = 0;
    std::map<std::string, dev_t> rejected; // ports that never answered, until their node changes
    bool open = false, linked = false, answered = false;
    double openedAt = 0, lastScan = -10, lastCheck = 0, lastRequest = 0;
    std::string lastWhy;

    // one message per change, not one per retry
    auto link_down = [&](const std::string& port, const char* why) {
        if (!linked && lastWhy == why) return;
        emit_link(false, port.c_str(), why);
        linked = false;
        lastWhy = why;
    };
    auto close_port = [&](const char* why) {
        serialPortClose(&s_port);
        open = false;
        link_down(current, why);
    };

    while (s_running)
    {
        poll_stdin();
        double t = now_s();

        if (!open)
        {
            if (t - lastScan < 0.3) { usleep(20000); continue; }
            lastScan = t;
            bool present = false;
            for (const std::string& c : candidates(portArg))
            {
                dev_t rdev;
                if (!node_of(c, &rdev)) continue;
                present = true;
                auto r = rejected.find(c);
                if (r != rejected.end() && r->second == rdev) continue;
                // can fail for a moment while udev is still applying the group permissions
                if (!serialPortOpen(&s_port, c.c_str(), baud, 1)) continue;
                current = c;
                currentDev = rdev;
                open = true;
                answered = false;
                is_comm_init(&s_comm, s_commBuf, sizeof(s_commBuf), NULL); // drop any half-parsed packet
                is_comm_register_isb_handler(&s_comm, on_isb);
                s_gotPacket = s_gotInfo = s_gotCfg = false;
                stop_broadcasts();
                request_info();
                request_streams();
                openedAt = lastRequest = s_lastRx = t;
                break;
            }
            for (auto it = rejected.begin(); it != rejected.end();)
            {
                dev_t rdev;
                it = node_of(it->first, &rdev) && rdev == it->second ? std::next(it) : rejected.erase(it);
            }
            if (!open) link_down(portArg, present ? "not answering" : "searching");
            continue;
        }

        if (t - lastCheck > 0.25)
        {
            lastCheck = t;
            if (!still_there(current, currentDev)) { close_port("unplugged"); continue; }
        }

        uint8_t buf[4096];
        int n = serialPortReadTimeout(&s_port, buf, sizeof(buf), 10);
        if (n < 0)
        {
            close_port(still_there(current, currentDev) ? strerror(s_port.errorCode) : "unplugged");
            continue;
        }
        if (n > 0)
        {
            is_comm_buffer_parse_messages(buf, n, &s_comm);
            fflush(stdout);
        }
        if (s_gotPacket)
        {
            s_gotPacket = false;
            answered = true;
            if (!linked)
            {
                linked = true;
                lastWhy.clear();
                emit_link(true, current.c_str(), NULL);
            }
        }

        // searching: a port that hasn't spoken ISB within 3 s is some other STM32 device
        if (autoPort && !answered && t - openedAt > 3.0)
        {
            rejected[current] = currentDev;
            char real[PATH_MAX];
            emit_log("%s did not answer in ISB; skipping it", realpath(current.c_str(), real) ? real : current.c_str());
            close_port("not an IMX");
            continue;
        }

        // quiet for 1.5 s while open: the device reset or dropped our streams; ask again
        if (t - s_lastRx > 1.5 && t - lastRequest > 1.5)
        {
            link_down(current, answered ? "no data" : "not answering");
            request_info();
            request_streams();
            lastRequest = t;
        }
        else if (linked && (!s_gotInfo || !s_gotCfg) && t - lastRequest > 1.0)
        {
            request_info();
            lastRequest = t;
        }
    }

    if (open)
    {
        stop_broadcasts();
        serialPortClose(&s_port);
    }
    return 0;
}
