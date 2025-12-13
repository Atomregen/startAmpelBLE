const SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214".toLowerCase();
const COMMAND_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214".toLowerCase();

let bleDevice;
let commandCharacteristic;
let isYellowFlagActive = false;
let eventSchedule = [];
let pollingInterval = null;

// --- UI INIT ---
$(document).ready(function() {
    $(".expert").hide();
    
    // Toggle Event für Expert Mode
    $('#expert-toggle').on('change', function() {
        if(this.checked) $(".expert").slideDown();
        else $(".expert").slideUp();
    });

    // Toggle für Manual Start
    $('#manual-start-toggle').on('change', function() {
        if(this.checked) $("#manual-start-content").slideDown();
        else $("#manual-start-content").slideUp();
    });
});

// --- HELPER FUNCTIONS (aus Original) ---
function reMap(val, in_min, in_max, out_min, out_max) {
    return (val - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}

// Spezielle Sende-Funktionen für Mapping
function sendMatrixSpeed(val) {
    // Im Original: reMap(this.value, 100, 20, 20, 100) -> invertiert
    // Aber Slider in HTML ist schon 20-100. Senden wir direkt oder invertiert?
    // Original Code: /matrixSpeed=' + reMap(this.value, 100, 20, 20, 100)
    // Wenn Slider 100 ist -> Speed 20 (schnell). Wenn Slider 20 ist -> Speed 100 (langsam).
    let mapped = reMap(val, 100, 20, 20, 100); 
    sendCommand('/matrixSpeed=' + Math.round(mapped));
}

function sendSoundDelay(val) {
    // UI: 0-6. Arduino erwartet ms (0-600)
    // Original HTML: /soundDelay=' + reMap(this.value, 0, 6, 0, 600)
    let delayMs = reMap(val, 0, 6, 0, 600);
    // UI Anzeige Update (invertiert im Text im Original?)
    // Original Text: reMap(this.value, 6, 0, 0, -600) -> Das war komisch.
    // Wir zeigen einfach ms an.
    document.getElementById('soundDelayNum').innerText = "S.Delay: " + Math.round(delayMs) + "ms";
    sendCommand('/soundDelay=' + Math.round(delayMs));
}

// --- BLE Connection ---
document.getElementById('btnConnect').addEventListener('click', async () => {
    try {
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'DriftAmpel' }],
            optionalServices: [SERVICE_UUID]
        });
        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
        const server = await bleDevice.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        commandCharacteristic = await service.getCharacteristic(COMMAND_UUID);
        updateConnectionStatus(true);
        document.getElementById('main-content').style.display = 'block';
    } catch (error) {
        alert('Fehler: ' + error);
    }
});

function onDisconnected() {
    updateConnectionStatus(false);
    document.getElementById('main-content').style.display = 'none';
    if(pollingInterval) clearInterval(pollingInterval);
}

function updateConnectionStatus(connected) {
    const s = document.getElementById('connectionStatus');
    s.textContent = connected ? "Verbunden!" : "Getrennt";
    s.style.color = connected ? "#2ecc71" : "#e74c3c";
}

async function sendCommand(cmd) {
    if (!commandCharacteristic) return;
    try {
        await commandCharacteristic.writeValue(new TextEncoder().encode(cmd));
        console.log("Sent:", cmd);
    } catch (e) { console.error(e); }
}

// --- Race Logic ---
function startManualRace(random) {
    const durStr = document.getElementById('duration-input').value;
    const preT = document.getElementById('preStartTime').value;
    const parts = durStr.split(':');
    let seconds = 0;
    if(parts.length === 3) seconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
    
    // Random Start Delay
    let rnd = 0;
    if(random) rnd = Math.floor(Math.random() * 30) * 100; // 0-3000ms

    sendCommand(`/setRaceParams&dur=${seconds}&rnd=${rnd}`);
    setTimeout(() => sendCommand(`/startCountdown&preT=${preT}`), 200);
}

function sendText() {
    sendCommand('/ledText=' + encodeURIComponent(document.getElementById('myLEDText').value));
}

function toggleYellowFlag() {
    isYellowFlagActive = !isYellowFlagActive;
    const btn = document.getElementById('yellowFlagToggle');
    if(isYellowFlagActive) {
        sendCommand('/yellowFlagOn');
        btn.classList.add('active-state');
        btn.textContent = "YELLOW FLAG OFF";
    } else {
        sendCommand('/yellowFlagOff');
        btn.classList.remove('active-state');
        btn.textContent = "YELLOW FLAG ON";
    }
}

// --- Driftclub API (Minimal) ---
function loadGameIds() {
    const id = document.getElementById('myID').value;
    if(!id) return;
    fetchDriftclubSession(id);
    pollingInterval = setInterval(monitorSchedule, 5000);
}

async function fetchDriftclubSession(gameID) {
    const p = gameID.split('/');
    // ACHTUNG: Hier korrekte URL Logik einfügen falls nötig
    const url = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2F${p[0]}%2F${p[1]}%2F${p[2]}%2Fsession%2F${p[3]||''}`;
    try {
        const r = await fetch(url);
        const d = await r.json();
        if(d && d.setup) {
            eventSchedule.push({
                name: d.name,
                startTime: Math.floor(Date.parse(d.setup.startTime)/1000),
                duration: d.setup.duration
            });
            document.getElementById('schedule-list').innerHTML = `<div>${d.name} - ${new Date(eventSchedule[0].startTime*1000).toLocaleTimeString()}</div>`;
        }
    } catch(e) { console.log(e); }
}

function monitorSchedule() {
    if(!eventSchedule.length) return;
    const now = Math.floor(Date.now()/1000);
    const next = eventSchedule.find(r => r.startTime > now);
    if(next) {
        const diff = next.startTime - now;
        document.getElementById('state0').innerHTML = `Start in ${diff}s`;
        if(diff === 15) {
             const dp = next.duration.split(':');
             const s = (+dp[0])*3600 + (+dp[1])*60 + (+dp[2]);
             sendCommand(`/setRaceParams&dur=${s}&rnd=0`);
             setTimeout(() => sendCommand(`/startCountdown&preT=15`), 500);
        }
    }
}
