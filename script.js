// UUIDs (müssen mit Arduino übereinstimmen)
const SRV_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";
const CHAR_CMD = "19b10001-e8f2-537e-4f6c-d104768a1214";
const CHAR_SET = "19b10002-e8f2-537e-4f6c-d104768a1214";
const CHAR_SCH = "19b10003-e8f2-537e-4f6c-d104768a1214";
const CHAR_STA = "19b10004-e8f2-537e-4f6c-d104768a1214";
const CHAR_TIM = "19b10005-e8f2-537e-4f6c-d104768a1214";

let device, server;
let cCmd, cSet, cSch, cSta, cTim;
let isYellow = false;
let pollingInterval;
let activeSchedule = [];

// DOM Elements
const connectBtn = document.getElementById('connectBtn');
const statusInd = document.getElementById('statusIndicator');
const panel = document.getElementById('controlPanel');
const feedback = document.getElementById('deviceFeedback');

connectBtn.addEventListener('click', connectBLE);

// Event Listeners UI
document.getElementById('yellowFlagBtn').addEventListener('click', toggleYellow);
document.getElementById('manualStartBtn').addEventListener('click', manualStart);
document.getElementById('cancelBtn').addEventListener('click', () => sendCmd("/cancel"));
document.getElementById('setLedTextBtn').addEventListener('click', () => {
    sendCmd(`/ledText=${encodeURIComponent(document.getElementById('ledTextInput').value)}`);
});
document.getElementById('fetchScheduleBtn').addEventListener('click', fetchSchedule);

// Sliders (Debounced change)
document.getElementById('brtMatrix').addEventListener('change', (e) => sendCmd(`/brt_led_matrix=${e.target.value}`));
document.getElementById('volMp3').addEventListener('change', (e) => sendCmd(`/vol=${e.target.value}`));


async function connectBLE() {
    try {
        device = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'DR!FT Ampel' }],
            optionalServices: [SRV_UUID]
        });

        device.addEventListener('gattserverdisconnected', onDisconnect);
        statusInd.innerText = "● Verbinde...";
        
        server = await device.gatt.connect();
        const service = await server.getPrimaryService(SRV_UUID);
        
        // Characteristics holen
        cCmd = await service.getCharacteristic(CHAR_CMD);
        cSet = await service.getCharacteristic(CHAR_SET);
        cSch = await service.getCharacteristic(CHAR_SCH);
        cSta = await service.getCharacteristic(CHAR_STA);
        cTim = await service.getCharacteristic(CHAR_TIM);

        // Notifications für Status
        await cSta.startNotifications();
        cSta.addEventListener('characteristicvaluechanged', (e) => {
            const dec = new TextDecoder();
            feedback.innerText = dec.decode(e.target.value);
        });

        // Init Sequence
        await syncTime();
        await loadSettings();

        onConnect();
    } catch (err) {
        console.error(err);
        alert("Verbindung fehlgeschlagen: " + err.message);
    }
}

function onConnect() {
    statusInd.innerText = "● Verbunden";
    statusInd.classList.replace('disconnected', 'connected');
    document.getElementById('connectionSection').classList.add('hidden');
    panel.classList.remove('hidden');
    
    // Starte Polling Loop (alle 5s)
    pollingInterval = setInterval(pollActiveRace, 5000);
}

function onDisconnect() {
    statusInd.innerText = "● Getrennt";
    statusInd.classList.replace('connected', 'disconnected');
    document.getElementById('connectionSection').classList.remove('hidden');
    panel.classList.add('hidden');
    clearInterval(pollingInterval);
}

async function syncTime() {
    // Sende aktuellen Unix Timestamp (little endian)
    const now = Math.floor(Date.now() / 1000);
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setUint32(0, now, true);
    await cTim.writeValue(buffer);
}

async function sendCmd(cmd) {
    if(!cCmd) return;
    const enc = new TextEncoder();
    await cCmd.writeValue(enc.encode(cmd));
}

async function loadSettings() {
    const val = await cSet.readValue();
    const dec = new TextDecoder();
    try {
        const json = JSON.parse(dec.decode(val));
        document.getElementById('ledTextInput').value = json.LEDText || "";
        document.getElementById('brtMatrix').value = json.brtM || 1;
        document.getElementById('volMp3').value = json.vol || 20;
        isYellow = json.isY || false;
        updateYellowBtn();
    } catch(e) { console.log("JSON Parse Error Settings"); }
}

function toggleYellow() {
    if(isYellow) sendCmd("/yellowFlagOff");
    else sendCmd("/yellowFlagOn");
    isYellow = !isYellow;
    updateYellowBtn();
}

