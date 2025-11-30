import { GoogleGenerativeAI } from "https://esm.run/@google/generative-ai";
import { CONFIG } from "./config.js";

// Тут мы храним слова на разных языках, чтобы приложение умело говорить
// по-английски, по-азербайджански и по-русски.
const translations = {
    en: { transport: "Transport", vibe: "Vibe", walk: "Walk", car: "Car", cultural: "Cultural", foodie: "Foodie", mountain: "Mountain", hidden: "Hidden", create: "Create Route", start: "Start", planning: "Planning...", weather_error: "Loc Error" },
    az: { transport: "Nəqliyyat", vibe: "Əhval", walk: "Piyada", car: "Maşın", cultural: "Mədəni", foodie: "Yemək", mountain: "Dağlıq", hidden: "Gizli", create: "Yarat", start: "Başla", planning: "Gözlə...", weather_error: "Xəta" },
    ru: { transport: "Транспорт", vibe: "Вайб", walk: "Пешком", car: "Авто", cultural: "Культура", foodie: "Еда", mountain: "Горы", hidden: "Скрытые", create: "Создать", start: "Начать", planning: "Ищу...", weather_error: "Ошибка" }
};

// 📦 КОРОБКИ ДЛЯ ХРАНЕНИЯ:
// map - это наша карта.
// genAI - это наш Умный Робот (Искусственный Интеллект).
// userLocation - тут мы записываем, где ты стоишь прямо сейчас.
let map, tileLayer, genAI, model;
let userLocation = { lat: 40.4093, lng: 49.8671 }; // Если GPS не сработает, начнем в Баку!
let currentSettings = { mode: 'walk', type: 'cultural' }; // По умолчанию: идем пешком смотреть культуру.
let routeLayers = []; // Сюда складываем нарисованные линии маршрута.
let markerLayer = []; // Сюда складываем булавки (точки) на карте.
let currentLang = 'en'; // Сейчас выбран английский язык.
const GRADIENT_COLORS = ['#3a86ff', '#8338ec', '#ff006e', '#fb5607', '#ffbe0b']; // Набор фломастеров для рисования линий.

// Когда страничка загрузилась
window.onload = async () => {
    initMap(); // 1. Рисуем карту.
    initAI();  // 2. Будим Умного Робота.
    setupEventListeners(); // 3. Начинаем слушать нажатия кнопок.
    
    // получаем геолокации
    // Мы просим самую точную позицию (enableHighAccuracy: true).
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(successLoc, errorLoc, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        });
    }

    // Эта функция запускается, когда ты жмешь кнопку "GO HERE" в облачке на карте.
    window.startSpecificRoute = (index) => {
        // Находим место, на которое ты нажал, в нашем списке.
        const clickedPlace = window.validPlacesList[index];
        if (!clickedPlace) return; // Если места нет, ничего не делаем.

        // 
        // сохряняем выбранное место с помощю activeRoute и передаем на другую страницу
        const newPlaces = [clickedPlace];
        localStorage.setItem('activeRoute', JSON.stringify({ 
            places: newPlaces, 
            mode: currentSettings.mode 
        }));
        
        //  Открываем страницу с голосовым навигатором.
        window.location.href = 'voice.html';
    };
};

// КАРТЫ
function initMap() {
    // Создаем карту и ставим камеру на координаты пользователя.
    map = L.map('map', { zoomControl: false }).setView([userLocation.lat, userLocation.lng], 13);
    // Наклеиваем красивые картинки улиц (плитки карты).
    tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
        attribution: '© OpenStreetMap', maxZoom: 19 
    }).addTo(map);
}

// Запускаем ИИ
function initAI() {
    // Даем ии ключ, чтобы он мог получить данные с сети 
    genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
    // Выбираем модель робота (gemini-2.0-flash - он быстрый как молния).
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
}

