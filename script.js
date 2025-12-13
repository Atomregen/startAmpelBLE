/*
  DriftAmpel Web Controller
  Logik für BLE Kommunikation und DriftClub API Integration
*/

// --- KONFIGURATION ---

// UUIDs müssen exakt mit der Arduino Firmware übereinstimmen
const SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";
const CHAR_CMD_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214";
const CHAR_STATE_UUID = "19b10002-e8f2-537e-4f6c-d104768a1214";

// Globale Variablen
let bleDevice = null;
let cmdChar = null;
let stateChar = null;
let isConnected = false;
let scheduleData = []; // Speichert die geladenen Rennen
let autoSyncInterval = null;

// DOM Elemente cachen
const ui = {
    connectBtn: document.getElementById('connectBtn'),
    status: document.getElementById('status'),
    manualStartBtn: document.getElementById('manualStartBtn'),
    cancelBtn: document.getElementById('cancelBtn'),
    fetchApiBtn: document.getElementById('fetchApiBtn'),
    scheduleList: document.getElementById('scheduleList'),
    autoSyncParams: document.getElementById('autoSyncParams'),
    inputs: {
        raceMin: document.getElementById('raceMin'),
        raceSec: document.getElementById('raceSec'),
        preTime: document.getElementById('preTime'),
        driftClubId: document.getElementById('driftClubId'),
        ledText: document.getElementById('ledText'),
        volume: document.getElementById('volumeSlider'),
        matrixBrt: document.getElementById('matrixBrt'),
        stripBrt: document.getElementById('stripBrt')
    },
    buttons: {
        sendText: document.getElementById('sendTextBtn'),
        syncTime: document.getElementById('syncTimeBtn')
    }
};

// =============================================================================
// 1. BLUETOOTH LOW ENERGY (BLE) LOGIK
// =============================================================================

// Verbindung herstellen
ui.connectBtn.addEventListener('click', async () => {
    if (isConnected) {
        disconnect();
        return;
    }

    if (!navigator.bluetooth) {
        alert("Web Bluetooth wird von diesem Browser nicht unterstützt. Bitte nutze Chrome, Edge oder Bluefy.");
        return;
    }

    try {
        updateStatus("Suche nach DriftAmpel...", "loading");
        
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'DriftAmpel' }],
            optionalServices: [SERVICE_UUID]
        });

        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);

        updateStatus("Verbinde mit GATT Server...", "loading");
        const server = await bleDevice.gatt.connect();
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        updateStatus("Hole Services...", "loading");
        const service = await server.getPrimaryService(SERVICE_UUID);
        
        cmdChar = await service.getCharacteristic(CHAR_CMD_UUID);
        stateChar = await service.getCharacteristic(CHAR_STATE_UUID);

        // Notifications für Status-Updates vom Arduino aktivieren
        await stateChar.startNotifications();
        stateChar.addEventListener('characteristicvaluechanged', handleArduinoStatus);

        isConnected = true;
        onConnected();

    } catch (error) {
        console.error("Verbindungsfehler:", error);
        updateStatus("Fehler: " + error.message, "error");
    }
});

// Verbindung trennen
function disconnect() {
    if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
    }
}

// Callback wenn verbunden
function onConnected() {
    updateStatus("Verbunden!", "success");
    ui.connectBtn.innerHTML = '<i class="fas fa-check"></i> Trennen';
    ui.connectBtn.classList.replace('btn-primary', 'btn-success');
    enableControls(true);
    
    // Automatisch Zeit synchronisieren nach Verbindung
    setTimeout(sendTimeSync, 500);
}

// Callback wenn getrennt
function onDisconnected() {
    isConnected = false;
    updateStatus("Verbindung getrennt.", "error");
    ui.connectBtn.innerHTML = '<i class="fab fa-bluetooth"></i> Verbinden';
    ui.connectBtn.classList.replace('btn-success', 'btn-primary');
    enableControls(false);
    
    // Auto-Sync stoppen
    if (autoSyncInterval) clearInterval(autoSyncInterval);
}

// Befehl senden (String -> UTF8 Bytes)
async function sendCommand(str) {
    if (!cmdChar) return;
    try {
        const encoder = new TextEncoder();
        await cmdChar.writeValue(encoder.encode(str));
        console.log("TX:", str);
    } catch (e) {
        console.error("Sendefehler:", e);
        updateStatus("Sendefehler!", "error");
    }
}

