const UUIDS = {
    SERVICE: "19b10000-e8f2-537e-4f6c-d104768a1214",
    CMD:     "19b10001-e8f2-537e-4f6c-d104768a1214",
    SET:     "19b10002-e8f2-537e-4f6c-d104768a1214",
    SCHED:   "19b10003-e8f2-537e-4f6c-d104768a1214",
    TIME:    "19b10005-e8f2-537e-4f6c-d104768a1214"
};

let device, server;
let chars = {};

// UI Elemente
const connectBtn = document.getElementById('connectBtn');
const statusMsg = document.getElementById('statusMessage');
const connectOverlay = document.getElementById('connectOverlay');
const mainUI = document.getElementById('mainUI');

connectBtn.addEventListener('click', connectBLE);

// Buttons Events
document.getElementById('cancelBtn').addEventListener('click', () => sendCmd("/cancel"));
document.getElementById('sendIdsBtn').addEventListener('click', fetchAndSendSchedule);
document.getElementById('sendTextBtn').addEventListener('click', () => {
    let txt = document.getElementById('myLEDText').value;
    sendCmd(`/ledText=${encodeURIComponent(txt)}`);
});
document.getElementById('mStartBtn').addEventListener('click', manualStart);
document.getElementById('rndStartBtn').addEventListener('click', manualRndStart);

// Settings Change Events
document.getElementById('vol').addEventListener('change', (e) => sendCmd(`/vol=${e.target.value}`));
document.getElementById('brt_led_matrix').addEventListener('change', (e) => sendCmd(`/brt_led_matrix=${e.target.value}`));
document.getElementById('greenOnOff').addEventListener('change', (e) => sendCmd(`/greenOnOff=${e.target.checked}`));


async function connectBLE() {
    try {
        statusMsg.innerText = "Suche Gerät...";
        device = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'DR!FT Ampel' }],
            optionalServices: [UUIDS.SERVICE]
        });

        device.addEventListener('gattserverdisconnected', onDisconnect);
        
        statusMsg.innerText = "Verbinde...";
        server = await device.gatt.connect();
        const service = await server.getPrimaryService(UUIDS.SERVICE);
        
        chars.cmd = await service.getCharacteristic(UUIDS.CMD);
        chars.set = await service.getCharacteristic(UUIDS.SET);
        chars.sched = await service.getCharacteristic(UUIDS.SCHED);
        chars.time = await service.getCharacteristic(UUIDS.TIME);

        // UI Umschalten
        connectOverlay.classList.add('hidden');
        mainUI.classList.remove('hidden');

        // Initialisierung
        await syncTime();
        await loadSettings();

    } catch (e) {
        console.error(e);
        statusMsg.innerText = "Fehler: " + e.message;
    }
}

function onDisconnect() {
    connectOverlay.classList.remove('hidden');
    mainUI.classList.add('hidden');
    statusMsg.innerText = "Verbindung getrennt.";
}

async function sendCmd(cmd) {
    if (!chars.cmd) return;
    const enc = new TextEncoder();
    await chars.cmd.writeValue(enc.encode(cmd));
}

async function syncTime() {
    // Aktuellen Unix Timestamp senden (Little Endian)
    const now = Math.floor(Date.now() / 1000);
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setUint32(0, now, true);
    await chars.time.writeValue(buffer);
    console.log("Zeit synchronisiert:", now);
}

async function loadSettings() {
    // Liest JSON vom Arduino
    const val = await chars.set.readValue();
    const dec = new TextDecoder();
    try {
        const json = JSON.parse(dec.decode(val));
        document.getElementById('myLEDText').value = json.LEDText || "";
        document.getElementById('vol').value = json.volume || 20;
        document.getElementById('brt_led_matrix').value = json.brt_led_matrix || 1;
        document.getElementById('greenOnOff').checked = json.greenLight || false;
    } catch(e) { console.log("Settings Load Error"); }
}

// --- Schedule Logik ---

