// --- BLE Connection Logic ---
const UUIDS = {
    SERVICE: "19b10000-e8f2-537e-4f6c-d104768a1214",
    CMD:     "19b10001-e8f2-537e-4f6c-d104768a1214",
    SET:     "19b10002-e8f2-537e-4f6c-d104768a1214",
    SCHED:   "19b10003-e8f2-537e-4f6c-d104768a1214",
    TIME:    "19b10005-e8f2-537e-4f6c-d104768a1214"
};

let device, server, chars = {};
let isYellowFlagActive = false;

// WICHTIG: Eine globale Warteschlange für BLE-Befehle
let bleQueue = Promise.resolve();

// Connect Button Event
document.getElementById('connectBtn').addEventListener('click', async () => {
    try {
        $ID('bleStatus').innerText = "Suche Gerät...";
        device = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'DR!FT Ampel' }],
            optionalServices: [UUIDS.SERVICE]
        });
        
        $ID('bleStatus').innerText = "Verbinde...";
        device.addEventListener('gattserverdisconnected', onDisconnect);
        server = await device.gatt.connect();
        
        const service = await server.getPrimaryService(UUIDS.SERVICE);
        chars.cmd = await service.getCharacteristic(UUIDS.CMD);
        chars.set = await service.getCharacteristic(UUIDS.SET);
        chars.sched = await service.getCharacteristic(UUIDS.SCHED);
        chars.time = await service.getCharacteristic(UUIDS.TIME);

        document.getElementById('connectOverlay').classList.add('hidden');
        document.getElementById('mainContainer').classList.remove('hidden');
        
        // Zeit synchronisieren
        const now = Math.floor(Date.now() / 1000);
        const buffer = new ArrayBuffer(4);
        new DataView(buffer).setUint32(0, now, true);
        await chars.time.writeValue(buffer);

        // Einstellungen laden (erst wenn verbunden)
        loadSettingsFromBLE();

    } catch (e) {
        console.error(e);
        $ID('bleStatus').innerText = "Fehler: " + e.message;
    }
});

function onDisconnect() {
    document.getElementById('connectOverlay').classList.remove('hidden');
    document.getElementById('mainContainer').classList.add('hidden');
    $ID('bleStatus').innerText = "Verbindung verloren. Bitte neu verbinden.";
    chars = {};
}

// --- NEU: sendDataCmd mit Warteschlange ---
// Verhindert "GATT operation already in progress" Fehler
async function sendDataCmd(cmd) {
    if (!chars.cmd) return;

    // Wir hängen den neuen Befehl hinten an die Warteschlange an
    bleQueue = bleQueue.then(async () => {
        try {
            const enc = new TextEncoder();
            await chars.cmd.writeValue(enc.encode(cmd));
            
            // Lokales Feedback simulieren
            var text = cmd.replace("/", "");
            if (text.startsWith("mStart")) printState("Manueller Start");
            else if (text.startsWith("rndStart")) printState("Manueller RND Start");
            else printState(text);
        } catch (e) {
            console.error("Senden fehlgeschlagen für: " + cmd, e);
            // Optional: Zeige Fehler im Status an, wenn es wichtig ist
            // printState("Fehler: " + e.message);
        }
    });

    return bleQueue;
}

// Ersetzt loadData() für BLE
async function loadSettingsFromBLE() {
    if(!chars.set) return;
    printState("Lade Daten...");
    try {
        const val = await chars.set.readValue();
        const dec = new TextDecoder();
        let jsonStr = dec.decode(val);
        jsonStr = jsonStr.replace(/\0/g, ''); 
        
        const json = JSON.parse(jsonStr);
        
        $ID("myLEDText").value = json.LEDText || "";
        $ID("vol").value = json.sound ? json.volume : 0;
        writeVolNum("volNum", json.volume);
        $ID("mp3_Selection").value = json.mp3_Selection ? 1 : 0;
        $ID("greenOnOff").checked = json.greenLight;
        $ID("bGreenOffAfter5").checked = json.green_Off_5s;
        $ID("brt_led_matrix").value = json.brt_led_matrix;
        $ID("brt_led_strip").value = json.brt_led_strip;
        if(json.Version) $ID("version").innerText = json.Version;
        
        isYellowFlagActive = json.isYellowFlag;
        updateYellowFlagButton();
        printState("Daten geladen");
        
    } catch(e) { 
        console.error(e); 
        printState("Fehler beim Laden");
    }
}

