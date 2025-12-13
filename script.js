// UUIDs
const SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214".toLowerCase();
const COMMAND_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214".toLowerCase();

let bleDevice, commandChar;
let timeSyncInterval, pollingInterval;
let isYellowFlagActive = false;
let scheduledRaceID = null;

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
function writeVolNum(id, val) { $ID(id).innerHTML = "Volume: " + val; }
function writeDelayNum(id, val) { $ID(id).innerHTML = "S.Delay: " + Math.round(val) + "ms"; }
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
        timeSyncInterval = setInterval(syncTime, 30000); // Alle 30s Sync
        
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
        console.log(`[BLE TX] ${cmd}`);
        await commandChar.writeValue(new TextEncoder().encode(cmd));
    } catch (e) { console.error(e); }
}

function syncTime() {
    const unix = Math.floor(Date.now() / 1000);
    sendDataCmd(`/syncTime?val=${unix}`);
    console.log(`[SYNC] Sende Zeit an Arduino: ${unix}`);
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

// --- Driftclub Logic ---
function loadGameIds() {
    const ids = $ID("myID").value;
    if(!ids) return alert("ID eingeben!");
    
    if(pollingInterval) clearInterval(pollingInterval);
    fetchData(ids);
    pollingInterval = setInterval(() => fetchData(ids), 2000);
    printState("Monitoring aktiv...");
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
            
            // Console output wie gewünscht
            console.log(`[API] ID: ${id} | Name: ${data.name} | Start: ${data.setup?.startTime}`);
            
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
                    delay: data.setup.startDelay || 0,
                    rawTime: data.setup.startTime
                });
            }
        } catch (e) { console.error(`Fetch Error: ${e}`); }
    }

    allSessions.sort((a, b) => a.startTime - b.startTime);
    
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

    // Automatik: Daten an Arduino senden
    const now = Math.floor(Date.now() / 1000);
    // Suche das nächste Rennen in der Zukunft
    const next = allSessions.find(s => s.startTime > (now - 300));
    
    if (next) {
        const diff = next.startTime - now;
        printState(`Nächstes: ${next.name} in ${diff}s`);
        
        // Sende NUR, wenn es eine neue Session ID ist
        // Arduino kümmert sich um den Rest (Timing)
        if (scheduledRaceID !== next.id) {
            console.log(`[SENDING] Sende Rennen an Arduino: ${next.name}`);
            console.log(`--> StartUnix: ${next.startTime}, Duration: ${next.duration}, Delay: ${Math.round(next.delay * 1000)}`);
            
            const delayMs = Math.round(next.delay * 1000);
            sendDataCmd(`/setRace?start=${next.startTime}&dur=${next.duration}&rnd=${delayMs}&name=${encodeURIComponent(next.name)}`);
            
            scheduledRaceID = next.id;
        }
    } else {
        printState("Keine Rennen anstehend.");
    }
}
