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

// Wartet bis die Seite geladen ist
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
        
        collectedSessions = [];
        totalIdsToProcess = ids.length;
        printState(`Lade ${ids.length} ID(s)...`);
        ids.forEach(id => driftclub(id));
    };

    $ID("sendEventLinkBtn").onclick = function() {
        const link = $ID("dcEventLink").value;
        if (link) fetchEventData(link);
        else printState("Bitte Event-Link eingeben.");
    };

    // --- Toggle Logik für Panels ---
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

    // --- Settings Change Listeners (NEU: Checkboxen & Selects senden jetzt Daten) ---
    
    // Volume Slider
    $ID("vol").onchange = function() { 
        sendCommand('/vol=' + this.value); 
        writeVolNum('volNum', this.value); 
    };

    // LED Helligkeiten & Speed
    $ID("brt_led_matrix").onchange = function() { sendCommand('/brt_matrix=' + this.value); };
    $ID("brt_led_strip").onchange = function() { sendCommand('/brt_strip=' + this.value); };
    $ID("matrixSpeed").onchange = function() { sendCommand('/matrixSpeed=' + this.value); };

    // Sound Delay
    $ID("soundDelay").onchange = function() { 
        const val = this.value; 
        sendCommand('/soundDelay=' + (val * 100)); 
        writeDelayNum('soundDelayNum', val * 100);
    };

    // Stimme (Select)
    $ID("mp3_Selection").onchange = function() {
        sendCommand('/voice=' + this.value);
    };

    // Runden Anzeige (Select)
    $ID("Runden_Anzeige").onchange = function() {
        sendCommand('/lapDisp=' + this.value);
    };

    // Grün @ Go (Checkbox)
    $ID("greenOnOff").onchange = function() {
        // Sendet 1 für checked, 0 für unchecked
        sendCommand('/greenOn=' + (this.checked ? 1 : 0));
    };

    // Aus nach 5s (Checkbox)
    $ID("bGreenOffAfter5").onchange = function() {
        sendCommand('/greenOff5=' + (this.checked ? 1 : 0));
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
                const msg = dec.decode(e.target.value);
                
                // Prüfen ob es eine Settings-Antwort ist
                if (msg.startsWith("SET:")) {
                    parseSettingsString(msg);
                    printState("Einstellungen geladen");
                } else {
                    printState("Ampel: " + msg);
                }
            });

            isConnected = true;
            $ID("connectBleBtn").innerHTML = "Trennen";
            $ID("connectBleBtn").classList.add("btn-green");
            printState("Verbunden!");
            
            // Sofortige Zeit-Synchro
            sendTimeSync();
            
            // Einstellungen vom Arduino abrufen
            setTimeout(() => {
                sendCommand("/getSettings");
            }, 500);
            
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

// --- Helper Functions ---

function timeToSeconds(timeString) {
  if (!timeString || typeof timeString !== 'string') return 0;
  const parts = timeString.split(':');
  if (parts.length !== 3) return 0;
  const [h, m, s] = parts.map(p => parseInt(p, 10));
  return h * 3600 + m * 60 + s;
}

function writeVolNum(id, val) { $ID(id).innerHTML = "Volume: " + val; }
function writeDelayNum(id, val) { $ID(id).innerHTML = "S.Delay: " + val + "ms"; }

/**
 * Parst den Settings-String vom Arduino und setzt die UI-Elemente
 * Erwartetes Format: SET:vol=20;voice=0;grn=1;grn5=1;lap=0;str=4;mat=1;spd=60;del=0
 */
function parseSettingsString(data) {
    const cleanData = data.replace("SET:", "");
    const pairs = cleanData.split(';');
    
    pairs.forEach(pair => {
        const [key, valStr] = pair.split('=');
        const val = parseInt(valStr, 10);
        if (isNaN(val)) return;

        switch(key) {
            case 'vol':
                $ID("vol").value = val;
                writeVolNum('volNum', val);
                break;
            case 'voice':
                $ID("mp3_Selection").value = val;
                break;
            case 'lap': // lapDisp
                $ID("Runden_Anzeige").value = val;
                break;
            case 'grn': // greenOn
                $ID("greenOnOff").checked = (val === 1);
                break;
            case 'grn5': // greenOff5
                $ID("bGreenOffAfter5").checked = (val === 1);
                break;
            case 'str': // brt_strip
                $ID("brt_led_strip").value = val;
                break;
            case 'mat': // brt_matrix
                $ID("brt_led_matrix").value = val;
                break;
            case 'spd': // matrixSpeed
                $ID("matrixSpeed").value = val;
                break;
            case 'del': // soundDelay
                // Vom Arduino kommt raw ms (z.B. 200), Slider braucht index (2)
                $ID("soundDelay").value = val / 100;
                writeDelayNum('soundDelayNum', val);
                break;
        }
    });
}

// --- API Logic (DriftClub) ---

let collectedSessions = [];
let totalIdsToProcess = 0;

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
        
        collectedSessions.push({
            name: session.name,
            startTime: Math.floor(Date.parse(session.setup.startTime) / 1000),
            duration: duration,
            preStart: session.setup.startDelay || 10
        });
    })
    .catch(err => console.error(err))
    .finally(() => {
        totalIdsToProcess--;
        if (totalIdsToProcess === 0) {
            collectedSessions.sort((a, b) => a.startTime - b.startTime);
            renderSchedule(collectedSessions);
        }
    });
}

async function fetchEventData(eventLink) {
    const apiUrl = `https://driftclub.com/api/event?eventRoute=g/${eventLink}`; 
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
    if (!payload.length) { list.innerHTML = '<p>Keine Daten.</p>'; return; }
    
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