// Status empfangen (UTF8 Bytes -> String)
function handleArduinoStatus(event) {
    const value = event.target.value;
    const decoder = new TextDecoder();
    const msg = decoder.decode(value);
    console.log("RX:", msg);
    updateStatus("Ampel: " + msg, "info");
}

// =============================================================================
// 2. STEUERUNGS-LOGIK (UI)
// =============================================================================

// Manuelle Zeit-Synchronisation (sendet aktuellen Unix Timestamp)
function sendTimeSync() {
    // Arduino erwartet Unix Timestamp (Sekunden)
    // Wir nutzen lokale Zeit, da Arduino im Code keine Zeitzonen-Logik mehr hat (optional)
    const now = Math.floor(Date.now() / 1000);
    sendCommand(`/setTime=${now}`);
    updateStatus("Zeit synchronisiert.", "success");
}

ui.buttons.syncTime.addEventListener('click', sendTimeSync);

// Manueller Start
ui.manualStartBtn.addEventListener('click', () => {
    const min = parseInt(ui.inputs.raceMin.value) || 0;
    const sec = parseInt(ui.inputs.raceSec.value) || 0;
    const pre = parseInt(ui.inputs.preTime.value) || 10;
    
    const durationSeconds = (min * 60) + sec;
    
    // Format: /mStart&dur=300&preT=10
    sendCommand(`/mStart&dur=${durationSeconds}&preT=${pre}`);
});

// Abbruch
ui.cancelBtn.addEventListener('click', () => {
    sendCommand('/cancel');
});

// Einstellungen (Debouncing nicht implementiert für Einfachheit, Slider feuern 'change')
ui.inputs.volume.addEventListener('change', (e) => sendCommand(`/vol=${e.target.value}`));
ui.inputs.matrixBrt.addEventListener('change', (e) => sendCommand(`/brt_matrix=${e.target.value}`));
ui.inputs.stripBrt.addEventListener('change', (e) => sendCommand(`/brt_strip=${e.target.value}`));

ui.buttons.sendText.addEventListener('click', () => {
    const text = ui.inputs.ledText.value;
    if(text) sendCommand(`/text=${text}`);
});

// UI Helfer
function updateStatus(text, type) {
    ui.status.innerText = text;
    ui.status.className = "status-bar " + type; // CSS Klassen nutzen
}

function enableControls(enabled) {
    const elements = [
        ui.manualStartBtn, ui.cancelBtn, ui.buttons.sendText, ui.buttons.syncTime,
        ui.inputs.volume, ui.inputs.matrixBrt, ui.inputs.stripBrt
    ];
    elements.forEach(el => el.disabled = !enabled);
}

// =============================================================================
// 3. DRIFTCLUB API LOGIK
// =============================================================================

ui.fetchApiBtn.addEventListener('click', () => {
    const inputId = ui.inputs.driftClubId.value.trim();
    if (!inputId) {
        alert("Bitte eine Game ID oder einen Event-Link eingeben (z.B. g/Gruppe/Event).");
        return;
    }
    fetchDriftClubData(inputId);
});

/**
 * Holt Daten von der DriftClub API.
 * Annahme: Keine CORS Probleme (wie angefordert).
 */
async function fetchDriftClubData(pathInput) {
    updateStatus("Lade Daten von DriftClub...", "loading");
    ui.scheduleList.innerHTML = '<p class="placeholder">Lade...</p>';
    scheduleData = []; // Reset

    try {
        // Bereinigen des Inputs
        let route = pathInput;
        if (!route.startsWith("g/")) {
            // Falls User vollen Link kopiert hat
            if (route.includes("/event/")) {
                route = route.split("/event/")[1];
            }
        }
        
        // 1. Event ID holen
        const eventApiUrl = `https://driftclub.com/api/event?eventRoute=${route}`;
        const eventResp = await fetch(eventApiUrl);
        
        if (!eventResp.ok) throw new Error(`Event nicht gefunden (HTTP ${eventResp.status})`);
        const eventData = await eventResp.json();
        
        const eventId = eventData._id || eventData.id;
        if (!eventId) throw new Error("Keine Event-ID in Antwort gefunden.");

        // 2. Sessions (Rennen) holen
        const sessionApiUrl = `https://driftclub.com/api/event/children?eventID=${eventId}`;
        const sessionResp = await fetch(sessionApiUrl);
        
        if (!sessionResp.ok) throw new Error("Sessions konnten nicht geladen werden.");
        const sessionData = await sessionResp.json();

        if (!sessionData.sessions || sessionData.sessions.length === 0) {
            throw new Error("Keine Sessions in diesem Event gefunden.");
        }

        // 3. Daten verarbeiten und speichern
        processSessions(sessionData.sessions);

    } catch (error) {
        console.error("API Fehler:", error);
        ui.scheduleList.innerHTML = `<p class="error">Fehler: ${error.message}</p>`;
        updateStatus("API Fehler", "error");
    }
}

