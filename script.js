// --- KONFIGURATION ---
const SERVICE_UUID = "19B10000-E8F2-537E-4F6C-D104768A1214".toLowerCase();
const COMMAND_UUID = "19B10001-E8F2-537E-4F6C-D104768A1214".toLowerCase();

let bleDevice, commandChar;
let timeSyncInterval, pollingInterval;
let isYellowFlagActive = false;
let isWriting = false;

// --- INIT ---
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

function syncTime() { const unix = Math.floor(Date.now() / 1000); sendDataCmd(`/syncTime?val=${unix}`); console.log(`[SYNC] ${unix}`); }

// --- FEATURES ---
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
function loadGameIds() {
    const ids = $ID("myID").value;
    if(!ids) return alert("Bitte Game ID eingeben!");
    if(pollingInterval) clearInterval(pollingInterval);
    const task = () => fetchAndUpload(ids, 'direct');
    task();
    pollingInterval = setInterval(task, 120000); 
}

async function loadEventData() {
    const link = $ID("dcEventLink").value;
    if(!link) return alert("Bitte Event-Link eingeben!");
    printState("Suche Event...");
    try {
        let path = link;
        try { const urlObj = new URL(link); } catch(e) {}
        if(path.startsWith("/")) path = path.substring(1);
        
        const eventInfoUrl = `https://driftclub.com/api/event?eventRoute=%2Fevent%2Fg%2F${encodeURIComponent(path)}`;
        const r1 = await fetch(eventInfoUrl);
        if(!r1.ok) throw new Error("Event nicht gefunden");
        const eventData = await r1.json();
        const eventID = eventData._id || eventData.id;
        
        if(!eventID) throw new Error("Keine Event ID");
        printState(`Gefunden: ${eventData.name}`);
        
        if(pollingInterval) clearInterval(pollingInterval);
        const task = () => fetchAndUpload(eventID, 'event');
        task();
        pollingInterval = setInterval(task, 120000);
        
    } catch(e) { console.error(e); printState("Fehler: Event nicht gefunden"); }
}

async function fetchAndUpload(identifier, mode) {
    printState("Lade Daten...");
    let allSessions = [];

    try {
        if (mode === 'direct') {
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
            const url = `https://driftclub.com/api/event/children?eventID=${identifier}`;
            const res = await fetch(url);
            const data = await res.json();
            if(data.sessions && Array.isArray(data.sessions)) {
                data.sessions.forEach(sess => {
                    let setupObj = sess.setup;
                    if(!setupObj) {
                        for (const key in sess) {
                            if (sess[key] && typeof sess[key] === 'object' && sess[key].startTime) { setupObj = sess[key]; break; }
                        }
                    }
                    if(setupObj) processSessionData({ _id: sess._id, name: sess.name, setup: setupObj }, allSessions);
                });
            }
        }
    } catch(e) { console.error("Fetch Error:", e); printState("API Fehler"); return; }

    allSessions.sort((a, b) => a.startTime - b.startTime);
    const now = Math.floor(Date.now() / 1000);
    const futureRaces = allSessions.filter(s => s.startTime > (now - 60));

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
        // --- HIER IST DIE ÄNDERUNG ---
        listEl.innerHTML = races.map(s => {
            const min = Math.floor(s.duration / 60);
            const sec = s.duration % 60;
            const durStr = (sec === 0) ? `${min} min` : `${min}:${sec.toString().padStart(2, '0')} min`;
            
            return `
            <div class="schedule-item">
                <span title="${s.name}">${s.name}</span>
                <span>${durStr}</span>
                <span>${new Date(s.startTime*1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
            </div>`;
        }).join('');
        // -----------------------------
        
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