// Кнопки интерфейса
function setupEventListeners() {
    document.getElementById('lang-select').onchange = changeLanguage; // Смена языка
    document.getElementById('theme-btn').onclick = toggleTheme;       // Смена темы (день/ночь)
    document.getElementById('generate-btn').onclick = handleGenerateClick; // Кнопка "Создать маршрут"

    // Для кнопок выбора (Транспорт, Вайб):
    document.querySelectorAll('.choice-btn').forEach(btn => {
        btn.onclick = () => selectOption(btn.dataset.cat, btn.dataset.val, btn);
    });
}

// ЕСЛИ СПУТНИК НАШЕЛ НАС
function successLoc(pos) {
    // Записываем координаты.
    userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    // Двигаем карту к нам.
    map.setView([userLocation.lat, userLocation.lng], 15);
    
    // Если старый кружок "Я" уже был, удаляем его.
    if (window.userMarker) map.removeLayer(window.userMarker);
    
    // Рисуем синий кружок "Я здесь".
    window.userMarker = L.circleMarker([userLocation.lat, userLocation.lng], { 
        radius: 8, color: '#fff', fillColor: '#3a86ff', fillOpacity: 1 
    }).addTo(map).bindPopup("You are here");
    
    getWeather(); // Сразу узнаем погоду.
}

// если не найдет локацию
function errorLoc() { document.getElementById('weather-display').innerText = "GPS Error"; }

// УЗНАЕМ ПОГОДУ 
async function getWeather() {
    try {
        // Спрашиваем: "Какая погода в этих координатах? Ответь коротко."
        const res = await model.generateContent(`Current weather in ${userLocation.lat},${userLocation.lng}? Short text (e.g. 20°C Sunny).`);
        // Пишем ответ в уголок экрана.
        document.getElementById('weather-display').innerHTML = `<i class="fas fa-cloud"></i> ${res.response.text().trim()}`;
    } catch (e) { }
}

// КОГДА НАЖИМАЕШЬ КНОПКИ ВЫБОРА (МАШИНА ИЛИ ПЕШКОМ)
function selectOption(category, value, element) {
    currentSettings[category] = value; // Запоминаем выбор.
    
    // Убираем подсветку со всех кнопок в ряду...
    Array.from(element.parentElement.children).forEach(b => b.classList.remove('active'));
    // ...и включаем подсветку только на нажатой.
    element.classList.add('active');

    const radiusInput = document.getElementById('radius-input');

    // Если выбрали "Пешком", ставим радиус поменьше (6 км), чтобы не устать.
    // Если "Машина", ставим побольше (15 км).
    if (category === 'mode') {
        if (value === 'walk') radiusInput.value = 3; 
        if (value === 'car') radiusInput.value = 15;
    }
}

// 📏 ЛИНЕЙКА (Математика)
// Эта сложная формула считает расстояние между двумя точками на шаре (Земле).
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    var R = 6371; // Радиус Земли в километрах.
    var dLat = deg2rad(lat2 - lat1);
    var dLon = deg2rad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Вот и расстояние.
}

function deg2rad(deg) { return deg * (Math.PI / 180) }

// 🚨 ПОКАЗАТЬ ОШИБКУ (Красная табличка)
function showError(msg) {
    const errDiv = document.getElementById('error-msg');
    errDiv.innerText = msg;
    errDiv.style.display = 'block'; // Показываем блок.
    setTimeout(() => { errDiv.style.display = 'none'; }, 5000); // Через 5 секунд прячем.
}