function processSessions(sessions) {
    // Sortieren nach Startzeit
    sessions.sort((a, b) => new Date(a.setup.startTime) - new Date(b.setup.startTime));

    scheduleData = sessions.map(s => {
        // Dauer berechnen (DriftClub liefert hh:mm:ss string)
        let durationSec = 300; // Fallback 5 min
        if (s.setup.duration) {
            const parts = s.setup.duration.split(':');
            durationSec = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
        }
        
        return {
            id: s._id,
            name: s.name,
            startTime: new Date(s.setup.startTime), // JS Date Objekt
            duration: durationSec,
            laps: s.setup.laps || 0,
            startDelay: s.setup.startDelay || 0,
            status: 'pending' // pending, started
        };
    });

    renderScheduleList();
    updateStatus(`${scheduleData.length} Rennen geladen.`, "success");
    
    // Auto-Sync Überwachung starten
    startAutoSyncMonitor();
}

function renderScheduleList() {
    ui.scheduleList.innerHTML = '';
    
    if (scheduleData.length === 0) {
        ui.scheduleList.innerHTML = '<p class="placeholder">Keine Rennen verfügbar.</p>';
        return;
    }

    scheduleData.forEach((race, index) => {
        const item = document.createElement('div');
        item.className = 'schedule-item';
        
        const timeStr = race.startTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const durStr = race.laps > 0 ? `${race.laps} Runden` : `${Math.floor(race.duration/60)} Min`;

        item.innerHTML = `
            <div class="race-info">
                <span class="race-time">${timeStr}</span>
                <span class="race-name">${race.name}</span>
                <span class="race-dur">(${durStr})</span>
            </div>
            <button class="btn-small btn-primary" onclick="triggerRaceByIndex(${index})">
                <i class="fas fa-play"></i> Start
            </button>
        `;
        ui.scheduleList.appendChild(item);
    });
}

// Global verfügbar machen für HTML onclick
window.triggerRaceByIndex = function(index) {
    const race = scheduleData[index];
    if (!race) return;

    if (!isConnected) {
        alert("Bitte erst mit Bluetooth verbinden!");
        return;
    }

    if (confirm(`Rennen "${race.name}" jetzt starten?`)) {
        startRaceCommand(race);
    }
};

function startRaceCommand(race) {
    // Vorlaufzeit aus Input nehmen oder Standard 10s
    const preT = parseInt(ui.inputs.preTime.value) || 10;
    
    // Text auf Matrix senden
    sendCommand(`/text=${race.name}`);
    
    // Kurze Verzögerung, dann Startkommando
    setTimeout(() => {
        // Befehl an Arduino senden
        sendCommand(`/mStart&dur=${race.duration}&preT=${preT}`);
        
        // UI markieren
        race.status = 'started';
        updateStatus(`Rennen "${race.name}" gestartet!`, "success");
    }, 500);
}

// =============================================================================
// 4. AUTOMATISIERUNG (Auto-Trigger)
// =============================================================================

function startAutoSyncMonitor() {
    if (autoSyncInterval) clearInterval(autoSyncInterval);

    autoSyncInterval = setInterval(() => {
        // Nur wenn Checkbox aktiv und BLE verbunden
        if (!ui.autoSyncParams.checked || !isConnected) return;

        const now = new Date();
        const preT = parseInt(ui.inputs.preTime.value) || 10;

        scheduleData.forEach(race => {
            if (race.status !== 'pending') return;

            // Berechne Trigger-Zeitpunkt: Startzeit MINUS Vorlaufzeit
            // Beispiel: Start 14:00:00, PreTime 10s -> Trigger um 13:59:50
            const triggerTime = new Date(race.startTime.getTime() - (preT * 1000));
            
            // Toleranzbereich von 2 Sekunden, damit wir den Trigger nicht verpassen
            const diff = Math.abs(now - triggerTime);

            if (diff < 2000) { // Wenn wir im 2-Sekunden-Fenster sind
                console.log("Auto-Trigger für Rennen:", race.name);
                startRaceCommand(race);
            }
        });
    }, 1000); // Jede Sekunde prüfen

}
