import { GoogleGenerativeAI } from "https://cdn.jsdelivr.net/npm/@google/generative-ai/+esm";
import { CONFIG } from "./config.js";

// 📝 ИНСТРУКЦИЯ ДЛЯ РОБОТА:
// Мы говорим роботу: "Ты - Кохана, веселый гид. Говори коротко и помогай найти дорогу."
let SYSTEM_PROMPT = `You are Cohana, a witty AI guide.
1. Keep answers short (max 2 sentences).
2. You are guiding the user physically.
3. Be encouraging.`;

// 🔊 НАСТРОЙКА УШЕЙ И ГОЛОСА (AudioContext)
// Это как включить колонки и микрофон в розетку.
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const analyser = audioCtx.createAnalyser(); // Анализатор рисует волны голоса.
analyser.smoothingTimeConstant = 0.7; analyser.fftSize = 512;
const frequencyData = new Uint8Array(analyser.frequencyBinCount);

let sourceNode = null; // Сюда подключаем микрофон.
let ttsNode = null;    // Сюда подключаем голос робота.

// 🧭 ДАННЫЕ О ПУТИ
let routeData = null; // Информация о маршруте.
let watchId = null;   // Номер слежения за GPS (чтобы потом отключить).

// 📍 СГЛАЖИВАНИЕ GPS (Чтобы точка не прыгала)
// Представь, что ты держишь камеру. Если руки трясутся, картинка прыгает.
// Мы используем "Стабилизатор" (Low Pass Filter), чтобы движение было плавным.
let currentPos = { lat: null, lng: null };
const FILTER_FACTOR = 0.2; // Сила сглаживания. Чем меньше число, тем плавнее.

let currentHeading = 0; // Куда смотрит телефон (Компас).
let targetBearing = 0;  // Куда нам НАДО идти.
let lastInstructionTime = 0; // Когда мы в последний раз проверяли дорогу.

// 🤖 СОСТОЯНИЕ РОБОТА
// Спит он, слушает или говорит?
const STATE = { isNavMode: false, isListening: false, isProcessing: false, isPlaying: false, vad: null, chat: null };

// 🎮 ССЫЛКИ НА ЭКРАН (Кнопки, текст, стрелочка)
const el = {
    vis: document.getElementById('visualizerContainer'), // Волны голоса
    canvas: document.getElementById('voiceWaveCanvas'),  // Холст для рисования волн
    status: document.getElementById('statusMessage'),    // Надпись "Listening..."
    navHud: document.getElementById('navHud'),           // Экран навигации
    mics: document.querySelectorAll('.main-trigger'),    // Кнопка микрофона
    btnNav: document.getElementById('btnToggleNav'),     // Кнопка карты
    btnClose: document.getElementById('btnCloseApp'),    // Кнопка закрыть
    arrow: document.getElementById('navArrow'),          // Стрелка
    dist: document.getElementById('navDist'),            // Текст "100 м"
    time: document.getElementById('navTime'),            // Текст "5 мин"
    instr: document.getElementById('navInstruction'),    // Текст "Поверни направо"
    nextPt: document.getElementById('navNextPoint')      // Текст "К музею"
};

// Кнопка для Айфонов (им нужно особое разрешение на компас).
const iosPermBtn = document.getElementById('iosPermissionBtn'); 