// --- Hilfsfunktionen aus Original Webpages.h ---

function $ID(id) { return document.getElementById(id); }

function timeToSeconds(timeString) {
  if (!timeString || typeof timeString !== 'string') return 0;
  const parts = timeString.split(':');
  if (parts.length !== 3) return 0;
  const [hours, minutes, seconds] = parts.map(p => parseInt(p, 10));
  return hours * 3600 + minutes * 60 + seconds;
}

function writeVolNum(id, val) { $ID(id).innerHTML = "Volume: " + val; }
function printState(e) { if(e) $ID("state0").innerHTML = e; }

// --- Yellow Flag Logik ---
function toggleYellowFlag() {
  const command = isYellowFlagActive ? '/yellowFlagOff' : '/yellowFlagOn';
  sendDataCmd(command);
  isYellowFlagActive = !isYellowFlagActive;
  updateYellowFlagButton();
}

function updateYellowFlagButton() {
  const button = $ID('yellowFlagToggle');
  if (isYellowFlagActive) {
    button.textContent = 'YELLOW FLAG OFF';
    button.classList.add('active-state');
  } else {
    button.textContent = 'YELLOW FLAG ON';
    button.classList.remove('active-state');
  }
}

function handleCancel() {
    sendDataCmd('/cancel');
    $ID('schedule-list').innerHTML = '<p>Noch kein Zeitplan geladen.</p>';
    printState("Abbruch");
}

function sendText() {
  var txt = $ID("myLEDText").value.toUpperCase();
  sendDataCmd("/ledText=" + encodeURIComponent(txt));
}

// Dummy Funktion da BLE loadData anders regelt
function loadData() {
    $("#manual-start-content").hide();
    $(".expert").hide();
}

function loadFavData() {
    $ID("duration-input").value = "00:05:00";
    $ID("preStartTime").value = "10";
    printState("Inputs zurückgesetzt");
}


// --- JQuery UI Logik (Original) ---
$(document).ready(function() {
  $('#expert-toggle').on('change', function() { this.checked ? $(".expert").slideDown() : $(".expert").slideUp(); });
  $('#manual-start-toggle').on('change', function() { this.checked ? $("#manual-start-content").slideDown() : $("#manual-start-content").slideUp(); });
  
  // Validation logic
  $ID("duration-input").oninput = function() {
    $ID("duration-input").setCustomValidity('');
    if (!$ID("duration-input").reportValidity()) {
       // Disable buttons if invalid logic needed
    }
  };
});

// --- Schedule API & Upload Logik ---

let collectedSessions = [];
let totalIdsToProcess = 0;

function sendGameIds() {
    const idsString = $ID("myID").value;
    if (!idsString) return void printState("Bitte eine oder mehrere Game-IDs eingeben.");
    const ids = idsString.split(',').map(id => id.trim()).filter(id => id);
    if (ids.length === 0) return;
    collectedSessions = [];
    totalIdsToProcess = ids.length;
    printState(`Rufe Daten für ${totalIdsToProcess} ID(s) ab...`);
    ids.forEach(id => driftclub(id));
}

function sendEventLink() {
    const link = $ID("dcEventLink").value;
    if (link) fetchEventData(link);
    else printState("Bitte einen Event-Link eingeben.");
}

