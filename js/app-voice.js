import { GoogleGenerativeAI } from "https://cdn.jsdelivr.net/npm/@google/generative-ai/+esm";
import { CONFIG } from "./config.js";

let SYSTEM_PROMPT = `You are Cohana, a witty AI guide. You are helping the user navigate.
1. Keep answers short and helpful.
2. The user is currently walking/driving on a route.
3. If asked about the route, use the context provided.
4. Speak naturally.`;

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const analyser = audioCtx.createAnalyser();
analyser.smoothingTimeConstant = 0.7; analyser.fftSize = 512;
const frequencyData = new Uint8Array(analyser.frequencyBinCount);

let sourceNode = null;
let ttsNode = null;
let routeData = null;
let navInterval = null;
let currentHeading = 0;
let targetBearing = 0;

const STATE = { isNavMode: false, isListening: false, isProcessing: false, isPlaying: false, vad: null, chat: null };

const el = {
    vis: document.getElementById('visualizerContainer'),
    canvas: document.getElementById('voiceWaveCanvas'),
    status: document.getElementById('statusMessage'),
    navHud: document.getElementById('navHud'),
    mics: document.querySelectorAll('.main-trigger'),
    btnNav: document.getElementById('btnToggleNav'),
    btnClose: document.getElementById('btnCloseApp'),
    arrow: document.getElementById('navArrow'),
    dist: document.getElementById('navDist'),
    time: document.getElementById('navTime'),
    instr: document.getElementById('navInstruction'),
    nextPt: document.getElementById('navNextPoint')
};

window.onload = () => {
    initVAD();

    const storedData = localStorage.getItem('activeRoute');
    if (storedData) {
        routeData = JSON.parse(storedData);
        const stops = routeData.places.map(p => p.name).join(' -> ');
        SYSTEM_PROMPT += `\nCurrent Route Context: User is going to: ${stops}. \nDescription of stops: ${JSON.stringify(routeData.places)}`;
        toggleNavMode(true);
    } else {
        el.instr.innerText = "No route found. Start from map.";
    }

    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', handleOrientation);
    }

    // Listeners
    el.btnNav.onclick = () => toggleNavMode();
    el.btnClose.onclick = () => window.location.href = 'index.html';
    el.mics.forEach(b => b.onclick = () => {
        if (STATE.isProcessing) return;
        if (STATE.isListening) { pauseListening(); showStatus("Paused"); }
        else { if (STATE.isPlaying) player.stop(); startListening(); }
    });
    window.addEventListener('resize', () => { el.canvas.width = el.vis.clientWidth; el.canvas.height = el.vis.clientHeight; });
};

function handleOrientation(event) {
    let heading = 0;
    if (event.webkitCompassHeading) {
        heading = event.webkitCompassHeading;
    } else if (event.alpha !== null) {
        heading = 360 - event.alpha;
    }
    currentHeading = heading;
    updateCompass();
}

function updateCompass() {
    if (!STATE.isNavMode) return;
    const relativeBearing = targetBearing - currentHeading;
    el.arrow.style.transform = `rotate(${relativeBearing}deg)`;
}

async function updateNavigation() {
    if (!routeData || !routeData.places || routeData.places.length === 0) return;

    navigator.geolocation.getCurrentPosition(async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const target = routeData.places[0];

        try {
            const profile = routeData.mode === 'walk' ? 'walking' : 'driving';
            const url = `https://router.project-osrm.org/route/v1/${profile}/${lng},${lat};${target.lng},${target.lat}?steps=true&overview=false`;

            const res = await fetch(url);
            const data = await res.json();

            if (data.routes && data.routes.length > 0) {
                const route = data.routes[0];
                const step = route.legs[0].steps[0];
                const duration = route.duration;
                const distance = route.distance;

                if (step && step.maneuver && step.maneuver.bearing_after !== undefined) {
                    targetBearing = step.maneuver.bearing_after;
                }

                updateNavUI(step, distance, duration, target.name);
                updateCompass();
            }
        } catch (e) { console.error(e); }

    }, (err) => console.log(err), { enableHighAccuracy: true });
}

function updateNavUI(step, totalDist, totalTimeSec, targetName) {
    el.nextPt.innerText = `To: ${targetName}`;
    el.dist.innerText = `${Math.round(totalDist)}m`;
    el.time.innerText = `${Math.ceil(totalTimeSec / 60)} min`;

    let instruction = "Go Straight";
    if (step && step.maneuver) {
        const m = step.maneuver;
        instruction = step.name ? `Head towards ${step.name}` : "Follow the path";
        if (step.distance < 30 && step.maneuver.type !== 'depart') {
            instruction = `Turn ${m.modifier || 'now'} in ${Math.round(step.distance)}m`;
        }
    }
    el.instr.innerText = instruction;
}

function toggleNavMode(forceState) {
    STATE.isNavMode = forceState !== undefined ? forceState : !STATE.isNavMode;

    if (STATE.isNavMode) {
        document.body.classList.add('camera-mode-active');
        el.btnNav.classList.add('active');
        updateNavigation();
        navInterval = setInterval(updateNavigation, 5000);
    } else {
        document.body.classList.remove('camera-mode-active');
        el.btnNav.classList.remove('active');
        clearInterval(navInterval);
    }

    setTimeout(() => {
        el.canvas.width = el.vis.clientWidth;
        el.canvas.height = el.vis.clientHeight;
    }, 500);
}

const waveLayers = [
    { color: "rgba(41, 98, 255, 0.7)", speed: 0.02, phase: 0, amplitude: 1.1 },
    { color: "rgba(10, 60, 180, 0.6)", speed: 0.03, phase: Math.PI / 2, amplitude: 1.3 },
    { color: "rgba(80, 140, 255, 0.5)", speed: 0.015, phase: Math.PI, amplitude: 0.9 }
];