// 🚀 СТАРТ ПРИЛОЖЕНИЯ
window.onload = () => {
    initVAD(); // Готовим систему распознавания голоса.

    // Проверяем, передали ли нам маршрут с прошлой страницы.
    const storedData = localStorage.getItem('activeRoute');
    if (storedData) {
        routeData = JSON.parse(storedData);
        const target = routeData.places[0];
        el.nextPt.innerText = `To: ${target.name}`; // Пишем "К: Музей"
        // Добавляем описание места в память робота, чтобы он знал, куда мы идем.
        SYSTEM_PROMPT += `\nUser is going to: ${target.name}. Route description: ${target.description || ''}`;
        toggleNavMode(true); // Включаем режим навигации.
    } else {
        el.instr.innerText = "No route. Return to map.";
    }

    // 🧭 НАСТРОЙКА КОМПАСА
    if (window.DeviceOrientationEvent) {
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            // Если это Айфон, показываем спец-кнопку.
            if(iosPermBtn) iosPermBtn.style.display = 'block';
        } else {
            // Если Андроид, просто слушаем повороты.
            window.addEventListener('deviceorientation', handleOrientation);
        }
    }

    // Обработка кнопки Айфона
    if(iosPermBtn) {
        iosPermBtn.onclick = () => {
            DeviceOrientationEvent.requestPermission()
            .then(response => {
                if (response === 'granted') {
                    window.addEventListener('deviceorientation', handleOrientation);
                    iosPermBtn.style.display = 'none'; // Прячем кнопку, если разрешили.
                }
            }).catch(console.error);
        };
    }

    // Настройка кнопок на экране
    el.btnNav.onclick = () => toggleNavMode();
    el.btnClose.onclick = () => window.location.href = 'index.html'; // Назад на карту
    
    // Кнопка микрофона
    el.mics.forEach(b => b.onclick = () => {
        if (STATE.isProcessing) return; // Если робот думает, не мешаем.
        if (STATE.isListening) { pauseListening(); showStatus("Paused"); }
        else { if (STATE.isPlaying) player.stop(); startListening(); }
    });

    // Если изменили размер окна, поправляем рисовалку волн.
    window.addEventListener('resize', () => { 
        el.canvas.width = el.vis.clientWidth; 
        el.canvas.height = el.vis.clientHeight; 
    });
};

// 🔄 КОГДА ТЕЛЕФОН ПОВОРАЧИВАЕТСЯ
function handleOrientation(event) {
    let heading = 0;
    // Айфон и Андроид дают данные по-разному. Тут мы их приводим к общему виду.
    if (event.webkitCompassHeading) {
        heading = event.webkitCompassHeading;
    } else if (event.alpha !== null) {
        heading = 360 - event.alpha; 
    }
    currentHeading = heading;
    updateCompassUI(); // Крутим стрелку на экране.
}

// 🎯 КРУТИМ СТРЕЛКУ
function updateCompassUI() {
    if (!STATE.isNavMode) return;
    // Считаем разницу: Куда НАДО идти минус Куда СМОТРИМ.
    let relativeBearing = targetBearing - currentHeading;
    // Математика круга (чтобы не крутилась на 360 лишний раз).
    while (relativeBearing < -180) relativeBearing += 360;
    while (relativeBearing > 180) relativeBearing -= 360;
    
    // Поворачиваем картинку стрелки (CSS transform).
    el.arrow.style.transform = `rotate(${relativeBearing}deg)`;
}

// 🗺️ ВКЛЮЧИТЬ/ВЫКЛЮЧИТЬ НАВИГАЦИЮ
function toggleNavMode(forceState) {
    STATE.isNavMode = forceState !== undefined ? forceState : !STATE.isNavMode;

    if (STATE.isNavMode) {
        document.body.classList.add('camera-mode-active'); // Включаем камеру (стили).
        el.btnNav.classList.add('active');
        startTracking(); // 🏃 НАЧИНАЕМ СЛЕДИТЬ ЗА GPS
    } else {
        document.body.classList.remove('camera-mode-active');
        el.btnNav.classList.remove('active');
        stopTracking(); // 🛑 ОСТАНАВЛИВАЕМ СЛЕЖКУ
    }
    
    setTimeout(() => {
        el.canvas.width = el.vis.clientWidth;
        el.canvas.height = el.vis.clientHeight;
    }, 500);
}

