// BLE UUIDs müssen mit dem Arduino Code übereinstimmen
const SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214".toLowerCase();
const COMMAND_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214".toLowerCase();

let bleDevice;
let commandCharacteristic;
let isYellowFlagActive = false;
let eventSchedule = [];
let pollingInterval = null;
let currentRaceIndex = -1;

// --- BLE Connection ---
document.getElementById('btnConnect').addEventListener('click', async () => {
    try {
        console.log('Requesting Bluetooth Device...');
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
        console.error('Verbindung fehlgeschlagen', error);
        alert('Verbindung fehlgeschlagen: ' + error);
    }
});

function onDisconnected(event) {
    updateConnectionStatus(false);
    document.getElementById('main-content').style.display = 'none';
    if(pollingInterval) clearInterval(pollingInterval);
}

function updateConnectionStatus(connected) {
    const statusDiv = document.getElementById('connectionStatus');
    if (connected) {
        statusDiv.textContent = "Verbunden!";
        statusDiv.style.color = "#2ecc71";
    } else {
        statusDiv.textContent = "Getrennt";
        statusDiv.style.color = "#e74c3c";
    }
}

// --- Commands ---
async function sendCommand(cmdString) {
    if (!commandCharacteristic) return;
    try {
        const encoder = new TextEncoder();
        await commandCharacteristic.writeValue(encoder.encode(cmdString));
        console.log("Gesendet:", cmdString);
    } catch (error) {
        console.error("Sende Fehler:", error);
    }
}

function startManualRace() {
    const durStr = document.getElementById('duration-input').value;
    const preT = document.getElementById('preStartTime').value;
    
    // Zeit in Sekunden umrechnen
    const parts = durStr.split(':');
    let seconds = 0;
    if(parts.length === 3) seconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
    
    // 1. Parameter senden
    sendCommand(`/setRaceParams&dur=${seconds}&rnd=0`);
    
    // 2. Countdown Starten (Kurze Verzögerung damit Arduino verarbeitet)
    setTimeout(() => {
        sendCommand(`/startCountdown&preT=${preT}`);
    }, 200);
}

function sendText() {
    const txt = document.getElementById('myLEDText').value;
    sendCommand('/ledText=' + encodeURIComponent(txt));
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

// --- Driftclub Logik (Browser-basiert) ---

function loadGameIds() {
    const id = document.getElementById('myID').value;
    if(!id) return alert("ID eingeben!");
    
    // Reset
    if(pollingInterval) clearInterval(pollingInterval);
    eventSchedule = [];
    currentRaceIndex = -1;
    
    fetchDriftclubSession(id);
    
    // Starte Polling Loop (alle 5 Sekunden)
    pollingInterval = setInterval(() => {
        monitorSchedule();
    }, 5000);
}

async function fetchDriftclubSession(gameID) {
    // API Call Simulation für Driftclub Struktur
    // Hier musst du ggf. die genaue API Logik aus dem alten Script einfügen
    // Vereinfachtes Beispiel:
    const idParts = gameID.split('/');
    // Annahme ID Format: g/GRUPPE/EVENT/SESSION
    const url = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2F${idParts[0]}%2F${idParts[1]}%2F${idParts[2]}%2Fsession%2F${idParts[3] || ''}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        // Parsing Logik (wie im alten Script, nur hier in JS)
        if(data && data.setup) {
            const startTime = Math.floor(Date.parse(data.setup.startTime) / 1000);
            
            eventSchedule.push({
                name: data.name,
                startTime: startTime, // Unix Timestamp
                duration: data.setup.duration, // "HH:MM:SS"
                laps: data.setup.laps || 0,
                id: data._id
            });
            
            renderSchedule();
        }
    } catch(e) {
        console.log("Fehler beim Laden:", e);
        document.getElementById('state0').innerHTML = "Fehler API";
    }
}

function renderSchedule() {
    const list = document.getElementById('schedule-list');
    list.innerHTML = eventSchedule.map(s => 
        `<div class="schedule-item">
            <span>${s.name}</span>
            <span>${new Date(s.startTime*1000).toLocaleTimeString()}</span>
         </div>`
    ).join('');
}

// Diese Funktion läuft ständig im Hintergrund im Browser
function monitorSchedule() {
    if(eventSchedule.length === 0) return;
    
    const now = Math.floor(Date.now() / 1000);
    
    // Suche nächstes Rennen
    const nextRace = eventSchedule.find(r => r.startTime > now);
    
    if(nextRace) {
        const diff = nextRace.startTime - now;
        document.getElementById('state0').innerHTML = `Nächstes: ${nextRace.name} in ${diff}s`;
        
        // Sende Info an Arduino Matrix, wenn es z.B. noch 3 Minuten sind
        if(diff % 60 === 0 && diff <= 300) { // alle Minuten update
             sendCommand(`/msg=Start in ${diff/60} min`);
        }
        
        // AUTOMATISCHER START BEFEHL AN ARDUINO
        // Wir senden den Startbefehl z.B. 15 Sekunden vorher an die Ampel
        if(diff === 15) {
             // Duration parsen
             const dParts = nextRace.duration.split(':');
             const durSec = (+dParts[0])*3600 + (+dParts[1])*60 + (+dParts[2]);
             
             sendCommand(`/setRaceParams&dur=${durSec}&rnd=0`);
             setTimeout(() => {
                 sendCommand(`/startCountdown&preT=15`); // Startet exakt bei 0
             }, 500);
        }
    } else {
        document.getElementById('state0').innerHTML = "Keine anstehenden Rennen.";
    }
}