let animId;
function startVisualizer() {
    el.vis.style.opacity = '1';
    if (animId) return;

    const ctx = el.canvas.getContext('2d');
    el.canvas.width = el.vis.clientWidth;
    el.canvas.height = el.vis.clientHeight;

    function render() {
        animId = requestAnimationFrame(render);
        analyser.getByteFrequencyData(frequencyData);

        const { width, height } = el.canvas;
        ctx.clearRect(0, 0, width, height);

        let total = 0;
        for (let i = 0; i < frequencyData.length; i++) total += frequencyData[i];
        let avg = total / frequencyData.length;
        let vol = (avg / 128.0) * 1.5 + 0.1;

        waveLayers.forEach(layer => {
            layer.phase += layer.speed;
            ctx.beginPath();
            const grad = ctx.createLinearGradient(0, height, 0, 0);
            grad.addColorStop(0, layer.color);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.moveTo(0, height);

            for (let i = 0; i < frequencyData.length; i += 2) {
                const x = (i / (frequencyData.length - 1)) * width;
                const baseH = (frequencyData[i] / 255) * height * 0.6 * vol * layer.amplitude;
                const yOffset = Math.sin(i * 0.1 + layer.phase) * 15 * vol;
                const y = height - baseH - yOffset - 5;
                const prevX = i === 0 ? 0 : ((i - 2) / (frequencyData.length - 1)) * width;

                if (i === 0) ctx.lineTo(x, y);
                else ctx.quadraticCurveTo(prevX + (x - prevX) / 2, y, x, y);
            }
            ctx.lineTo(width, height);
            ctx.closePath();
            ctx.fill();
        });
    }
    render();
}

class SmartPlayer {
    constructor() { this.queue = []; this.isPlay = false; this.onEmpty = null; }
    add(chunk) { this.queue.push(chunk); if (!this.isPlay) this.process(); }
    async process() {
        if (this.queue.length === 0) { this.isPlay = false; if (this.onEmpty) this.onEmpty(); return; }
        this.isPlay = true; STATE.isPlaying = true;
        const blob = this.queue.shift();
        try {
            const buffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
            ttsNode = audioCtx.createBufferSource();
            ttsNode.buffer = buffer;
            ttsNode.connect(analyser); ttsNode.connect(audioCtx.destination);
            ttsNode.onended = () => this.process();
            ttsNode.start(0);
        } catch (e) { this.process(); }
    }
    stop() { if (ttsNode) { ttsNode.stop(); ttsNode = null; } this.queue = []; this.isPlay = false; STATE.isPlaying = false; }
}
const player = new SmartPlayer();

async function initVAD() {
    try {
        STATE.vad = await vad.MicVAD.new({
            onSpeechStart: () => { if (STATE.isPlaying) player.stop(); },
            onSpeechEnd: (audio) => { pauseListening(); setProcess(true); processAudio(floatToWav(audio)); }
        });
    } catch (e) { showStatus("Mic Error"); }
}

async function initGemini() {
    const gen = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
    const model = gen.getGenerativeModel({ model: "gemini-2.0-flash-lite", systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] } });
    STATE.chat = model.startChat();
}

async function processAudio(audioBlob) {
    try {
        if (!STATE.chat) await initGemini();
        const b64 = await new Promise(r => { const rd = new FileReader(); rd.onload = () => r(rd.result.split(',')[1]); rd.readAsDataURL(audioBlob); });
        const result = await STATE.chat.sendMessage([{ inlineData: { mimeType: 'audio/wav', data: b64 } }]);
        setProcess(false); showStatus("Speaking..."); streamAudio(result.response.text());
    } catch (e) { console.error(e); setProcess(false); showStatus("Error"); startListening(); }
}

function streamAudio(text) {
    player.onEmpty = () => startListening();
    const ws = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_turbo_v2_5`);
    ws.onopen = () => {
        ws.send(JSON.stringify({ text: " ", xi_api_key: CONFIG.ELEVENLABS_API_KEY }));
        ws.send(JSON.stringify({ text: text, try_trigger_generation: true }));
        ws.send(JSON.stringify({ text: "" }));
    };
    ws.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.audio) {
            const bin = atob(d.audio);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            player.add(new Blob([arr.buffer], { type: 'audio/mpeg' }));
        }
    };
}

function startListening() {
    if (!STATE.vad) return;
    audioCtx.resume();
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        if (sourceNode) sourceNode.disconnect();
        sourceNode = audioCtx.createMediaStreamSource(stream);
        sourceNode.connect(analyser);
    });
    player.stop(); STATE.vad.start(); STATE.isListening = true;
    updateMicBtns('listening'); startVisualizer(); showStatus("Listening...");
}

function pauseListening() { if (STATE.vad) STATE.vad.pause(); STATE.isListening = false; updateMicBtns('idle'); }
function setProcess(bool) { STATE.isProcessing = bool; updateMicBtns(bool ? 'processing' : 'idle'); if (bool) showStatus("Thinking..."); }
function showStatus(msg) { el.status.textContent = msg; el.status.style.display = 'block'; setTimeout(() => el.status.style.display = 'none', 3000); }
function updateMicBtns(status) {
    el.mics.forEach(btn => {
        btn.classList.remove('listening', 'processing'); btn.innerHTML = '<i class="fas fa-microphone"></i>';
        if (status === 'listening') { btn.classList.add('listening'); btn.innerHTML = '<i class="fas fa-stop"></i>'; }
        if (status === 'processing') { btn.classList.add('processing'); btn.innerHTML = ''; }
    });
}
function floatToWav(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
    const writeString = (v, o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeString(view, 36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { let s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); }
    return new Blob([view], { type: 'audio/wav' });
}