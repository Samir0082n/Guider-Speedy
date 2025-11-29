import { GoogleGenerativeAI } from "https://cdn.jsdelivr.net/npm/@google/generative-ai/+esm";
import { CONFIG } from "./config.js";

let SYSTEM_PROMPT = `You are Cohana, a witty AI guide.
1. Keep answers short (max 2 sentences).
2. You are guiding the user physically.
3. Be encouraging.`;

// --- AUDIO SETUP ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const analyser = audioCtx.createAnalyser();
analyser.smoothingTimeConstant = 0.7; analyser.fftSize = 512;
const frequencyData = new Uint8Array(analyser.frequencyBinCount);

let sourceNode = null;
let ttsNode = null;

// --- NAVIGATION STATE ---
let routeData = null;
let watchId = null;

// Переменные для сглаживания GPS (Low Pass Filter)
let currentPos = { lat: null, lng: null };
const FILTER_FACTOR = 0.2; // 0.1 (сильное сглаживание) - 1.0 (без сглаживания)

let currentHeading = 0;
let targetBearing = 0;
let lastInstructionTime = 0;

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

// Кнопка для запроса разрешения компаса на iOS
const iosPermBtn = document.getElementById('iosPermissionBtn'); 

window.onload = () => {
    initVAD();

    const storedData = localStorage.getItem('activeRoute');
    if (storedData) {
        routeData = JSON.parse(storedData);
        const target = routeData.places[0];
        el.nextPt.innerText = `To: ${target.name}`;
        SYSTEM_PROMPT += `\nUser is going to: ${target.name}. Route description: ${target.description || ''}`;
        toggleNavMode(true);
    } else {
        el.instr.innerText = "No route. Return to map.";
    }

    // Обработка ориентации (Компас)
    if (window.DeviceOrientationEvent) {
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            // iOS 13+ требует кнопку
            if(iosPermBtn) iosPermBtn.style.display = 'block';
        } else {
            window.addEventListener('deviceorientation', handleOrientation);
        }
    }

    // Listeners
    if(iosPermBtn) {
        iosPermBtn.onclick = () => {
            DeviceOrientationEvent.requestPermission()
            .then(response => {
                if (response === 'granted') {
                    window.addEventListener('deviceorientation', handleOrientation);
                    iosPermBtn.style.display = 'none';
                }
            }).catch(console.error);
        };
    }

    el.btnNav.onclick = () => toggleNavMode();
    el.btnClose.onclick = () => window.location.href = 'index.html';
    
    el.mics.forEach(b => b.onclick = () => {
        if (STATE.isProcessing) return;
        if (STATE.isListening) { pauseListening(); showStatus("Paused"); }
        else { if (STATE.isPlaying) player.stop(); startListening(); }
    });

    window.addEventListener('resize', () => { 
        el.canvas.width = el.vis.clientWidth; 
        el.canvas.height = el.vis.clientHeight; 
    });
};

function handleOrientation(event) {
    let heading = 0;
    // iOS (webkitCompassHeading) vs Android (alpha)
    if (event.webkitCompassHeading) {
        heading = event.webkitCompassHeading;
    } else if (event.alpha !== null) {
        heading = 360 - event.alpha; // Android rotation is counter-clockwise
    }
    currentHeading = heading;
    updateCompassUI();
}

function updateCompassUI() {
    if (!STATE.isNavMode) return;
    // Вычисляем угол поворота стрелки относительно телефона
    let relativeBearing = targetBearing - currentHeading;
    // Нормализация угла (-180 до 180)
    while (relativeBearing < -180) relativeBearing += 360;
    while (relativeBearing > 180) relativeBearing -= 360;
    
    el.arrow.style.transform = `rotate(${relativeBearing}deg)`;
}

// Запуск навигации
function toggleNavMode(forceState) {
    STATE.isNavMode = forceState !== undefined ? forceState : !STATE.isNavMode;

    if (STATE.isNavMode) {
        document.body.classList.add('camera-mode-active');
        el.btnNav.classList.add('active');
        startTracking(); // Запускаем GPS трекинг
    } else {
        document.body.classList.remove('camera-mode-active');
        el.btnNav.classList.remove('active');
        stopTracking();
    }
    
    setTimeout(() => {
        el.canvas.width = el.vis.clientWidth;
        el.canvas.height = el.vis.clientHeight;
    }, 500);
}

function startTracking() {
    if (watchId) return;
    if (!navigator.geolocation) { showStatus("No GPS"); return; }

    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;

            // Low-Pass Filter для сглаживания координат
            if (currentPos.lat === null) {
                currentPos = { lat, lng };
            } else {
                currentPos.lat = currentPos.lat * (1 - FILTER_FACTOR) + lat * FILTER_FACTOR;
                currentPos.lng = currentPos.lng * (1 - FILTER_FACTOR) + lng * FILTER_FACTOR;
            }

            // Обновляем маршрут каждые 3-4 секунды или если мы близко
            const now = Date.now();
            if (now - lastInstructionTime > 4000) {
                updateRouteCalculation();
                lastInstructionTime = now;
            }
        },
        (err) => console.log("GPS Err", err),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
    );
}

