// UUIDs
const SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214".toLowerCase();
const COMMAND_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214".toLowerCase();

let bleDevice, commandChar;
let timeSyncInterval, pollingInterval;
let isYellowFlagActive = false;
let scheduledRaceID = null;

// --- INITIALISIERUNG (FIX FÜR REFERENCE ERROR) ---
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

// --- Helper Functions ---
function $ID(id) { return document.getElementById(id); }

function reMap(val, in_min, in_max, out_min, out_max) {
    return (val - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}

function writeVolNum(id, val) { $ID(id).innerHTML = "Volume: " + val; }
function writeDelayNum(id, val) { $ID(id).innerHTML = "S.Delay: " + Math.round(val) + "ms"; }

function printState(msg) {
    if(msg) $ID("state0").innerHTML = msg;
}

// --- BLE Core ---
async function connectBLE() {
    try {
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'DriftAmpel' }], optionalServices: [SERVICE_UUID]
        });
        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
        const server = await bleDevice.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        commandChar = await service.getCharacteristic(COMMAND_UUID);
        
        $ID('bleState').innerHTML = "Verbunden";
        $ID('bleState').style.color = "#4cd137";
        $ID('main-content').style.display = 'block';
        $ID('btnConnect').style.display = 'none';
        
        // Time Sync Start
        syncTime();
        timeSyncInterval = setInterval(syncTime, 60000);
        
    } catch (e) { alert("Verbindung fehlgeschlagen: " + e); }
}

function onDisconnected() {
    $ID('bleState').innerHTML = "Getrennt";
    $ID('bleState').style.color = "#e74c3c";
    $ID('main-content').style.display = 'none';
    $ID('btnConnect').style.display = 'block';
    clearInterval(timeSyncInterval);
    clearInterval(pollingInterval);
}

// Event Listener für den Connect Button
if(document.getElementById('btnConnect')) {
    document.getElementById('btnConnect').addEventListener('click', connectBLE);
}

async function sendDataCmd(cmd) {
    if (!commandChar) return;
    try {
        console.log("TX:", cmd);
        await commandChar.writeValue(new TextEncoder().encode(cmd));
    } catch (e) { console.error(e); }
}

function syncTime() {
    const unix = Math.floor(Date.now() / 1000);
    sendDataCmd(`/syncTime?val=${unix}`);
}

// --- Features ---

function sendText() {
    var txt = $ID("myLEDText").value;
    sendDataCmd("/ledText=" + txt);
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
    
    // Parse Duration
    const parts = durStr.split(':');
    let s = 300;
    if(parts.length === 3) s = (+parts[0])*3600 + (+parts[1])*60 + (+parts[2]);
    
    let rnd = 0;
    if(random) rnd = Math.floor(Math.random() * 30) * 100;
    
    // Sende Befehl an Arduino
    sendDataCmd(`/startSequence&dur=${s}&rnd=${rnd}&pre=${preT}`);
}

// --- Driftclub Logic ---

function loadGameIds() {
    const ids = $ID("myID").value;
    if(!ids) return alert("ID eingeben!");
    
    if(pollingInterval) clearInterval(pollingInterval);
    fetchData(ids);
    pollingInterval = setInterval(() => fetchData(ids), 2000);
    printState("Monitoring aktiv...");
    console.log("--- START MONITORING ---");
}

async function fetchData(rawIds) {
    const idList = rawIds.split(',').map(s => s.trim());
    let allSessions = [];

    for (const id of idList) {
        if(!id) continue;
        const p = id.split('/');
        const url = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2F${p[0]}%2F${p[1]}%2F${p[2]}%2Fsession%2F${p[3]||''}`;
        
        try {
            const res = await fetch(url);
            const data = await res.json();
            
            // console.log(`[API RAW] ID ${id}:`, data); 
            
            if(data && data.setup) {
                let durSec = 300;
                if(data.setup.duration) {
                    const dp = data.setup.duration.split(':');
                    durSec = (+dp[0])*3600 + (+dp[1])*60 + (+dp[2]);
                }
                
                allSessions.push({
                    id: data._id,
                    name: data.name,
                    startTime: Math.floor(Date.parse(data.setup.startTime) / 1000),
                    duration: durSec,
                    delay: data.setup.startDelay || 0, // HIER IST DAS DELAY (in Sekunden)
                    rawTime: data.setup.startTime
                });
            }
        } catch (e) { console.error(`Fetch Error ${id}:`, e); }
    }

    allSessions.sort((a, b) => a.startTime - b.startTime);
    
    // UI Update (Liste)
    const listEl = $ID('schedule-list');
    if(allSessions.length === 0) listEl.innerHTML = "<p>Keine Daten.</p>";
    else {
        listEl.innerHTML = allSessions.map(s => `
            <div class="schedule-item">
                <span>${s.name} (Delay: ${s.delay}s)</span>
                <span>${new Date(s.startTime*1000).toLocaleTimeString()}</span>
            </div>
        `).join('');
    }

    // Automatik Prüfung
    const now = Math.floor(Date.now() / 1000);
    const next = allSessions.find(s => s.startTime > (now - 300));
    
    if (next) {
        const diff = next.startTime - now;
        printState(`Next: ${next.name} in ${diff}s`);
        
        // Sende Befehl wenn neu und noch nicht vorbei
        if (scheduledRaceID !== next.id && diff > -next.duration) {
            console.log(`[AUTO-START] Triggering ${next.name} (Delay: ${next.delay}s)`);
            
            // WICHTIG: delay * 1000 für Millisekunden
            const delayMs = Math.round(next.delay * 1000);
            
            // NEU: &rnd=Parameter hinzugefügt
            const cmd = `/setRace?start=${next.startTime}&dur=${next.duration}&rnd=${delayMs}&name=${encodeURIComponent(next.name)}`;
            
            sendDataCmd(cmd);
            scheduledRaceID = next.id;
        }
    } else {
        printState("Keine Rennen anstehend.");
    }
}

