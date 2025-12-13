// UUIDs (müssen mit Arduino übereinstimmen)
const SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";
const CHAR_CMD_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214";
const CHAR_STATE_UUID = "19b10002-e8f2-537e-4f6c-d104768a1214";

let bleDevice;
let cmdChar;
let stateChar;
let isConnected = false;
let isYellowFlagActive = false;
let timeSyncInterval = null;

// UI Helper
function $ID(id) { return document.getElementById(id); }
function printState(msg) { 
    if($ID("state0")) $ID("state0").innerHTML = msg; 
    if($ID("bleStatus")) $ID("bleStatus").innerText = msg;
}

// Wartet bis die Seite geladen ist, bevor Events registriert werden
document.addEventListener("DOMContentLoaded", function() {
    
    // --- Event Listeners für Buttons ---
    $ID("connectBleBtn").onclick = connectBLE;
    
    $ID("mStart").onclick = function() {
        const dur = timeToSeconds($ID('duration-input').value);
        const pre = parseInt($ID('preStartTime').value) + 2; 
        sendCommand(`/mStart&dur=${dur}&preT=${pre}`);
    };

    $ID("cancelBtn").onclick = function() {
        sendCommand('/cancel');
    };

    $ID("yellowFlagToggle").onclick = function() {
        const cmd = isYellowFlagActive ? '/yellowFlagOff' : '/yellowFlagOn';
        sendCommand(cmd);
        isYellowFlagActive = !isYellowFlagActive;
        this.innerText = isYellowFlagActive ? "YELLOW FLAG OFF" : "YELLOW FLAG ON";
        this.classList.toggle('active-state', isYellowFlagActive);
    };

    $ID("sendTextBtn").onclick = function() {
        sendCommand("/text=" + $ID("myLEDText").value);
    };
    
    $ID("sendGameIdsBtn").onclick = function() {
        const idsString = $ID("myID").value;
        if (!idsString) return printState("Bitte Game-IDs eingeben.");
        const ids = idsString.split(',').map(id => id.trim()).filter(id => id);
        if (ids.length === 0) return;
        
        // Globale Variablen für den API Prozess
        window.collectedSessions = [];
        window.totalIdsToProcess = ids.length;
        printState(`Lade ${ids.length} ID(s)...`);
        ids.forEach(id => driftclub(id));
    };

    $ID("sendEventLinkBtn").onclick = function() {
        const link = $ID("dcEventLink").value;
        if (link) fetchEventData(link);
        else printState("Bitte Event-Link eingeben.");
    };
    
    // Reset Inputs Button
    if($ID("resetInputsBtn")) {
        $ID("resetInputsBtn").onclick = function() {
            $ID("myID").value = "";
            $ID("dcEventLink").value = "";
            $ID("myLEDText").value = "";
            printState("Inputs zurückgesetzt");
        };
    }

    // --- Toggle Logik ---
    if($ID('expert-toggle')) {
        $ID('expert-toggle').addEventListener('change', function() {
            const content = $ID("expert-settings");
            if(content) content.style.display = this.checked ? "block" : "none";
        });
    }

    if($ID('manual-start-toggle')) {
        $ID('manual-start-toggle').addEventListener('change', function() {
            const content = $ID("manual-start-content");
            if(content) content.style.display = this.checked ? "block" : "none";
        });
    }

    // --- Settings Change Listeners ---
    // Diese Listener senden Änderungen an die Ampel.
    // WICHTIG: Sie sollten nicht feuern, wenn wir die Werte programmatisch per Bluetooth empfangen,
    // daher prüfen wir oft auf 'isTrusted' oder wir akzeptieren das "Echo".
    
    $ID("vol").onchange = function() { 
        sendCommand('/vol=' + this.value); 
        writeVolNum('volNum', this.value); 
    };
    $ID("mp3_Selection").onchange = function() {
        sendCommand('/mp3=' + this.value);
    };
    $ID("brt_led_matrix").onchange = function() { sendCommand('/brt_matrix=' + this.value); };
    $ID("brt_led_strip").onchange = function() { sendCommand('/brt_strip=' + this.value); };
    $ID("matrixSpeed").onchange = function() { sendCommand('/matrixSpeed=' + this.value); };
    $ID("soundDelay").onchange = function() { 
        const val = this.value; 
        sendCommand('/soundDelay=' + (val * 100)); 
        writeDelayNum('soundDelayNum', val * 100);
    };
});

