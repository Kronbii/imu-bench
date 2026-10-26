#!/usr/bin/env python3
"""
A sensor in a dozen lines: send IMU samples to imu-bench as JSON over UDP.
Swap the fake readings for your device's. Run the bench first:

  ./imu-bench lines udp:5005 --name "My IMU"
  python3 examples/udp_sender.py
"""

import json
import math
import socket
import time

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
t0 = time.monotonic()
while True:
    t = time.monotonic() - t0
    roll_rate = 0.6 * math.cos(0.8 * t)  # rad/s: a slow rock about x
    roll = 0.75 * math.sin(0.8 * t)
    sample = {
        "time": t,
        "gyro": [roll_rate, 0.0, 0.0],  # rad/s, FRD
        "acc": [0.0, -9.80665 * math.sin(roll), -9.80665 * math.cos(roll)],  # m/s^2, FRD: gravity seen rolled
    }
    sock.sendto(json.dumps(sample).encode(), ("127.0.0.1", 5005))
    time.sleep(0.01)  # 100 Hz