// 🛰️ ЗАПУСК GPS
function startTracking() {
    if (watchId) return; // Если уже следим, не дублируем.
    if (!navigator.geolocation) { showStatus("No GPS"); return; }

    // watchPosition говорит спутнику: "Сообщай мне каждый мой шаг".
    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;

            // 🍬 СГЛАЖИВАНИЕ (Фильтр)
            // Если это первая точка, просто берем её.
            if (currentPos.lat === null) {
                currentPos = { lat, lng };
            } else {
                // Иначе берем 80% старой точки и 20% новой.
                // Это убирает резкие скачки GPS.
                currentPos.lat = currentPos.lat * (1 - FILTER_FACTOR) + lat * FILTER_FACTOR;
                currentPos.lng = currentPos.lng * (1 - FILTER_FACTOR) + lng * FILTER_FACTOR;
            }

            // Каждые 4 секунды (4000 мс) пересчитываем маршрут.
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

// 🛑 ОСТАНОВКА GPS
function stopTracking() {
    if (watchId) {
        navigator.geolocation.clearWatch(watchId); // Говорим спутнику: "Хватит следить".
        watchId = null;
    }
}

// 📐 ПЕРЕСЧЕТ МАРШРУТА
async function updateRouteCalculation() {
    if (!routeData || !currentPos.lat) return;

    const target = routeData.places[0];
    const profile = routeData.mode === 'walk' ? 'walking' : 'driving';
    
    // Спрашиваем OSRM путь от текущей точки до цели.
    // steps=true значит "расскажи каждый поворот".
    const url = `https://router.project-osrm.org/route/v1/${profile}/${currentPos.lng},${currentPos.lat};${target.lng},${target.lat}?steps=true&overview=false`;

    try {
        const res = await fetch(url);
        const data = await res.json();

        if (data.routes && data.routes.length > 0) {
            const route = data.routes[0];
            const steps = route.legs[0].steps;
            
            // Обновляем цифры на экране (Метры и Минуты).
            updateDistTimeUI(route.distance, route.duration);

            // 🛣️ ЛОГИКА ПОВОРОТОВ
            // steps[0] - это где мы сейчас едем.
            // steps[1] - это следующий маневр (поворот).
            if (steps.length > 1) {
                const nextStep = steps[1];
                
                // bearing_after - это угол, куда надо повернуть. Сохраняем для стрелки.
                if(nextStep.maneuver && nextStep.maneuver.bearing_after) {
                    targetBearing = nextStep.maneuver.bearing_after;
                }
                
                // Считаем расстояние до поворота.
                const distToTurn = steps[0].distance;
                if (distToTurn < 30) {
                    // Если меньше 30 метров - КРИЧИМ "ПОВОРАЧИВАЙ!" (зеленым цветом)
                    el.instr.innerText = `TURN NOW: ${humanizeManeuver(nextStep.maneuver)}`;
                    el.instr.style.color = '#00e676';
                } else {
                    // Если еще далеко - просто предупреждаем.
                    el.instr.innerText = `In ${Math.round(distToTurn)}m: ${humanizeManeuver(nextStep.maneuver)}`;
                    el.instr.style.color = '#ccd';
                }
            } else {
                // Если шагов больше нет - мы приехали!
                el.instr.innerText = "Destination ahead!";
                targetBearing = 0; 
            }
            
            updateCompassUI(); // Обновляем стрелку.
        }
    } catch (e) { console.error(e); }
}

// 🗣️ ПЕРЕВОДЧИК С РОБОТСКОГО НА ЧЕЛОВЕЧЕСКИЙ
// OSRM пишет "turn left", мы делаем красиво "Turn Left".
function humanizeManeuver(m) {
    if (!m) return "Go Straight";
    const mod = m.modifier ? m.modifier.replace('left', 'Left').replace('right', 'Right') : '';
    if (m.type === 'turn') return `Turn ${mod}`;
    if (m.type === 'new name') return `Continue`;
    if (m.type === 'arrive') return `Arrive`;
    return `${m.type} ${mod}`;
}

// ⏱️ КРАСИВЫЕ ЦИФРЫ (КМ и МИН)
function updateDistTimeUI(distMeters, timeSec) {
    if (distMeters >= 1000) {
        // Если больше 1000м, пишем в километрах (1.2 km).
        el.dist.innerText = `${(distMeters / 1000).toFixed(1)} km`;
    } else {
        // Иначе в метрах (500 m).
        el.dist.innerText = `${Math.round(distMeters)} m`;
    }
    // Округляем секунды до минут.
    el.time.innerText = `${Math.ceil(timeSec / 60)} min`;
}

// --- ВИЗУАЛИЗАТОР (Красивые волны когда робот говорит) ---
// Это просто рисование линий, которые прыгают под музыку.

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
        analyser.getByteFrequencyData(frequencyData); // Берем данные о громкости.
        const { width, height } = el.canvas;
        ctx.clearRect(0, 0, width, height); // Чистим экран.

        let total = 0;
        for (let i = 0; i < frequencyData.length; i++) total += frequencyData[i];
        let vol = (total / frequencyData.length / 128.0) * 1.5 + 0.1; // Вычисляем общую громкость.

        // Рисуем каждую волну (слой).
        waveLayers.forEach(layer => {
            layer.phase += layer.speed; // Двигаем волну.
            ctx.beginPath();
            const grad = ctx.createLinearGradient(0, height, 0, 0);
            grad.addColorStop(0, layer.color);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = grad;
            ctx.moveTo(0, height);

            // Рисуем кривую линию.
            for (let i = 0; i < frequencyData.length; i += 5) { 
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

// 🎼 УМНЫЙ ПЛЕЕР
// Он умеет играть аудио кусочками, как только они приходят из интернета.
class SmartPlayer {
    constructor() { this.queue = []; this.isPlay = false; this.onEmpty = null; }
    
    // Добавить кусочек аудио в очередь.
    add(chunk) { this.queue.push(chunk); if (!this.isPlay) this.process(); }
    
    // Играть следующий кусок.
    async process() {
        if (this.queue.length === 0) { 
            this.isPlay = false; 
            if (this.onEmpty) this.onEmpty(); // Если все доиграли, запускаем микрофон.
            return; 
        }
        this.isPlay = true; STATE.isPlaying = true;
        const blob = this.queue.shift(); // Берем первый кусок.
        try {
            // Декодируем звук.
            const buffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
            ttsNode = audioCtx.createBufferSource();
            ttsNode.buffer = buffer;
            ttsNode.connect(analyser); // Подключаем к рисовалке волн.
            ttsNode.connect(audioCtx.destination); // Подключаем к динамикам.
            ttsNode.onended = () => this.process(); // Когда доиграл, играем следующий.
            ttsNode.start(0);
        } catch (e) { this.process(); }
    }
    // Остановить все звуки.
    stop() { if (ttsNode) { try{ttsNode.stop();}catch(e){} ttsNode = null; } this.queue = []; this.isPlay = false; STATE.isPlaying = false; }
}
const player = new SmartPlayer();

// 🎤 НАСТРОЙКА РАСПОЗНАВАНИЯ ГОЛОСА (VAD)
async function initVAD() {
    try {
        STATE.vad = await vad.MicVAD.new({
            // Когда ты начал говорить - плеер затыкается.
            onSpeechStart: () => { if (STATE.isPlaying) player.stop(); },
            // Когда закончил - отправляем запись роботу.
            onSpeechEnd: (audio) => { pauseListening(); setProcess(true); processAudio(floatToWav(audio)); }
        });
    } catch (e) { showStatus("Mic Error"); }
}

// 💬 БОЛТАЛКА С GEMINI
async function initGemini() {
    const gen = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
    const model = gen.getGenerativeModel({ model: "gemini-2.5-flash-lite", systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] } });
    STATE.chat = model.startChat();
}

// 📨 ОТПРАВКА ГОЛОСА РОБОТУ
async function processAudio(audioBlob) {
    try {
        if (!STATE.chat) await initGemini();
        // Превращаем аудио в текст для робота (base64).
        const b64 = await new Promise(r => { const rd = new FileReader(); rd.onload = () => r(rd.result.split(',')[1]); rd.readAsDataURL(audioBlob); });
        
        // Добавляем к сообщению наши координаты (невидимо для пользователя), чтобы робот знал, где мы.
        const locContext = currentPos.lat ? ` [My Loc: ${currentPos.lat.toFixed(4)},${currentPos.lng.toFixed(4)}]` : "";
        
        // Отправляем!
        const result = await STATE.chat.sendMessage([{ inlineData: { mimeType: 'audio/wav', data: b64 } }, {text: locContext}]);
        setProcess(false); showStatus("Speaking..."); 
        streamAudio(result.response.text()); // Читаем ответ вслух.
    } catch (e) { console.error(e); setProcess(false); showStatus("Error"); startListening(); }
}

// 🗣️ ПРЕВРАЩЕНИЕ ТЕКСТА В ГОЛОС (ElevenLabs)
function streamAudio(text) {
    player.onEmpty = () => startListening(); // Когда договорит, снова слушает.
    // Соединяемся с сервером голоса.
    const ws = new WebSocket(`wss://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_turbo_v2_5`);
    ws.onopen = () => {
        ws.send(JSON.stringify({ text: " ", xi_api_key: CONFIG.ELEVENLABS_API_KEY })); // Приветствие.
        ws.send(JSON.stringify({ text: text, try_trigger_generation: true })); // Текст.
        ws.send(JSON.stringify({ text: "" })); // Конец.
    };
    ws.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.audio) {
            // Превращаем полученные данные в звук.
            const bin = atob(d.audio);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            player.add(new Blob([arr.buffer], { type: 'audio/mpeg' })); // Добавляем в плеер.
        }
    };
}

