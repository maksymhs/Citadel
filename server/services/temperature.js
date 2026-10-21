/**
 * Best-effort machine temperature for the monitor panel.
 *
 * Only physical machines expose a sensor, so this returns null on VPSs,
 * containers and desktops without one, and the UI hides the reading.
 * `source` says what was measured: 'cpu', or 'battery' on MacBooks, where no
 * unprivileged CPU sensor exists (powermetrics needs root).
 */
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const CACHE_MS = 5000;
const CPU_SENSOR_NAMES = /^(coretemp|k10temp|zenpower|cpu[-_]thermal|x86_pkg_temp|soc[-_]thermal|cpu)/i;

let cached = null;

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 2000 });
  return res.status === 0 ? res.stdout : null;
}

function validCelsius(c) {
  return Number.isFinite(c) && c > 0 && c < 150 ? Math.round(c * 10) / 10 : null;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function linuxTemperature() {
  const readings = [];
  let thermal = [];
  try {
    thermal = fs.readdirSync('/sys/class/thermal').filter((d) => d.startsWith('thermal_zone'));
  } catch {
    // No thermal zones (VPS, container).
  }
  for (const zone of thermal) {
    const type = readText(`/sys/class/thermal/${zone}/type`) || '';
    const raw = parseInt(readText(`/sys/class/thermal/${zone}/temp`), 10);
    if (CPU_SENSOR_NAMES.test(type)) readings.push(raw / 1000);
  }
  let hwmon = [];
  try {
    hwmon = fs.readdirSync('/sys/class/hwmon');
  } catch {
    // No hwmon sensors.
  }
  for (const dir of hwmon) {
    const name = readText(`/sys/class/hwmon/${dir}/name`) || '';
    if (!CPU_SENSOR_NAMES.test(name)) continue;
    const raw = parseInt(readText(`/sys/class/hwmon/${dir}/temp1_input`), 10);
    readings.push(raw / 1000);
  }
  const best = readings.map(validCelsius).filter((c) => c !== null);
  return best.length ? { celsius: Math.max(...best), source: 'cpu' } : null;
}

function darwinTemperature() {
  // Third-party CLIs, when the user has installed one.
  const osxCpuTemp = run('osx-cpu-temp', []);
  const cpu = validCelsius(parseFloat(/([\d.]+)\s*°?C/.exec(osxCpuTemp || '')?.[1]));
  if (cpu !== null) return { celsius: cpu, source: 'cpu' };

  // MacBooks report battery temperature in centi-degrees without privileges.
  // Absolute path: launchd's PATH for the service has no /usr/sbin.
  const battery = run('/usr/sbin/ioreg', ['-rn', 'AppleSmartBattery']);
  const raw = parseInt(/"Temperature"\s*=\s*(\d+)/.exec(battery || '')?.[1], 10);
  const celsius = validCelsius(raw / 100);
  return celsius !== null ? { celsius, source: 'battery' } : null;
}

function windowsTemperature() {
  // Needs a firmware that exposes ACPI thermal zones; often unavailable.
  const out = run('powershell', [
    '-NoProfile', '-Command',
    'Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | ForEach-Object { $_.CurrentTemperature }',
  ]);
  const kelvinTenths = (out || '').split(/\s+/).map(Number).filter(Number.isFinite);
  if (!kelvinTenths.length) return null;
  const celsius = validCelsius(Math.max(...kelvinTenths) / 10 - 273.15);
  return celsius !== null ? { celsius, source: 'cpu' } : null;
}

/** @returns {{ celsius: number, source: 'cpu' | 'battery' } | null} */
function getTemperature() {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;

  let value = null;
  try {
    const platform = os.platform();
    if (platform === 'linux') value = linuxTemperature();
    else if (platform === 'darwin') value = darwinTemperature();
    else if (platform === 'win32') value = windowsTemperature();
  } catch {
    // A missing sensor must never break the health snapshot.
  }
  cached = { at: now, value };
  return value;
}

module.exports = { getTemperature };