function updateYellowBtn() {
    const btn = document.getElementById('yellowFlagBtn');
    btn.innerText = isYellow ? "Yellow Flag OFF" : "Yellow Flag ON";
    btn.style.backgroundColor = isYellow ? "#ef4444" : "#eab308";
}

function manualStart() {
    const durStr = document.getElementById('manDuration').value;
    const pre = document.getElementById('manPreStart').value;
    // Duration String zu Sekunden
    const p = durStr.split(':');
    const sec = (+p[0]) * 3600 + (+p[1]) * 60 + (+p[2]);
    sendCmd(`/mStart&dur=${sec}&preT=${parseInt(pre)+2}`);
}

// --- Schedule & API Logic ---

async function fetchSchedule() {
    const idsInput = document.getElementById('gameIDs').value;
    const eventInput = document.getElementById('eventLink').value;
    let sessions = [];

    feedback.innerText = "Lade Daten...";

    // Logik für Event-Link Auflösung wäre hier ähnlich wie im Original
    // Wir fokussieren uns hier auf direkte Game-IDs für Stabilität
    const ids = idsInput.split(',').map(s => s.trim()).filter(s => s);

    for(let id of ids) {
        // ID Format Analyse: g/GROUP/EVENT/SESSION
        const parts = id.split('/');
        // Fallback wenn direkte ID
        let apiUrl = "";
        if(parts.length >= 4) {
            apiUrl = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2Fg%2F${parts[1]}%2F${parts[2]}%2Fsession%2F${parts[3]}`;
        } else {
             // Versuche direkte Session ID Abfrage wenn API das erlaubt, sonst Error
             continue; 
        }

        try {
            const res = await fetch(apiUrl);
            const data = await res.json();
            if(data && data.setup) {
                sessions.push({
                    name: data.name,
                    sessionID: data._id,
                    startTime: Math.floor(new Date(data.setup.startTime).getTime()/1000),
                    duration: data.setup.finishType === 'laps' ? "00:00:00" : data.setup.duration,
                    laps: data.setup.laps || 0,
                    startDelay: data.setup.startDelay || 0
                });
            }
        } catch(e) { console.error(e); }
    }

    if(sessions.length > 0) {
        sessions.sort((a,b) => a.startTime - b.startTime);
        activeSchedule = sessions;
        document.getElementById('schedulePreview').innerText = `${sessions.length} Rennen geladen.`;
        await uploadSchedule(sessions);
    } else {
        feedback.innerText = "Keine Rennen gefunden.";
    }
}

async function uploadSchedule(sessions) {
    feedback.innerText = "Sende Zeitplan...";
    
    // 1. Reset
    await cSch.writeValue(new TextEncoder().encode("RESET"));
    
    // 2. Sende JSON in 100-Byte Chunks
    const json = JSON.stringify(sessions);
    const chunkSize = 100;
    
    for (let i = 0; i < json.length; i += chunkSize) {
        const chunk = json.substring(i, i + chunkSize);
        await cSch.writeValue(new TextEncoder().encode(chunk));
        await new Promise(r => setTimeout(r, 30)); // Kurze Pause für Arduino Buffer
    }
    
    // 3. Parse Command
    await cSch.writeValue(new TextEncoder().encode("PARSE"));
}

// --- Polling Logic ---
async function pollActiveRace() {
    if(!activeSchedule.length) return;

    const now = Math.floor(Date.now()/1000);
    // Finde aktives Rundenrennen
    // Ein Rennen ist aktiv, wenn Startzeit vorbei ist UND es ein Rundenrennen ist (laps > 0)
    // und es noch nicht als 'finished' markiert wurde (das wissen wir lokal nicht, also Zeitfenster)
    
    const active = activeSchedule.find(s => 
        s.laps > 0 && 
        now >= s.startTime && 
        now < (s.startTime + 7200) // Annahme: Rennen dauert max 2h
    );

    if(active) {
        try {
            const res = await fetch(`https://driftclub.com/api/leaderboard/session?sessionID=${active.sessionID}`);
            const data = await res.json();
            
            if(data && data[0]) {
                // Status Prüfung
                if(data[0].state === 'finished') {
                    await sendCmd("raceOver");
                    // Entferne aus active Schedule um Polling zu stoppen
                    activeSchedule = activeSchedule.filter(s => s !== active);
                } else if (data[0].overall) {
                    const driven = data[0].overall.drivenLaps || 0;
                    await sendCmd(`/updateLaps=${driven}`);
                }
            }
        } catch(e) { console.log("Poll Fehler"); }
    }
}
