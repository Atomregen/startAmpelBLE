// UUIDs (müssen zum Arduino passen)
const SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214".toLowerCase();
const COMMAND_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214".toLowerCase();

let bleDevice, commandChar;
let pollingInterval, timeSyncInterval;
let scheduledRaceID = null; // Um doppeltes Senden zu verhindern

// --- BLE Verbindung ---
document.getElementById('btnConnect').addEventListener('click', async () => {
    try {
        console.log("Starte Bluetooth Suche...");
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'DriftAmpel' }], optionalServices: [SERVICE_UUID]
        });
        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
        const server = await bleDevice.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        commandChar = await service.getCharacteristic(COMMAND_UUID);
        
        updateStatus(true);
        document.getElementById('main-content').style.display = 'block';
        
        // Sofort Zeit syncen, dann alle 60s
        syncTime();
        timeSyncInterval = setInterval(syncTime, 60000);
        
    } catch (e) { alert("Verbindungsfehler: " + e); console.error(e); }
});

function onDisconnected() {
    updateStatus(false);
    document.getElementById('main-content').style.display = 'none';
    clearInterval(pollingInterval);
    clearInterval(timeSyncInterval);
}

function updateStatus(connected) {
    const el = document.getElementById('connectionStatus');
    el.textContent = connected ? "Verbunden" : "Getrennt";
    el.style.color = connected ? "#4cd137" : "#e84118";
}

async function sendCommand(cmd) {
    if (!commandChar) return;
    try {
        console.log(`[BLE SEND] ${cmd}`); // LOG in Console
        await commandChar.writeValue(new TextEncoder().encode(cmd));
    } catch (e) { console.error("Sendefehler:", e); }
}

// --- ZEIT SYNCHRONISATION ---
function syncTime() {
    // Sendet aktuellen Unix-Timestamp an Arduino
    const nowUnix = Math.floor(Date.now() / 1000);
    sendCommand(`/syncTime?val=${nowUnix}`);
    
    const d = new Date();
    document.getElementById('timeSyncStatus').innerText = 
        `Letzter Sync: ${d.toLocaleTimeString()} (Unix: ${nowUnix})`;
    console.log(`[TIME SYNC] Gesendet: ${nowUnix}`);
}

// --- DRIFTCLUB LOGIK ---

function startDriftclubMonitor() {
    const ids = document.getElementById('myID').value;
    if(!ids) return alert("Bitte Game ID eingeben!");
    
    console.clear();
    console.log("--- MONITOR START ---");
    console.log("IDs:", ids);

    if(pollingInterval) clearInterval(pollingInterval);
    // Daten sofort und dann alle 2 Sekunden holen
    fetchData(ids);
    pollingInterval = setInterval(() => fetchData(ids), 2000);
}

async function fetchData(rawIds) {
    const idList = rawIds.split(',').map(s => s.trim());
    let allSessions = [];

    // 1. Daten holen (stumpf für alle IDs)
    for (const id of idList) {
        if(!id) continue;
        const p = id.split('/');
        // URL Bauen
        const url = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2F${p[0]}%2F${p[1]}%2F${p[2]}%2Fsession%2F${p[3]||''}`;
        
        try {
            const res = await fetch(url);
            const data = await res.json();
            
            // CONSOLE LOG DER ROHDATEN (Wunsch: Daten anzeigen)
            console.log(`[API RAW] ID: ${id}`, data);
            
            if(data && data.setup) {
                // Relevanten Daten extrahieren
                allSessions.push({
                    id: data._id,
                    name: data.name,
                    startTime: Math.floor(Date.parse(data.setup.startTime) / 1000), // Unix
                    duration: parseDuration(data.setup.duration), // in Sekunden
                    delay: data.setup.startDelay || 0,
                    rawTime: data.setup.startTime
                });
            }
        } catch (e) {
            console.error(`Fehler bei ID ${id}:`, e);
        }
    }

    // 2. Sortieren nach Startzeit
    allSessions.sort((a, b) => a.startTime - b.startTime);

    // 3. UI Liste updaten
    const listEl = document.getElementById('schedule-list');
    listEl.innerHTML = allSessions.map(s => `
        <div class="schedule-item">
            <span>${s.name}</span>
            <span>${new Date(s.startTime*1000).toLocaleTimeString()}</span>
        </div>
    `).join('');

    // 4. Nächstes Rennen finden & an Arduino senden
    checkAndSendNextRace(allSessions);
}

function checkAndSendNextRace(sessions) {
    const now = Math.floor(Date.now() / 1000);
    
    // Finde Rennen, das in der Zukunft liegt (oder gerade startet)
    // Toleranz: Rennen darf max 5 Minuten alt sein
    const next = sessions.find(s => s.startTime > (now - 300));
    
    if (next) {
        const diff = next.startTime - now;
        
        // UI Update
        document.getElementById('nextRaceName').innerText = next.name;
        document.getElementById('nextRaceTime').innerText = new Date(next.startTime*1000).toLocaleTimeString();
        
        let statusText = "";
        if(diff > 0) statusText = `Startet in ${diff}s`;
        else statusText = `Seit ${Math.abs(diff)}s aktiv`;
        document.getElementById('nextRaceCountdown').innerText = statusText;

        // --- ENTSCHEIDUNG: AN ARDUINO SENDEN? ---
        // Wir senden die Daten, wenn:
        // A) Es ein neues Rennen ist (ID check)
        // B) Das Rennen noch nicht vorbei ist
        
        if (scheduledRaceID !== next.id && diff > -next.duration) {
            console.log(`[NEUES RENNEN] Gefunden: ${next.name} um ${next.rawTime}`);
            
            // String bauen: /setRace?start=170000...&dur=300&name=Test
            // Arduino vergleicht dann selbst seine Zeit mit 'start'
            const cmd = `/setRace?start=${next.startTime}&dur=${next.duration}&name=Rennen`;
            
            sendCommand(cmd);
            scheduledRaceID = next.id; // Merken, damit wir nicht spammen
        }
        
    } else {
        document.getElementById('nextRaceName').innerText = "Keine Rennen";
        document.getElementById('nextRaceTime').innerText = "-";
        document.getElementById('nextRaceCountdown').innerText = "-";
    }
}

// Helfer: HH:MM:SS in Sekunden
function parseDuration(str) {
    if(!str) return 300; // Default 5 min
    const p = str.split(':');
    if(p.length === 3) return (+p[0])*3600 + (+p[1])*60 + (+p[2]);
    return 300;
}

// Helfer: Yellow Flag
let yel = false;
function toggleYellowFlag() {
    yel = !yel;
    sendCommand(yel ? '/yellowFlagOn' : '/yellowFlagOff');
    document.getElementById('btnYellow').style.background = yel ? "#e84118" : "#00a8ff";
}