// --- Bluetooth Logic ---

async function connectBLE() {
    if (isConnected) {
        if(bleDevice && bleDevice.gatt.connected) bleDevice.gatt.disconnect();
        return;
    }
    
    try {
        printState("Suche Gerät...");
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'DriftAmpel' }],
            optionalServices: [SERVICE_UUID]
        });

        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
        
        await connectToDevice(bleDevice);

    } catch (error) {
        console.error(error);
        printState("Verbindungsfehler: " + error.message);
    }
}

async function connectToDevice(device) {
    let attempt = 0;
    while(attempt < 3) {
        try {
            printState(`Verbinde (Versuch ${attempt+1})...`);
            const server = await device.gatt.connect();
            await new Promise(r => setTimeout(r, 1500)); 
            
            const service = await server.getPrimaryService(SERVICE_UUID);
            cmdChar = await service.getCharacteristic(CHAR_CMD_UUID);
            stateChar = await service.getCharacteristic(CHAR_STATE_UUID);

            await stateChar.startNotifications();
            stateChar.addEventListener('characteristicvaluechanged', (e) => {
                const dec = new TextDecoder();
                const text = dec.decode(e.target.value);
                // Aufruf der neuen Parsing-Funktion
                processIncomingData(text);
            });

            isConnected = true;
            $ID("connectBleBtn").innerHTML = "Trennen";
            $ID("connectBleBtn").classList.add("btn-green");
            printState("Verbunden!");
            
            // 1. Zeit-Synchro
            sendTimeSync();
            
            // 2. Einstellungen von Ampel anfordern (NEU)
            // Wir hoffen, dass der Arduino auf /getConf mit den Werten antwortet.
            setTimeout(() => sendCommand('/getConf'), 500);

            // Start Auto-Sync (Alle 5 Minuten)
            if(timeSyncInterval) clearInterval(timeSyncInterval);
            timeSyncInterval = setInterval(sendTimeSync, 300000);
            
            return;
        } catch(e) {
            console.warn(e);
            attempt++;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw new Error("Konnte nicht verbinden.");
}

function onDisconnected() {
    isConnected = false;
    $ID("connectBleBtn").innerHTML = "Bluetooth Verbinden";
    $ID("connectBleBtn").classList.remove("btn-green");
    printState("Getrennt");
    
    if(timeSyncInterval) {
        clearInterval(timeSyncInterval);
        timeSyncInterval = null;
    }
}

async function sendCommand(cmd) {
    if (!cmdChar) return;
    try {
        const enc = new TextEncoder();
        await cmdChar.writeValue(enc.encode(cmd));
        console.log("Sent:", cmd);
    } catch (e) {
        console.error(e);
        printState("Sende-Fehler");
    }
}

function sendTimeSync() {
    const now = Math.floor(Date.now() / 1000);
    sendCommand(`/setTime=${now}`);
    console.log("Auto-Sync Time sent:", now);
}

// --- Incoming Data Parser (NEU) ---
// Diese Funktion analysiert Text von der Ampel und setzt die UI-Elemente
function processIncomingData(text) {
    // Zeige Nachricht immer im Status an
    printState("Ampel: " + text);

    // Wir suchen nach Schlüsselwörtern im Text wie "vol=20", "brt_strip=5" etc.
    // Format-Annahme: Schlüssel=Wert (egal ob einzeln oder in einer langen Zeile)
    
    // Volume: vol=XX
    let match = text.match(/vol=(\d+)/);
    if(match) {
        const val = match[1];
        if($ID("vol")) {
            $ID("vol").value = val;
            writeVolNum('volNum', val);
        }
    }

    // Strip Brightness: brt_strip=X
    match = text.match(/brt_strip=(\d+)/);
    if(match && $ID("brt_led_strip")) {
        $ID("brt_led_strip").value = match[1];
    }

    // Matrix Brightness: brt_matrix=XX
    match = text.match(/brt_matrix=(\d+)/);
    if(match && $ID("brt_led_matrix")) {
        $ID("brt_led_matrix").value = match[1];
    }

    // Matrix Speed: matrixSpeed=XX
    match = text.match(/matrixSpeed=(\d+)/);
    if(match && $ID("matrixSpeed")) {
        $ID("matrixSpeed").value = match[1];
    }

    // Sound Delay: soundDelay=XXX (in ms)
    match = text.match(/soundDelay=(\d+)/);
    if(match && $ID("soundDelay")) {
        const ms = parseInt(match[1]);
        // Slider geht von 0-6, Hardware ist ms (Slider*100)
        const sliderVal = Math.round(ms / 100);
        $ID("soundDelay").value = sliderVal;
        writeDelayNum('soundDelayNum', ms);
    }

    // Stimme: mp3=X
    match = text.match(/mp3=(\d+)/);
    if(match && $ID("mp3_Selection")) {
        $ID("mp3_Selection").value = match[1];
    }
}

// --- Helper Functions ---

function timeToSeconds(timeString) {
  if (!timeString || typeof timeString !== 'string') return 0;
  const parts = timeString.split(':');
  if (parts.length !== 3) return 0;
  const [h, m, s] = parts.map(p => parseInt(p, 10));
  return h * 3600 + m * 60 + s;
}

function reMap(val, in_min, in_max, out_min, out_max) {
  return (val - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}

function writeVolNum(id, val) { $ID(id).innerHTML = "Volume: " + val; }
function writeDelayNum(id, val) { $ID(id).innerHTML = "S.Delay: " + val + "ms"; }


// --- API Logic (DriftClub) ---

// Globale vars am Fenster-Objekt definiert für Sicherheit
window.collectedSessions = [];
window.totalIdsToProcess = 0;

function driftclub(gameID) {
    const idArray = gameID.split('/');
    const group = idArray[1] || '';
    const event = idArray[2] || '';
    const sessionID = idArray[3] || '';
    const apiUrl = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2Fg%2F${group}%2F${event}%2Fsession%2F${sessionID}`;
    
    fetch(apiUrl)
    .then(res => res.json())
    .then(session => {
        if (!session.setup) return;
        let duration = 0; 
        if (session.setup.finishType !== 'laps' && session.setup.duration) {
             const parts = session.setup.duration.split(':');
             duration = (+parts[0])*3600 + (+parts[1])*60 + (+parts[2]);
        }
        
        window.collectedSessions.push({
            name: session.name,
            startTime: Math.floor(Date.parse(session.setup.startTime) / 1000),
            duration: duration,
            preStart: session.setup.startDelay || 10
        });
    })
    .catch(err => console.error(err))
    .finally(() => {
        window.totalIdsToProcess--;
        if (window.totalIdsToProcess <= 0) {
            window.collectedSessions.sort((a, b) => a.startTime - b.startTime);
            renderSchedule(window.collectedSessions);
        }
    });
}

async function fetchEventData(eventLink) {
    // Entferne führende/nachfolgende Slashes oder 'g/' falls doppelt
    const cleanLink = eventLink.replace(/^g\//, '');
    const apiUrl = `https://driftclub.com/api/event?eventRoute=g/${cleanLink}`; 
    try {
        const res = await fetch(apiUrl);
        const data = await res.json();
        const eventID = data._id || data.id;
        
        const sessionsRes = await fetch(`https://driftclub.com/api/event/children?eventID=${eventID}`);
        const sessionsData = await sessionsRes.json();
        
        const list = sessionsData.sessions.map(s => {
            return {
                name: s.name,
                startTime: Math.floor(Date.parse(s.setup.startTime) / 1000),
                duration: 300 
            };
        });
        renderSchedule(list);
    } catch(e) {
        printState("API Fehler: " + e.message);
    }
}

function renderSchedule(payload) {
    const list = $ID('schedule-list');
    list.innerHTML = '';
    if (!payload || !payload.length) { list.innerHTML = '<p>Keine Daten.</p>'; return; }
    
    payload.forEach((session, idx) => {
        const div = document.createElement('div');
        div.className = 'schedule-item';
        div.innerHTML = `
            <span class="name">${session.name}</span>
            <button onclick="startRace(${idx})">Start</button>
        `;
        list.appendChild(div);
    });
    window.currentSchedule = payload;
}

window.startRace = function(idx) {
    const race = window.currentSchedule[idx];
    sendCommand(`/text=${race.name}`);
    setTimeout(() => {
        sendCommand(`/mStart&dur=${race.duration}&preT=${10}`); 
    }, 500);
};
