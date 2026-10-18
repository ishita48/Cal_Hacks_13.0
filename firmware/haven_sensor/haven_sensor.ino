/*
 * HAVEN water sensor — ESP32 + resistive water probe ($4).
 *
 * Reads the probe on an ADC pin, maps it to a 0..1 wetness, and POSTs it to the HAVEN
 * backend as a SensorReading input event:
 *   POST {HAVEN_URL}/api/sensor   {"sensor_id": "...", "value": 0.0..1.0, "source": "esp32"}
 *   header X-Haven-Token: <HAVEN_SENSOR_TOKEN>  (only checked if the backend sets the env var)
 *
 * Posts every SAMPLE_MS while dry, and immediately on any crossing of the wet threshold, so
 * the demo lands the event the moment the probe touches water. The backend derives the
 * whole cascade from this one reading; nothing else is sent.
 *
 * Wiring (typical HW-038 / "rain drop" probe): VCC -> 3V3, GND -> GND, S -> GPIO 34.
 * Board: "ESP32 Dev Module" (Arduino core 2.x or 3.x). Libraries: WiFi, HTTPClient (bundled).
 */

#include <WiFi.h>
#include <HTTPClient.h>

// ---- configure ---------------------------------------------------------------------------
const char* WIFI_SSID   = "YOUR_WIFI";
const char* WIFI_PASS   = "YOUR_PASSWORD";
const char* HAVEN_URL   = "http://192.168.1.50:8000";   // laptop running the backend, or the Railway URL
const char* HAVEN_TOKEN = "";                            // must match HAVEN_SENSOR_TOKEN on the backend, if set
const char* SENSOR_ID   = "basement_mech_1";             // equipment id in the building spec

const int   PROBE_PIN   = 34;        // ADC1 channel (ADC2 pins stop working while Wi-Fi is on)
const int   DRY_RAW     = 300;       // raw ADC reading with a dry probe (calibrate: Serial prints raw)
const int   WET_RAW     = 2200;      // raw ADC reading when the probe is fully in water
const float WET_THRESH  = 0.5f;      // same threshold as backend WET_THRESHOLD
const unsigned long SAMPLE_MS    = 2000;   // heartbeat while nothing changes
const unsigned long HEARTBEAT_MS = 15000;  // always post at least this often

// ---- state -------------------------------------------------------------------------------
bool lastWet = false;
unsigned long lastPost = 0;
unsigned long lastSample = 0;

float readWetness() {
  long sum = 0;
  for (int i = 0; i < 16; i++) { sum += analogRead(PROBE_PIN); delayMicroseconds(200); }
  float raw = sum / 16.0f;
  float v = (raw - DRY_RAW) / float(WET_RAW - DRY_RAW);
  if (v < 0) v = 0; if (v > 1) v = 1;
  Serial.printf("raw=%.0f wetness=%.2f\n", raw, v);
  return v;
}

bool post(float value) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  String url = String(HAVEN_URL) + "/api/sensor";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  if (strlen(HAVEN_TOKEN)) http.addHeader("X-Haven-Token", HAVEN_TOKEN);
  String body = String("{\"sensor_id\":\"") + SENSOR_ID + "\",\"value\":" + String(value, 3) + ",\"source\":\"esp32\"}";
  int code = http.POST(body);
  Serial.printf("POST %s -> %d\n", url.c_str(), code);
  http.end();
  return code >= 200 && code < 300;
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("wifi");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) { delay(250); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : " failed (will retry)");
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  analogSetPinAttenuation(PROBE_PIN, ADC_11db);   // full 0..3.3 V range
  pinMode(PROBE_PIN, INPUT);
  connectWifi();
}

void loop() {
  unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED && now - lastSample > 5000) { connectWifi(); }
  if (now - lastSample < SAMPLE_MS) { delay(20); return; }
  lastSample = now;

  float v = readWetness();
  bool wet = v >= WET_THRESH;
  bool crossed = wet != lastWet;
  if (crossed || now - lastPost > HEARTBEAT_MS) {
    if (post(v)) { lastPost = now; lastWet = wet; }
  }
}
