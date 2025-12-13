// --- KONFIGURATION ---
const SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214".toLowerCase();
const COMMAND_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214".toLowerCase();

// Globale Variablen
let bleDevice;
let commandChar;
let timeSyncInterval;
let pollingInterval;
let isYellowFlagActive = false;
let isWriting = false;

// --- INITIALISIERUNG ---
$(document).ready(function() {
    $("#manual-start-content").hide();
    $(".expert").hide();
    $('#expert-toggle').on('change', function() { if (this.checked) $(".expert").slideDown(); else $(".expert").slideUp(); });
    $('#manual-start-toggle').on('change', function() { if (this.checked) $("#manual-start-content").slideDown(); else $("#manual-start-content").slideUp(); });
});

// --- HELFER ---
function $ID(id) { return document.getElementById(id); }
function reMap(val, in_min, in_max, out_min, out_max) { return (val - in_min) * (out_max - out_min) / (in_max - in_min) + out_min; }
function writeVolNum(id, val) { $ID(id).innerHTML = "Volume: " + val; }
function writeDelayNum(id, val) { $ID(id).innerHTML = "S.Delay: " + Math.round(val) + "ms"; }
function printState(msg) { if(msg) $ID("state0").innerHTML = msg; }
function cleanString(str) { if(!str) return "Rennen"; return str.replace(/[^a-zA-Z0-9 \-.:]/g, "").substring(0, 20); }

// --- BLE ---
async function connectBLE() {
    try {
        printState("Suche Ampel...");
        bleDevice = await navigator.bluetooth.requestDevice({ filters: [{ name: 'DriftAmpel' }], optionalServices: [SERVICE_UUID] });
        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
        const server = await bleDevice.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        commandChar = await service.getCharacteristic(COMMAND_UUID);
        $ID('bleState').innerHTML = "Verbunden"; $ID('bleState').style.color = "#4cd137";
        $ID('main-content').style.display = 'block'; $ID('btnConnect').style.display = 'none';
        printState("Bereit.");
        syncTime();
        timeSyncInterval = setInterval(syncTime, 60000);
    } catch (e) { alert("Verbindung fehlgeschlagen: " + e); printState("Verbindungsfehler"); console.error(e); }
}

function onDisconnected() {
    $ID('bleState').innerHTML = "Getrennt"; $ID('bleState').style.color = "#e74c3c";
    $ID('main-content').style.display = 'none'; $ID('btnConnect').style.display = 'block';
    clearInterval(timeSyncInterval); clearInterval(pollingInterval);
    printState("Verbindung verloren");
}

if($ID('btnConnect')) $ID('btnConnect').addEventListener('click', connectBLE);

async function sendDataCmd(cmd) {
    if (!commandChar) return;
    while(isWriting) { await new Promise(r => setTimeout(r, 20)); }
    try {
        isWriting = true;
        console.log(`[TX] ${cmd}`);
        await commandChar.writeValue(new TextEncoder().encode(cmd));
        await new Promise(r => setTimeout(r, 60)); 
    } catch (e) { console.error("Sende-Fehler:", e); } finally { isWriting = false; }
}

function syncTime() { const unix = Math.floor(Date.now() / 1000); sendDataCmd(`/syncTime?val=${unix}`); }

// --- Features ---
function sendText() { sendDataCmd("/ledText=" + cleanString($ID("myLEDText").value)); }
function toggleYellowFlag() {
    isYellowFlagActive = !isYellowFlagActive;
    const btn = $ID('yellowFlagToggle');
    if(isYellowFlagActive) { sendDataCmd('/yellowFlagOn'); btn.textContent = 'YELLOW FLAG OFF'; btn.classList.add('active-state'); }
    else { sendDataCmd('/yellowFlagOff'); btn.textContent = 'YELLOW FLAG ON'; btn.classList.remove('active-state'); }
}
function manualStart(random) {
    const durStr = $ID('duration-input').value;
    const preT = $ID('preStartTime').value;
    const parts = durStr.split(':');
    let s = 300;
    if(parts.length === 3) s = (+parts[0])*3600 + (+parts[1])*60 + (+parts[2]);
    let rnd = 0;
    if(random) rnd = Math.floor(Math.random() * 30) * 100;
    sendDataCmd(`/startSequence&dur=${s}&rnd=${rnd}&pre=${preT}`);
}

// --- DRIFTCLUB AUTOMATIK ---

// 1. Variante: Direkte Game IDs
function loadGameIds() {
    const ids = $ID("myID").value;
    if(!ids) return alert("Bitte Game ID eingeben!");
    if(pollingInterval) clearInterval(pollingInterval);
    
    // Wir nutzen eine anonyme Wrapper-Funktion für das Intervall
    const task = () => fetchAndUpload(ids, 'direct');
    task(); // Sofort einmal ausführen
    pollingInterval = setInterval(task, 120000); 
}

