// UUIDs
const SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214".toLowerCase();
const COMMAND_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214".toLowerCase();

let bleDevice, commandChar;
let timeSyncInterval, pollingInterval;
let isYellowFlagActive = false;

// --- Init ---
$(document).ready(function() {
    $("#manual-start-content").hide();
    $(".expert").hide();
    $('#expert-toggle').on('change', function() { if (this.checked) $(".expert").slideDown(); else $(".expert").slideUp(); });
    $('#manual-start-toggle').on('change', function() { if (this.checked) $("#manual-start-content").slideDown(); else $("#manual-start-content").slideUp(); });
});

// --- Helper ---
function $ID(id) { return document.getElementById(id); }
function reMap(val, in_min, in_max, out_min, out_max) { return (val - in_min) * (out_max - out_min) / (in_max - in_min) + out_min; }
function printState(msg) { if(msg) $ID("state0").innerHTML = msg; }

// --- BLE ---
async function connectBLE() {
    try {
        bleDevice = await navigator.bluetooth.requestDevice({ filters: [{ name: 'DriftAmpel' }], optionalServices: [SERVICE_UUID] });
        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
        const server = await bleDevice.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        commandChar = await service.getCharacteristic(COMMAND_UUID);
        
        $ID('bleState').innerHTML = "Verbunden"; $ID('bleState').style.color = "#4cd137";
        $ID('main-content').style.display = 'block'; $ID('btnConnect').style.display = 'none';
        
        syncTime();
        timeSyncInterval = setInterval(syncTime, 60000); // Regelmäßiger Sync
        
    } catch (e) { alert("Fehler: " + e); }
}

function onDisconnected() {
    $ID('bleState').innerHTML = "Getrennt"; $ID('bleState').style.color = "#e74c3c";
    $ID('main-content').style.display = 'none'; $ID('btnConnect').style.display = 'block';
    clearInterval(timeSyncInterval); clearInterval(pollingInterval);
}

document.getElementById('btnConnect').addEventListener('click', connectBLE);

async function sendDataCmd(cmd) {
    if (!commandChar) return;
    try {
        console.log(`[BLE] ${cmd}`);
        await commandChar.writeValue(new TextEncoder().encode(cmd));
        // Kurze Pause damit Arduino nicht überläuft
        await new Promise(r => setTimeout(r, 100)); 
    } catch (e) { console.error(e); }
}

function syncTime() {
    const unix = Math.floor(Date.now() / 1000);
    sendDataCmd(`/syncTime?val=${unix}`);
}

// --- Features ---
function sendText() { sendDataCmd("/ledText=" + $ID("myLEDText").value); }
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

// --- Driftclub Logic (BATCH MODE) ---

function loadGameIds() {
    const ids = $ID("myID").value;
    if(!ids) return alert("ID eingeben!");
    
    // Daten holen und dann UPLOAD starten
    fetchAndUpload(ids);
    
    // Optional: Alle 2 Minuten aktualisieren
    if(pollingInterval) clearInterval(pollingInterval);
    pollingInterval = setInterval(() => fetchAndUpload(ids), 120000); 
}

async function fetchAndUpload(rawIds) {
    printState("Lade Daten...");
    const idList = rawIds.split(',').map(s => s.trim());
    let allSessions = [];

    for (const id of idList) {
        if(!id) continue;
        const p = id.split('/');
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
                    delay: Math.round((data.setup.startDelay || 0) * 1000) // ms
                });
            }
        } catch (e) { console.error(e); }
    }

    // Sortieren
    allSessions.sort((a, b) => a.startTime - b.startTime);
    
    // Nur ZUKÜNFTIGE Rennen senden (plus kleine Toleranz)
    const now = Math.floor(Date.now() / 1000);
    const futureRaces = allSessions.filter(s => s.startTime > (now - 60)); // max 1 min alt

    // UI Update
    const listEl = $ID('schedule-list');
    listEl.innerHTML = futureRaces.length ? futureRaces.map(s => `
        <div class="schedule-item"><span>${s.name}</span><span>${new Date(s.startTime*1000).toLocaleTimeString()}</span></div>
    `).join('') : "<p>Keine zukünftigen Rennen.</p>";

    // --- UPLOAD ZUM ARDUINO ---
    if(futureRaces.length > 0) {
        printState(`Sende ${futureRaces.length} Rennen...`);
        
        // 1. Liste löschen
        await sendDataCmd("/clear");
        
        // 2. Jedes Rennen senden (Max 20 beachten)
        let count = 0;
        for(let r of futureRaces) {
            if(count >= 20) break;
            // Format: /add?s=UNIX&d=SEC&r=MS
            await sendDataCmd(`/add?s=${r.startTime}&d=${r.duration}&r=${r.delay}`);
            count++;
        }
        printState("Liste übertragen!");
    } else {
        printState("Keine Rennen zu übertragen.");
    }
}
