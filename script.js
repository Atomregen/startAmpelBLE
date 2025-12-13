// ... (UUIDs und Init wie gehabt) ...

// --- Driftclub Logic ---

async function fetchAndUpload(rawIds) {
    printState("Lade Daten...");
    const idList = rawIds.split(',').map(s => s.trim());
    let allSessions = [];

    // 1. Daten holen
    for (const id of idList) {
        if(!id) continue;
        const p = id.split('/');
        const url = `https://driftclub.com/api/session?sessionRoute=%2Fevent%2F${p[0]}%2F${p[1]}%2F${p[2]}%2Fsession%2F${p[3]||''}`;
        
        try {
            const res = await fetch(url);
            const data = await res.json();
            
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
        } catch (e) { console.error(e); }
    }

    // 2. Sortieren & UI
    allSessions.sort((a, b) => a.startTime - b.startTime);
    const now = Math.floor(Date.now() / 1000);
    // Nur relevante Rennen (Zukunft oder max 5 Min vorbei)
    const activeRaces = allSessions.filter(s => s.startTime > (now - 300));

    // Update UI Liste... (Code wie gehabt)

    // 3. Upload zum Arduino
    if(activeRaces.length > 0) {
        printState(`Sende ${activeRaces.length} Rennen...`);
        
        await sendDataCmd("/clear"); // Liste leeren
        
        for(let r of activeRaces) {
            // Encode Name (einfach)
            const safeName = encodeURIComponent(r.name).substring(0, 20); // Limit Length
            const cmd = `/add?s=${r.startTime}&d=${r.duration}&r=${r.delay}&n=${safeName}`;
            await sendDataCmd(cmd);
            // Kleines Delay damit BLE Stack nicht choked
            await new Promise(res => setTimeout(res, 50));
        }
        printState("Plan übertragen!");
    } else {
        printState("Keine aktiven Rennen.");
    }
}