async function fetchAndSendSchedule() {
    const idsInput = document.getElementById('myID').value;
    const ids = idsInput.split(',').map(s => s.trim()).filter(s => s);
    let sessions = [];

    document.getElementById('schedule-list').innerHTML = "<p>Lade Daten...</p>";

    for(let id of ids) {
        const parts = id.split('/');
        // Beispiel-API Aufruf (Anpassung an echte Driftclub API Struktur notwendig)
        const apiUrl = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2Fg%2F${parts[1]}%2F${parts[2]}%2Fsession%2F${parts[3]}`;
        
        try {
            const res = await fetch(apiUrl);
            const data = await res.json();
            if(data && data.setup) {
                let duration = 0;
                // Zeit parsen HH:MM:SS zu Sekunden
                if(data.setup.finishType !== 'laps' && data.setup.duration) {
                    const t = data.setup.duration.split(':');
                    duration = (+t[0])*3600 + (+t[1])*60 + (+t[2]);
                }

                sessions.push({
                    n: data.name.substring(0,30), // Name kürzen für Arduino
                    t: Math.floor(new Date(data.setup.startTime).getTime()/1000), // Startzeit
                    d: duration, // Dauer in Sek
                    dl: (data.setup.startDelay || 0) * 1000 // Delay in ms
                });
            }
        } catch(e) { console.error(e); }
    }

    if(sessions.length > 0) {
        sessions.sort((a,b) => a.t - b.t);
        renderScheduleList(sessions);
        await uploadScheduleToArduino(sessions);
    } else {
        document.getElementById('schedule-list').innerHTML = "<p>Keine Rennen gefunden.</p>";
    }
}

function renderScheduleList(sessions) {
    const list = document.getElementById('schedule-list');
    list.innerHTML = "";
    sessions.forEach(s => {
        const d = new Date(s.t * 1000);
        const timeStr = d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const div = document.createElement('div');
        div.className = 'schedule-item';
        div.innerHTML = `<span>${timeStr}</span> <span>${s.n}</span>`;
        list.appendChild(div);
    });
}

async function uploadScheduleToArduino(sessions) {
    // Protokoll: RESET -> Chunks -> PARSE
    // Wir senden JSON, aber minimiert: [{"n":"Name","t":123,"d":300,"dl":0}]
    
    await chars.sched.writeValue(new TextEncoder().encode("RESET"));
    
    const json = JSON.stringify(sessions);
    const chunkSize = 100; // BLE Limit beachten
    
    for (let i = 0; i < json.length; i += chunkSize) {
        const chunk = json.substring(i, i + chunkSize);
        await chars.sched.writeValue(new TextEncoder().encode(chunk));
        await new Promise(r => setTimeout(r, 50)); // Kleines Delay für Arduino Buffer
    }
    
    await chars.sched.writeValue(new TextEncoder().encode("PARSE"));
    alert("Zeitplan an Ampel übertragen!");
}

// --- Helper ---

function manualStart() {
    const durStr = document.getElementById('duration-input').value;
    const pre = document.getElementById('preStartTime').value;
    const p = durStr.split(':');
    const sec = (+p[0])*3600 + (+p[1])*60 + (+p[2]);
    sendCmd(`/mStart&dur=${sec}&preT=${parseInt(pre)+2}`);
}

function manualRndStart() {
    const durStr = document.getElementById('duration-input').value;
    const pre = document.getElementById('preStartTime').value;
    const p = durStr.split(':');
    const sec = (+p[0])*3600 + (+p[1])*60 + (+p[2]);
    // Random delay (z.B. 0-3 Sek) wird hier clientseitig als Dummy gesendet oder im Arduino berechnet
    // Das Original sendet "&rnd=..."
    const rnd = Math.floor(Math.random() * 30) * 100;
    sendCmd(`/rndStart&dur=${sec}&rnd=${rnd}&preT=${parseInt(pre)+2}`);
}
