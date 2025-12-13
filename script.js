// --- KONFIGURATION ---
const SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214".toLowerCase();
const COMMAND_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214".toLowerCase();

// Globale Variablen
let bleDevice;
let commandChar;
let timeSyncInterval;
let pollingInterval;
let isYellowFlagActive = false;

// --- INITIALISIERUNG (Original UI Verhalten) ---
$(document).ready(function() {
    // Verstecke Bereiche standardmäßig
    $("#manual-start-content").hide();
    $(".expert").hide();
      
    // Event Handler für Toggle Switches
    $('#expert-toggle').on('change', function() {
        if (this.checked) $(".expert").slideDown(); else $(".expert").slideUp();
    });
      
    $('#manual-start-toggle').on('change', function() {
        if (this.checked) $("#manual-start-content").slideDown(); else $("#manual-start-content").slideUp();
    });
});

// --- HELFER FUNKTIONEN (Für HTML Events) ---
function $ID(id) { return document.getElementById(id); }

// Mapping Funktion für Slider (z.B. Matrix Speed)
function reMap(val, in_min, in_max, out_min, out_max) {
    return (val - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}

// UI Updates für Slider Texte
function writeVolNum(id, val) { $ID(id).innerHTML = "Volume: " + val; }
function writeDelayNum(id, val) { $ID(id).innerHTML = "S.Delay: " + Math.round(val) + "ms"; }

// Status Ausgabe
function printState(msg) {
    if(msg) $ID("state0").innerHTML = msg;
}

// --- BLE VERBINDUNG ---
async function connectBLE() {
    try {
        printState("Suche Ampel...");
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'DriftAmpel' }],
            optionalServices: [SERVICE_UUID]
        });

        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
        const server = await bleDevice.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        commandChar = await service.getCharacteristic(COMMAND_UUID);
        
        // UI Updates nach erfolgreicher Verbindung
        $ID('bleState').innerHTML = "Verbunden";
        $ID('bleState').style.color = "#4cd137";
        $ID('main-content').style.display = 'block';
        $ID('btnConnect').style.display = 'none';
        printState("Bereit.");
        
        // Starte Zeit-Sync (Sofort + alle 60s)
        syncTime();
        timeSyncInterval = setInterval(syncTime, 60000);
        
    } catch (e) { 
        alert("Verbindung fehlgeschlagen: " + e); 
        printState("Verbindungsfehler");
    }
}

function onDisconnected() {
    $ID('bleState').innerHTML = "Getrennt";
    $ID('bleState').style.color = "#e74c3c";
    $ID('main-content').style.display = 'none';
    $ID('btnConnect').style.display = 'block';
    
    clearInterval(timeSyncInterval);
    clearInterval(pollingInterval);
    printState("Verbindung verloren");
}

// Event Listener für den Connect Button
if($ID('btnConnect')) {
    $ID('btnConnect').addEventListener('click', connectBLE);
}

// --- KOMMUNIKATION ---

// Hauptfunktion zum Senden von Befehlen
async function sendDataCmd(cmd) {
    if (!commandChar) return;
    try {
        console.log(`[TX] ${cmd}`);
        await commandChar.writeValue(new TextEncoder().encode(cmd));
        // Kleines Delay um den Arduino Buffer nicht zu überfluten
        await new Promise(r => setTimeout(r, 50)); 
    } catch (e) { 
        console.error("Sende-Fehler:", e); 
    }
}

// Sendet aktuelle Browser-Zeit an Arduino
function syncTime() {
    const unix = Math.floor(Date.now() / 1000);
    sendDataCmd(`/syncTime?val=${unix}`);
    console.log(`[SYNC] Zeit gesendet: ${unix}`);
}

// --- FEATURES & BUTTONS ---

function sendText() {
    var txt = $ID("myLEDText").value;
    // URL Encoding für Sonderzeichen
    sendDataCmd("/ledText=" + encodeURIComponent(txt));
}

function toggleYellowFlag() {
    isYellowFlagActive = !isYellowFlagActive;
    const btn = $ID('yellowFlagToggle');
    if(isYellowFlagActive) {
        sendDataCmd('/yellowFlagOn');
        btn.textContent = 'YELLOW FLAG OFF';
        btn.classList.add('active-state');
    } else {
        sendDataCmd('/yellowFlagOff');
        btn.textContent = 'YELLOW FLAG ON';
        btn.classList.remove('active-state');
    }
}

