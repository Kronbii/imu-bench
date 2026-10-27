// MPU-6050 to imuctl, no libraries: reads the sensor over I2C and prints
// one JSON line per sample at 200 Hz, already in SI units.
//
//   ./imuctl lines /dev/ttyUSB0@115200 --name MPU-6050 --axes x,-y,-z
//
// The MPU-6050's axes are printed on its board (x forward, y left, z up on
// most GY-521 breakouts); --axes x,-y,-z turns that into imuctl's FRD.
// Wiring: VCC 3.3-5 V, GND, SDA, SCL (A4/A5 on an Uno, 21/22 on an ESP32).

#include <Wire.h>

const uint8_t MPU = 0x68;
const float G = 9.80665f;
const float ACC_LSB = 16384.0f;   // +-2 g
const float GYRO_LSB = 131.0f;    // +-250 deg/s
const float DEG2RAD = 0.01745329252f;
const unsigned long PERIOD_US = 5000;  // 200 Hz

void writeReg(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(400000);
  writeReg(0x6B, 0x00);  // wake up
  writeReg(0x1A, 0x03);  // DLPF 44 Hz
  writeReg(0x1B, 0x00);  // gyro +-250 deg/s
  writeReg(0x1C, 0x00);  // accel +-2 g
}

int16_t next16() {
  int16_t hi = Wire.read();
  return (hi << 8) | Wire.read();
}

void loop() {
  static unsigned long next = micros();
  if ((long)(micros() - next) < 0) return;
  next += PERIOD_US;

  Wire.beginTransmission(MPU);
  Wire.write(0x3B);  // ACCEL_XOUT_H, then temperature, then gyro
  Wire.endTransmission(false);
  Wire.requestFrom(MPU, (uint8_t)14);
  float ax = next16() / ACC_LSB * G, ay = next16() / ACC_LSB * G, az = next16() / ACC_LSB * G;
  next16();  // temperature
  float gx = next16() / GYRO_LSB * DEG2RAD, gy = next16() / GYRO_LSB * DEG2RAD, gz = next16() / GYRO_LSB * DEG2RAD;

  // The MPU reports +g on z when flat (it measures "up"); imuctl's FRD wants -g on z,
  // which --axes x,-y,-z also takes care of.
  Serial.print("{\"time\":");
  Serial.print(micros() / 1e6, 4);
  Serial.print(",\"gyro\":[");
  Serial.print(gx, 5); Serial.print(','); Serial.print(gy, 5); Serial.print(','); Serial.print(gz, 5);
  Serial.print("],\"acc\":[");
  Serial.print(ax, 4); Serial.print(','); Serial.print(ay, 4); Serial.print(','); Serial.print(az, 4);
  Serial.println("]}");
}