// ▶️ НАЧАТЬ СЛУШАТЬ
function startListening() {
    if (!STATE.vad) return;
    audioCtx.resume();
    // Включаем микрофон.
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        if (sourceNode) { sourceNode.disconnect(); } 
        sourceNode = audioCtx.createMediaStreamSource(stream);
        sourceNode.connect(analyser); // Рисуем волны от микрофона.
    }).catch(e => console.log(e));

    player.stop(); STATE.vad.start(); STATE.isListening = true;
    updateMicBtns('listening'); startVisualizer(); showStatus("Listening...");
}

// ⏸️ ПАУЗА
function pauseListening() { if (STATE.vad) STATE.vad.pause(); STATE.isListening = false; updateMicBtns('idle'); }

// ⏳ ИНДИКАТОРЫ
function setProcess(bool) { STATE.isProcessing = bool; updateMicBtns(bool ? 'processing' : 'idle'); if (bool) showStatus("Thinking..."); }
function showStatus(msg) { el.status.textContent = msg; el.status.style.display = 'block'; setTimeout(() => el.status.style.display = 'none', 3000); }

// 🔘 КНОПКИ МИКРОФОНА (Меняют иконки)
function updateMicBtns(status) {
    el.mics.forEach(btn => {
        btn.classList.remove('listening', 'processing'); btn.innerHTML = '<i class="fas fa-microphone"></i>';
        if (status === 'listening') { btn.classList.add('listening'); btn.innerHTML = '<i class="fas fa-stop"></i>'; } // Квадратик (Стоп)
        if (status === 'processing') { btn.classList.add('processing'); btn.innerHTML = ''; } // Пусто (Грузится)
    });
}

// 🛠️ ТЕХНИЧЕСКАЯ ФУНКЦИЯ (Конвертер аудио)
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
