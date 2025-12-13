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

// Event Listener
connectBtn.addEventListener('click', connectBLE);
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
document.getElementById('brt_led_strip').addEventListener('change', (e) => sendCmd(`/brt_led_strip=${e.target.value}`));
document.getElementById('greenOnOff').addEventListener('change', (e) => sendCmd(`/greenOnOff=${e.target.checked}`));
document.getElementById('soundOnOff').addEventListener('change', (e) => sendCmd(`/soundOnOff=${e.target.checked}`));
document.getElementById('pulseOnOff').addEventListener('change', (e) => sendCmd(`/pulseOnOff=${e.target.checked}`));


/**
 * HILFSFUNKTION: Exponential Backoff
 * Versucht eine Funktion mehrfach auszuführen, wenn sie fehlschlägt.
 * @param {number} max    Maximale Anzahl Versuche
 * @param {number} delay  Wartezeit in ms
 * @param {function} toTry Die auszuführende Funktion (Promise)
 */
async function exponentialBackoff(max, delay, toTry) {
    try {
        return await toTry();
    } catch (error) {
        if (max <= 0) throw error;
        console.log(`Verbindung fehlgeschlagen, neuer Versuch in ${delay}ms... (${max} übrig)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return exponentialBackoff(max - 1, delay * 2, toTry);
    }
}

async function connectBLE() {
    try {
        statusMsg.innerText = "Suche Gerät...";
        
        // 1. Gerät anfordern (Muss durch User-Klick ausgelöst werden)
        device = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'DR!FT Ampel' }],
            optionalServices: [UUIDS.SERVICE]
        });

        device.addEventListener('gattserverdisconnected', onDisconnect);
        
        statusMsg.innerText = "Verbinde...";

        // 2. Verbindungsaufbau mit Retry-Logik (3 Versuche)
        server = await exponentialBackoff(3, 500, async () => {
            // Falls noch verbunden, kurz trennen um sauberen State zu haben
            if (device.gatt.connected) {
                device.gatt.disconnect();
            }
            return await device.gatt.connect();
        });

        // 3. Services und Characteristics holen
        statusMsg.innerText = "Lade Dienste...";
        const service = await server.getPrimaryService(UUIDS.SERVICE);
        
        // Parallel laden für mehr Geschwindigkeit, aber einzeln fangen für Sicherheit
        const charPromises = [
            service.getCharacteristic(UUIDS.CMD).then(c => chars.cmd = c),
            service.getCharacteristic(UUIDS.SET).then(c => chars.set = c),
            service.getCharacteristic(UUIDS.SCHED).then(c => chars.sched = c),
            service.getCharacteristic(UUIDS.TIME).then(c => chars.time = c)
        ];

        await Promise.all(charPromises);

        // UI Umschalten
        connectOverlay.classList.add('hidden');
        mainUI.classList.remove('hidden');

        // Initialisierung
        await syncTime();
        await loadSettings();

    } catch (e) {
        console.error(e);
        statusMsg.innerText = "Fehler: " + e.message + " (Bitte neu versuchen)";
        // Falls wir halb verbunden waren, aufräumen
        if (device && device.gatt.connected) {
            device.gatt.disconnect();
        }
    }
}

function onDisconnect() {
    console.log("Gerät getrennt.");
    connectOverlay.classList.remove('hidden');
    mainUI.classList.add('hidden');
    statusMsg.innerText = "Verbindung getrennt. Bitte neu verbinden.";
    
    // Variablen bereinigen
    chars = {};
    server = null;
}

/**
 * Sendet Befehle robuster.
 * Prüft vorher, ob die Verbindung noch steht.
 */
async function sendCmd(cmd) {
    if (!device || !device.gatt.connected || !chars.cmd) {
        console.warn("Nicht verbunden, Befehl ignoriert:", cmd);
        alert("Verbindung verloren! Bitte neu verbinden.");
        onDisconnect();
        return;
    }
    
    try {
        const enc = new TextEncoder();
        await chars.cmd.writeValue(enc.encode(cmd));
    } catch (e) {
        console.error("Senden fehlgeschlagen:", e);
        if (e.message.includes("NetworkError") || e.message.includes("disconnected")) {
            onDisconnect();
        }
    }
}

async function syncTime() {
    if (!chars.time) return;
    try {
        const now = Math.floor(Date.now() / 1000);
        const buffer = new ArrayBuffer(4);
        new DataView(buffer).setUint32(0, now, true);
        await chars.time.writeValue(buffer);
        console.log("Zeit synchronisiert:", now);
    } catch (e) {
        console.error("Zeit Sync Fehler:", e);
    }
}

async function loadSettings() {
    if (!chars.set) return;
    try {
        const val = await chars.set.readValue();
        const dec = new TextDecoder();
        const json = JSON.parse(dec.decode(val));
        
        if (document.getElementById('myLEDText')) 
            document.getElementById('myLEDText').value = json.LEDText || "";
        if (document.getElementById('vol'))
            document.getElementById('vol').value = json.volume || 20;
        if (document.getElementById('brt_led_matrix'))
            document.getElementById('brt_led_matrix').value = json.brt_led_matrix || 1;
        if (document.getElementById('brt_led_strip'))
            document.getElementById('brt_led_strip').value = json.brt_led_strip || 25;
        if (document.getElementById('greenOnOff'))
            document.getElementById('greenOnOff').checked = json.greenLight || false;
        if (document.getElementById('soundOnOff'))
            document.getElementById('soundOnOff').checked = json.sound || false;
        if (document.getElementById('pulseOnOff'))
            document.getElementById('pulseOnOff').checked = json.pulse || false;
            
    } catch(e) { 
        console.log("Settings Load Error", e); 
    }
}

// --- Schedule Logik ---

async function fetchAndSendSchedule() {
    const idsInput = document.getElementById('myID').value;
    const ids = idsInput.split(',').map(s => s.trim()).filter(s => s);
    let sessions = [];

    const listEl = document.getElementById('schedule-list');
    listEl.innerHTML = "<p>Lade Daten...</p>";

    for(let id of ids) {
        if(id.length < 3) continue; 
        
        const parts = id.split('/');
        if (parts.length < 4) {
            console.warn("ID Format falsch:", id);
            continue;
        }

        const apiUrl = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2Fg%2F${parts[1]}%2F${parts[2]}%2Fsession%2F${parts[3]}`;
        
        try {
            const res = await fetch(apiUrl);
            if (!res.ok) throw new Error("API Fehler");
            const data = await res.json();
            
            if(data && data.setup) {
                let duration = 0;
                if(data.setup.finishType !== 'laps' && data.setup.duration) {
                    const t = data.setup.duration.split(':');
                    duration = (+t[0])*3600 + (+t[1])*60 + (+t[2]);
                }

                sessions.push({
                    n: data.name.substring(0,30), 
                    t: Math.floor(new Date(data.setup.startTime).getTime()/1000), 
                    d: duration, 
                    dl: (data.setup.startDelay || 0) * 1000 
                });
            }
        } catch(e) { 
            console.error("Fehler bei ID " + id, e); 
        }
    }

    if(sessions.length > 0) {
        sessions.sort((a,b) => a.t - b.t);
        renderScheduleList(sessions);
        await uploadScheduleToArduino(sessions);
    } else {
        listEl.innerHTML = "<p>Keine Rennen gefunden oder Fehler beim Laden.</p>";
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
    if (!device || !device.gatt.connected || !chars.sched) {
        alert("Nicht verbunden!");
        return;
    }

    try {
        await chars.sched.writeValue(new TextEncoder().encode("RESET"));
        
        const json = JSON.stringify(sessions);
        const chunkSize = 100; 
        
        for (let i = 0; i < json.length; i += chunkSize) {
            const chunk = json.substring(i, i + chunkSize);
            await chars.sched.writeValue(new TextEncoder().encode(chunk));
            await new Promise(r => setTimeout(r, 50)); 
        }
        
        await chars.sched.writeValue(new TextEncoder().encode("PARSE"));
        alert("Zeitplan an Ampel übertragen!");
    } catch (e) {
        console.error("Upload Fehler:", e);
        alert("Fehler beim Übertragen des Zeitplans.");
        if (!device.gatt.connected) onDisconnect();
    }
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
    const rnd = Math.floor(Math.random() * 30) * 100;
    sendCmd(`/rndStart&dur=${sec}&rnd=${rnd}&preT=${parseInt(pre)+2}`);
}