function stopTracking() {
    if (watchId) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
}

async function updateRouteCalculation() {
    if (!routeData || !currentPos.lat) return;

    const target = routeData.places[0];
    const profile = routeData.mode === 'walk' ? 'walking' : 'driving';
    
    // Запрос к OSRM с текущими сглаженными координатами
    // steps=true нужен для получения маневров
    const url = `https://router.project-osrm.org/route/v1/${profile}/${currentPos.lng},${currentPos.lat};${target.lng},${target.lat}?steps=true&overview=false`;

    try {
        const res = await fetch(url);
        const data = await res.json();

        if (data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            const legs = route.legs[0];
            const steps = legs.steps;
            
            // Расстояние и время до финиша
            updateDistTimeUI(route.distance, route.duration);

            // Логика следующего шага
            // steps[0] - это обычно "current road", steps[1] - "next maneuver"
            if (steps.length > 1) {
                const nextStep = steps[1]; // Следующий маневр
                // Берем bearing (направление) маневра для стрелки
                if(nextStep.maneuver && nextStep.maneuver.bearing_after) {
                    targetBearing = nextStep.maneuver.bearing_after;
                }
                
                // Инструкция: что делать ДАЛЬШЕ
                let instrText = nextStep.maneuver.type || 'go';
                if (nextStep.maneuver.modifier) instrText += ` ${nextStep.maneuver.modifier}`;
                
                // Формируем красивый текст
                const distToTurn = steps[0].distance;
                if (distToTurn < 30) {
                    el.instr.innerText = `TURN NOW: ${humanizeManeuver(nextStep.maneuver)}`;
                    el.instr.style.color = '#00e676';
                } else {
                    el.instr.innerText = `In ${Math.round(distToTurn)}m: ${humanizeManeuver(nextStep.maneuver)}`;
                    el.instr.style.color = '#ccd';
                }
            } else {
                // Мы на финишной прямой
                el.instr.innerText = "Destination ahead!";
                targetBearing = 0; // Сброс, или можно вычислить азимут к точке
            }
            
            updateCompassUI();
        }
    } catch (e) { console.error(e); }
}

function humanizeManeuver(m) {
    if (!m) return "Go Straight";
    const mod = m.modifier ? m.modifier.replace('left', 'Left').replace('right', 'Right') : '';
    if (m.type === 'turn') return `Turn ${mod}`;
    if (m.type === 'new name') return `Continue`;
    if (m.type === 'arrive') return `Arrive`;
    return `${m.type} ${mod}`;
}

function updateDistTimeUI(distMeters, timeSec) {
    if (distMeters >= 1000) {
        el.dist.innerText = `${(distMeters / 1000).toFixed(1)} km`;
    } else {
        el.dist.innerText = `${Math.round(distMeters)} m`;
    }
    el.time.innerText = `${Math.ceil(timeSec / 60)} min`;
}

// --- ВИЗУАЛИЗАТОР, АУДИО И ИИ (Остаются практически без изменений, но причесаны) ---

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
    
    function render() {
        animId = requestAnimationFrame(render);
        analyser.getByteFrequencyData(frequencyData);
        const { width, height } = el.canvas;
        ctx.clearRect(0, 0, width, height);

        let total = 0;
        for (let i = 0; i < frequencyData.length; i++) total += frequencyData[i];
        let vol = (total / frequencyData.length / 128.0) * 1.5 + 0.1;

        waveLayers.forEach(layer => {
            layer.phase += layer.speed;
            ctx.beginPath();
            const grad = ctx.createLinearGradient(0, height, 0, 0);
            grad.addColorStop(0, layer.color);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.moveTo(0, height);

            for (let i = 0; i < frequencyData.length; i += 5) { // Оптимизация шага
                const x = (i / (frequencyData.length - 1)) * width;
                const baseH = (frequencyData[i] / 255) * height * 0.6 * vol * layer.amplitude;
                const y = height - baseH - Math.sin(i * 0.1 + layer.phase) * 15 * vol;
                if (i === 0) ctx.lineTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.lineTo(width, height);
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
    stop() { if (ttsNode) { try{ttsNode.stop();}catch(e){} ttsNode = null; } this.queue = []; this.isPlay = false; STATE.isPlaying = false; }
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
        
        // Add current location context to the message invisibly
        const locContext = currentPos.lat ? ` [My Loc: ${currentPos.lat.toFixed(4)},${currentPos.lng.toFixed(4)}]` : "";
        
        const result = await STATE.chat.sendMessage([{ inlineData: { mimeType: 'audio/wav', data: b64 } }, {text: locContext}]);
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
    // Use getUserMedia to ensure context is unlocked
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        if (sourceNode) { sourceNode.disconnect(); } 
        sourceNode = audioCtx.createMediaStreamSource(stream);
        sourceNode.connect(analyser); // Connect mic to visualizer directly
    }).catch(e => console.log(e));

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