// КНОПКА "СОЗДАТЬ МАРШРУТ"
async function handleGenerateClick() {
    const btn = document.getElementById('generate-btn');
    const originalText = btn.innerHTML;
    
    // Меняем текст кнопки на "Думаю..." и крутим спиннер.
    btn.innerHTML = `<div class="spinner"></div> ${translations[currentLang].planning}`;
    btn.disabled = true; // Блокируем кнопку, чтобы не жали сто раз.

    try {
        await generateRoute(); // Запускаем поиск!
        btn.style.display = 'none'; // Прячем кнопку, если всё получилось.
        document.getElementById('hint-msg').style.display = 'block'; // Показываем подсказку.
    } catch (e) {
        console.error(e);
        showError(e.message || "AI Error. Try again."); // Если ошибка, пишем её.
        btn.innerHTML = originalText; // Возвращаем текст кнопки.
        btn.disabled = false;
    }
}

// Логика
async function generateRoute() {
    const isMountain = currentSettings.type === 'mountain';
    // Берем радиус из настройки.
    let radiusKm = isMountain ? 300 : parseInt(document.getElementById('radius-input').value) || 5;

    // Готовим запррос аи (Промпт).
    // Мы просим его представить, что он гид, и найти места рядом с нами.
    let vibePrompt = isMountain 
        ? `MODE: MOUNTAIN EXPEDITION. SEARCH Greater Caucasus Mountains. Suggest 4 distinct accessible locations.` 
        : `Mode: ${currentSettings.mode}. Vibe: ${currentSettings.type}. Suggest 4-5 distinct stops.`;

    const prompt = `
    Role: Professional Guide.
    Task: Find REAL locations near ${userLocation.lat}, ${userLocation.lng}.
    Constraint: Max radius ${radiusKm}km.
    ${vibePrompt}
    IMPORTANT: Provide precise Latitude/Longitude coordinates for the main entrance.
    JSON OUTPUT ONLY: [ { "name": "Place Name", "lat": 0.0, "lng": 0.0, "description": "Brief info", "risk_level": "low" } ]
    `;

    // 📨 Отправляем письмо роботу и ждем (await) ответ.
    const result = await model.generateContent(prompt);
    // Чистим ответ от лишних символов.
    const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    
    let rawPlaces;
    try {
        rawPlaces = JSON.parse(text); // Превращаем текст в список объектов.
    } catch(e) {
        throw new Error("AI output malformed. Try again.");
    }

    // 🕵️ ПРОВЕРКА 1: ДАЛЕКО ЛИ ЭТО?
    // Если это не горы, проверяем, не предложил ли робот место на другом конце света.
    if (!isMountain) {
        rawPlaces = rawPlaces.filter(p => {
            const dist = getDistanceFromLatLonInKm(userLocation.lat, userLocation.lng, p.lat, p.lng);
            return dist <= (radiusKm * 1.8); // Разрешаем чуть-чуть выйти за радиус.
        });
    }

    //  ПРОВЕРКА : ЕСТЬ ЛИ ТУДА ДОРОГА? (OSRM)
    // Робот может предложить точку в центре океана или в глухом лесу.
    // Мы спрашиваем дорожный сервис (OSRM): "Можно туда дойти?"
    const validPlaces = [];
    const profile = isMountain ? 'driving' : currentSettings.mode === 'walk' ? 'walking' : 'driving';

    for (const place of rawPlaces) {
        // radiuses=1000 значит "ищи дорогу не дальше 1000 метров от точки".
        const url = `https://router.project-osrm.org/route/v1/${profile}/${userLocation.lng},${userLocation.lat};${place.lng},${place.lat}?overview=false&radiuses=1000;1000`;
        
        try {
            const res = await fetch(url); // Звоним в дорожную службу.
            const data = await res.json();
            
            // Если дорога найдена...
            if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
                // ...берем координаты САМОЙ ДОРОГИ, а не здания (так точнее для навигатора).
                const snappedDest = data.waypoints[1].location; // [lng, lat]
                place.lng = snappedDest[0];
                place.lat = snappedDest[1];
                validPlaces.push(place); // Добавляем в список хороших мест.
            }
        } catch (e) { console.warn("Road not found for", place.name); }
        
        if (validPlaces.length >= 4) break; // Нам хватит 4 места.
    }

    if (validPlaces.length === 0) {
        throw new Error(`No roads found within ${radiusKm}km.`);
    }

    window.validPlacesList = validPlaces; // Сохраняем список глобально.
    drawMap(validPlaces, isMountain);     // Рисуем!
}