function driftclub(gameID) {
    const idArray = gameID.split('/');
    const group = idArray[1] || '';
    const event = idArray[2] || '';
    const sessionID = idArray[3] || '';
    const apiUrl = "https://driftclub.com/api/session?sessionRoute=%2Fevent%2Fg%2F" + group + "%2F" + event + "%2Fsession%2F" + sessionID;
    
    fetch(apiUrl)
    .then(res => res.json())
    .then(session => {
        if (!session.error && session.setup) {
            let duration = 0;
            if(session.setup.finishType !== 'laps') {
               const d = session.setup.duration.split(':');
               duration = (+d[0])*3600 + (+d[1])*60 + (+d[2]);
            }
            
            collectedSessions.push({
                name: session.name.substring(0,60),
                startTime: Math.floor(Date.parse(session.setup.startTime) / 1000),
                duration: duration,
                startDelay: (session.setup.startDelay || 0) * 1000,
                laps: (session.setup.finishType === 'laps' ? session.setup.laps : 0)
            });
        }
    })
    .catch(e => console.error(e))
    .finally(() => {
        if (--totalIdsToProcess === 0) {
            processAndUploadSessions();
        }
    });
}

async function fetchEventData(eventLink) {
    printState("Verarbeite Event-Link...");
    try {
        const routeApiUrl = `https://driftclub.com/api/event?eventRoute=/event/g/${eventLink}`;
        
        let response = await fetch(routeApiUrl);
        if (!response.ok) throw new Error("Event nicht gefunden");
        const eventData = await response.json();
        
        const sessionsApiUrl = `https://driftclub.com/api/event/children?eventID=${eventData._id || eventData.id}`;
        response = await fetch(sessionsApiUrl);
        const sessionData = await response.json();
        
        collectedSessions = sessionData.sessions.map(s => {
             const details = s.setup || {}; 
             let duration = 0;
             if(details.finishType !== 'laps' && details.duration) {
                 const d = details.duration.split(':');
                 duration = (+d[0])*3600 + (+d[1])*60 + (+d[2]);
             }
             return {
                 name: s.name.substring(0,60),
                 startTime: Math.floor(Date.parse(details.startTime || s.startTime) / 1000),
                 duration: duration,
                 startDelay: (details.startDelay || 0) * 1000,
                 laps: (details.finishType === 'laps' ? details.laps : 0)
             };
        });
        
        processAndUploadSessions();

    } catch (e) {
        printState("Fehler: " + e.message);
    }
}

function processAndUploadSessions() {
    if (collectedSessions.length > 0) {
        collectedSessions.sort((a, b) => a.startTime - b.startTime);
        renderSchedule(collectedSessions);
        uploadScheduleToBLE(collectedSessions);
    } else {
        printState("Keine Sessions gefunden.");
    }
}

function renderSchedule(sessions) {
    const list = $ID('schedule-list');
    list.innerHTML = "";
    sessions.forEach(s => {
        const d = new Date(s.startTime * 1000);
        const timeStr = d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const div = document.createElement('div');
        div.className = 'schedule-item';
        div.innerHTML = `<span class="time">${timeStr}</span> <span class="name">${s.name}</span>`;
        list.appendChild(div);
    });
}

async function uploadScheduleToBLE(sessions) {
    if (!chars.sched) return;
    printState("Sende Zeitplan an Ampel...");
    try {
        await chars.sched.writeValue(new TextEncoder().encode("RESET"));
        
        const json = JSON.stringify(sessions);
        const chunkSize = 100; 
        
        for (let i = 0; i < json.length; i += chunkSize) {
            const chunk = json.substring(i, i + chunkSize);
            await chars.sched.writeValue(new TextEncoder().encode(chunk));
            await new Promise(r => setTimeout(r, 30)); 
        }
        
        await chars.sched.writeValue(new TextEncoder().encode("PARSE"));
        printState("Zeitplan gesendet!");
    } catch (e) {
        console.error(e);
        printState("Upload Fehler");
    }
}