// 2. Variante: Event Link
async function loadEventData() {
    const link = $ID("dcEventLink").value;
    if(!link) return alert("Bitte Event-Link eingeben!");
    
    // Wir müssen erst die Event-ID ermitteln
    printState("Suche Event...");
    try {
        // Original Logik: URL Parsen um Pfad zu finden
        // Annahme Input: "gruppe/event" oder ganze URL
        let path = link;
        try {
            const urlObj = new URL(link);
            // Wenn ganze URL, nehmen wir den Pfad, aber Driftclub braucht oft spezielles Format
            // Einfachheitshalber nehmen wir an User gibt "Group/Event" ein wie im Placeholder
        } catch(e) { /* War keine volle URL, alles gut */ }
        
        // Slash am Anfang entfernen falls da
        if(path.startsWith("/")) path = path.substring(1);
        
        // 1. Event ID holen
        const eventInfoUrl = `https://driftclub.com/api/event?eventRoute=%2Fevent%2Fg%2F${encodeURIComponent(path)}`;
        const r1 = await fetch(eventInfoUrl);
        if(!r1.ok) throw new Error("Event nicht gefunden");
        const eventData = await r1.json();
        const eventID = eventData._id || eventData.id;
        
        if(!eventID) throw new Error("Keine Event ID in Antwort");
        
        printState(`Event gefunden: ${eventData.name}`);
        
        // 2. Monitoring starten mit dieser EventID (Modus 'event')
        if(pollingInterval) clearInterval(pollingInterval);
        const task = () => fetchAndUpload(eventID, 'event');
        task();
        pollingInterval = setInterval(task, 120000);
        
    } catch(e) {
        console.error(e);
        printState("Fehler: Event nicht gefunden");
    }
}

// Gemeinsame Upload Funktion
async function fetchAndUpload(identifier, mode) {
    printState("Lade Daten...");
    let allSessions = [];

    try {
        if (mode === 'direct') {
            // IDs kommagetrennt
            const idList = identifier.split(',').map(s => s.trim());
            for (const id of idList) {
                if(!id) continue;
                const p = id.split('/');
                const url = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2F${p[0]}%2F${p[1]}%2F${p[2]}%2Fsession%2F${p[3]||''}`;
                const res = await fetch(url);
                const data = await res.json();
                processSessionData(data, allSessions);
            }
        } else if (mode === 'event') {
            // identifier ist hier die eventID
            const url = `https://driftclub.com/api/event/children?eventID=${identifier}`;
            const res = await fetch(url);
            const data = await res.json();
            
            if(data.sessions && Array.isArray(data.sessions)) {
                data.sessions.forEach(sess => {
                    // Die API Struktur bei 'children' ist oft etwas anders, 
                    // die eigentlichen Daten stecken oft tiefer verschachtelt oder direkt drin.
                    // Wir versuchen das Setup zu finden:
                    let setupObj = sess.setup; // Standard
                    
                    // Fallback: Manchmal sind Details in Sub-Objekten, wir suchen danach (wie im Original)
                    if(!setupObj) {
                        for (const key in sess) {
                            if (sess[key] && typeof sess[key] === 'object' && sess[key].startTime) {
                                setupObj = sess[key];
                                break;
                            }
                        }
                    }
                    
                    if(setupObj) {
                        processSessionData({ _id: sess._id, name: sess.name, setup: setupObj }, allSessions);
                    }
                });
            }
        }
    } catch(e) { console.error("Fetch Error:", e); printState("API Fehler"); return; }

    // Sortieren
    allSessions.sort((a, b) => a.startTime - b.startTime);
    
    // Filtern
    const now = Math.floor(Date.now() / 1000);
    const futureRaces = allSessions.filter(s => s.startTime > (now - 60));

    // UI & Upload
    updateScheduleUI(futureRaces);
}

function processSessionData(data, list) {
    if(data && data.setup) {
        let durSec = 300;
        if(data.setup.duration) {
            const dp = data.setup.duration.split(':');
            if(dp.length === 3) durSec = (+dp[0])*3600 + (+dp[1])*60 + (+dp[2]);
        }
        
        list.push({
            name: data.name,
            startTime: Math.floor(Date.parse(data.setup.startTime) / 1000),
            duration: durSec,
            delay: Math.round((data.setup.startDelay || 0) * 1000)
        });
    }
}

async function updateScheduleUI(races) {
    const listEl = $ID('schedule-list');
    if(races.length === 0) {
        listEl.innerHTML = "<p>Keine zukünftigen Rennen.</p>";
        printState("Keine Rennen.");
    } else {
        listEl.innerHTML = races.map(s => `
            <div class="schedule-item">
                <span>${s.name}</span>
                <span>${new Date(s.startTime*1000).toLocaleTimeString()}</span>
            </div>
        `).join('');
        
        printState(`Sende ${races.length} Rennen...`);
        
        await sendDataCmd("/clear");
        
        let count = 0;
        for(let r of races) {
            if(count >= 10) break; 
            const safeName = cleanString(r.name);
            await sendDataCmd(`/add?s=${r.startTime}&d=${r.duration}&r=${r.delay}&n=${safeName}`);
            count++;
        }
        
        printState("Plan übertragen!");
        console.log(`[BATCH] ${count} Rennen gesendet.`);
    }
}