// 🎨 РИСУЕМ ЛИНИИ И ТОЧКИ
async function drawMap(places, isMountain) {
    // Стираем старые линии и точки ластиком.
    routeLayers.forEach(l => map.removeLayer(l));
    routeLayers = [];
    markerLayer.forEach(m => map.removeLayer(m));
    markerLayer = [];

    const profile = isMountain ? 'driving' : currentSettings.mode === 'walk' ? 'walking' : 'driving';
    const allPointsBounds = [[userLocation.lat, userLocation.lng]]; // Список всех точек, чтобы потом настроить зум.

    // Для каждого места делаем следующее:
    const routePromises = places.map(async (place, index) => {
        // Спрашиваем точный путь (зигзаги дорог) для рисования.
        const url = `https://router.project-osrm.org/route/v1/${profile}/${userLocation.lng},${userLocation.lat};${place.lng},${place.lat}?overview=full&geometries=geojson`;
        
        try {
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.routes && data.routes.length > 0) {
                // Получаем список точек поворотов.
                const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                // Выбираем цвет фломастера.
                const color = GRADIENT_COLORS[index % GRADIENT_COLORS.length];
                
                // Рисуем жирную линию на карте.
                const polyline = L.polyline(coords, { 
                    color: color, weight: 6, opacity: 0.8 
                }).addTo(map);
                routeLayers.push(polyline);
            }
        } catch (e) {}

        allPointsBounds.push([place.lat, place.lng]);
        
        // Рисуем красивый кружочек с цифрой.
        const icon = L.divIcon({ 
            className: 'custom-div-icon', 
            html: index + 1, 
            iconSize: [30, 30],
            iconAnchor: [15, 30],
            popupAnchor: [0, -30]
        });

        // Всплывающее окошко с кнопкой "GO HERE".
        const popupContent = `
            <div style="text-align:center; min-width: 160px;">
                <h3 style="margin:0 0 5px 0; color:var(--accent);">${place.name}</h3>
                <p style="font-size:12px; color:#888; margin:0 0 10px 0;">${place.description}</p>
                <button onclick="startSpecificRoute(${index})" class="btn-popup">GO HERE <i class="fas fa-location-arrow"></i></button>
            </div>
        `;

        // Ставим булавку на карту.
        const marker = L.marker([place.lat, place.lng], { icon: icon }).addTo(map).bindPopup(popupContent);
        markerLayer.push(marker);
    });

    // Ждем, пока все нарисуется.
    await Promise.all(routePromises);

    // Делаем зум так, чтобы все точки влезли в экран.
    if (allPointsBounds.length > 1) {
        map.fitBounds(L.latLngBounds(allPointsBounds), { padding: [50, 50], maxZoom: 16 });
    }
}

// 🏳️ СМЕНА ЯЗЫКА
function changeLanguage() {
    const sel = document.getElementById('lang-select');
    currentLang = sel.value;
    const t = translations[currentLang];
    // Ищем все элементы с атрибутом data-i18n и меняем им текст.
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      if (t[k]) {
        if (el.children.length) el.childNodes[1].nodeValue = t[k];
        else el.innerText = t[k];
      }
    });
}

// 🌗 ТЕМНАЯ/СВЕТЛАЯ ТЕМА
function toggleTheme() {
    document.body.classList.toggle('light-theme');
    const isLight = document.body.classList.contains('light-theme');
    // Меняем иконку солнышка на луну.
    document.getElementById('theme-icon').className = isLight ? 'fas fa-sun' : 'fas fa-moon';
    // Меняем стиль карты.
    const url = isLight ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
    tileLayer.setUrl(url);
}