// Manueller Start (Direkt-Kommando)
function manualStart(random) {
    const durStr = $ID('duration-input').value;
    const preT = $ID('preStartTime').value;
    
    // Zeit parsen (HH:MM:SS)
    const parts = durStr.split(':');
    let s = 300;
    if(parts.length === 3) s = (+parts[0])*3600 + (+parts[1])*60 + (+parts[2]);
    
    let rnd = 0;
    if(random) rnd = Math.floor(Math.random() * 30) * 100;
    
    // Arduino Befehl: /startSequence...
    sendDataCmd(`/startSequence&dur=${s}&rnd=${rnd}&pre=${preT}`);
}

// --- DRIFTCLUB AUTOMATIK (BATCH MODE) ---

function loadGameIds() {
    const ids = $ID("myID").value;
    if(!ids) return alert("Bitte Game ID eingeben!");
    
    // Stoppe alte Intervalle
    if(pollingInterval) clearInterval(pollingInterval);
    
    // Sofort laden
    fetchAndUpload(ids);
    
    // Dann alle 60 Sekunden aktualisieren (um Liste frisch zu halten)
    pollingInterval = setInterval(() => fetchAndUpload(ids), 60000); 
}

async function fetchAndUpload(rawIds) {
    printState("Lade Daten...");
    const idList = rawIds.split(',').map(s => s.trim());
    let allSessions = [];

    // 1. Alle IDs abfragen
    for (const id of idList) {
        if(!id) continue;
        const p = id.split('/');
        // API URL aufbauen
        const url = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2F${p[0]}%2F${p[1]}%2F${p[2]}%2Fsession%2F${p[3]||''}`;
        
        try {
            const res = await fetch(url);
            const data = await res.json();
            
            console.log(`[API RAW]`, data); // Debugging
            
            if(data && data.setup) {
                // Dauer berechnen
                let durSec = 300;
                if(data.setup.duration) {
                    const dp = data.setup.duration.split(':');
                    durSec = (+dp[0])*3600 + (+dp[1])*60 + (+dp[2]);
                }
                
                allSessions.push({
                    name: data.name,
                    startTime: Math.floor(Date.parse(data.setup.startTime) / 1000),
                    duration: durSec,
                    delay: Math.round((data.setup.startDelay || 0) * 1000) // in ms
                });
            }
        } catch (e) { console.error("Fetch Error:", e); }
    }

    // 2. Sortieren (Chronologisch)
    allSessions.sort((a, b) => a.startTime - b.startTime);
    
    // 3. Filtern: Nur Rennen die in der Zukunft liegen (oder max 1 min alt sind)
    const now = Math.floor(Date.now() / 1000);
    const futureRaces = allSessions.filter(s => s.startTime > (now - 60));

    // 4. UI Update (Liste anzeigen)
    const listEl = $ID('schedule-list');
    if(futureRaces.length === 0) {
        listEl.innerHTML = "<p>Keine zukünftigen Rennen gefunden.</p>";
        printState("Keine Rennen.");
    } else {
        listEl.innerHTML = futureRaces.map(s => `
            <div class="schedule-item">
                <span>${s.name}</span>
                <span>${new Date(s.startTime*1000).toLocaleTimeString()}</span>
            </div>
        `).join('');
        
        // 5. UPLOAD ZUM ARDUINO
        printState(`Sende ${futureRaces.length} Rennen...`);
        
        // A) Liste leeren
        await sendDataCmd("/clear");
        
        // B) Rennen hinzufügen (Limit beachten, Arduino speichert max 10-20)
        let count = 0;
        for(let r of futureRaces) {
            if(count >= 10) break; // Sicherheitslimit
            
            // Name sicher encoden und kürzen
            const safeName = encodeURIComponent(r.name).substring(0, 20);
            
            // Befehl: /add?s=START&d=DAUER&r=DELAY&n=NAME
            await sendDataCmd(`/add?s=${r.startTime}&d=${r.duration}&r=${r.delay}&n=${safeName}`);
            
            count++;
        }
        
        printState("Zeitplan übertragen!");
        console.log(`[BATCH] ${count} Rennen an Arduino gesendet.`);
    }
}
