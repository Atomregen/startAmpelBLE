// --- KONFIGURATION ---
const SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214".toLowerCase();
const COMMAND_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214".toLowerCase();

// Globale Variablen
let bleDevice;
let commandChar;
let timeSyncInterval;
let pollingInterval;
let isYellowFlagActive = false;
let isWriting = false; // Sperre für gleichzeitiges Senden (Wichtig für Batch!)

// --- INITIALISIERUNG ---
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

// --- HELFER FUNKTIONEN ---
function $ID(id) { return document.getElementById(id); }

function reMap(val, in_min, in_max, out_min, out_max) {
    return (val - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}

function writeVolNum(id, val) { $ID(id).innerHTML = "Volume: " + val; }
function writeDelayNum(id, val) { $ID(id).innerHTML = "S.Delay: " + Math.round(val) + "ms"; }

function printState(msg) {
    if(msg) $ID("state0").innerHTML = msg;
}

// Bereinigt Namen für die LED Matrix (Entfernt Sonderzeichen)
function cleanString(str) {
    if(!str) return "Rennen";
    // Erlaubt nur: A-Z, a-z, 0-9, Leerzeichen, Bindestrich, Punkt, Doppelpunkt
    return str.replace(/[^a-zA-Z0-9 \-.:]/g, "").substring(0, 20);
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
        console.error(e);
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

if($ID('btnConnect')) {
    $ID('btnConnect').addEventListener('click', connectBLE);
}

// --- KOMMUNIKATION (Thread-Safe) ---

async function sendDataCmd(cmd) {
    if (!commandChar) return;
    
    // Einfacher Mutex: Warte, falls gerade gesendet wird
    // Das ist extrem wichtig beim Senden der Liste!
    while(isWriting) {
        await new Promise(r => setTimeout(r, 20));
    }

    try {
        isWriting = true;
        console.log(`[TX] ${cmd}`);
        await commandChar.writeValue(new TextEncoder().encode(cmd));
        // Kleines Delay NACH dem Senden, damit der Arduino Zeit zum Verarbeiten hat
        await new Promise(r => setTimeout(r, 60)); 
    } catch (e) { 
        console.error("Sende-Fehler:", e); 
    } finally {
        isWriting = false;
    }
}

function syncTime() {
    const unix = Math.floor(Date.now() / 1000);
    sendDataCmd(`/syncTime?val=${unix}`);
}

// --- FEATURES ---

function sendText() {
    var txt = $ID("myLEDText").value;
    sendDataCmd("/ledText=" + cleanString(txt));
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

// --- DRIFTCLUB AUTOMATIK (BATCH MODE) ---

function loadGameIds() {
    const ids = $ID("myID").value;
    if(!ids) return alert("Bitte Game ID eingeben!");
    
    if(pollingInterval) clearInterval(pollingInterval);
    
    // Sofort laden
    fetchAndUpload(ids);
    
    // Dann alle 2 Minuten aktualisieren
    pollingInterval = setInterval(() => fetchAndUpload(ids), 120000); 
}

async function fetchAndUpload(rawIds) {
    printState("Lade Daten...");
    const idList = rawIds.split(',').map(s => s.trim());
    let allSessions = [];

    for (const id of idList) {
        if(!id) continue;
        const p = id.split('/');
        // URL ggf. anpassen
        const url = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2F${p[0]}%2F${p[1]}%2F${p[2]}%2Fsession%2F${p[3]||''}`;
        
        try {
            const res = await fetch(url);
            const data = await res.json();
            
            console.log(`[API RAW]`, data);
            
            if(data && data.setup) {
                let durSec = 300;
                if(data.setup.duration) {
                    const dp = data.setup.duration.split(':');
                    durSec = (+dp[0])*3600 + (+dp[1])*60 + (+dp[2]);
                }
                
                allSessions.push({
                    name: data.name,
                    startTime: Math.floor(Date.parse(data.setup.startTime) / 1000),
                    duration: durSec,
                    delay: Math.round((data.setup.startDelay || 0) * 1000)
                });
            }
        } catch (e) { 
            console.error("Fetch Error:", e);
            printState("API Fehler (siehe Konsole)");
        }
    }

    // Sortieren
    allSessions.sort((a, b) => a.startTime - b.startTime);
    
    // Filtern: Nur Zukunft oder max 5 Min vergangen
    const now = Math.floor(Date.now() / 1000);
    const futureRaces = allSessions.filter(s => s.startTime > (now - 300));

    // UI Update
    const listEl = $ID('schedule-list');
    if(futureRaces.length === 0) {
        listEl.innerHTML = "<p>Keine relevanten Rennen gefunden.</p>";
        printState("Keine Rennen.");
    } else {
        listEl.innerHTML = futureRaces.map(s => `
            <div class="schedule-item">
                <span>${s.name}</span>
                <span>${new Date(s.startTime*1000).toLocaleTimeString()}</span>
            </div>
        `).join('');
        
        // --- UPLOAD ZUM ARDUINO ---
        printState(`Sende ${futureRaces.length} Rennen...`);
        
        // 1. Liste löschen
        await sendDataCmd("/clear");
        
        // 2. Upload Loop (Max 10 Rennen)
        let count = 0;
        for(let r of futureRaces) {
            if(count >= 10) break; 
            
            const safeName = cleanString(r.name);
            
            // Format: /add?s=UNIX&d=SEC&r=MS&n=NAME
            await sendDataCmd(`/add?s=${r.startTime}&d=${r.duration}&r=${r.delay}&n=${safeName}`);
            
            count++;
        }
        
        printState("Plan übertragen!");
        console.log(`[BATCH] ${count} Rennen an Arduino gesendet.`);
    }
}
