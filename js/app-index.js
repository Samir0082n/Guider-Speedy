import { GoogleGenerativeAI } from "https://esm.run/@google/generative-ai";
import { CONFIG } from "./config.js";

const translations = {
    en: { transport: "Transport", vibe: "Vibe", walk: "Walk", car: "Car", cultural: "Cultural", foodie: "Foodie", mountain: "Mountain", hidden: "Hidden", create: "Create Route", start: "Start", planning: "Planning...", weather_error: "Loc Error" },
    az: { transport: "Nəqliyyat", vibe: "Əhval", walk: "Piyada", car: "Maşın", cultural: "Mədəni", foodie: "Yemək", mountain: "Dağlıq", hidden: "Gizli", create: "Yarat", start: "Başla", planning: "Gözlə...", weather_error: "Xəta" },
    ru: { transport: "Транспорт", vibe: "Вайб", walk: "Пешком", car: "Авто", cultural: "Культура", foodie: "Еда", mountain: "Горы", hidden: "Скрытые", create: "Создать", start: "Начать", planning: "Ищу...", weather_error: "Ошибка" }
};

let map, tileLayer, genAI, model;
let userLocation = { lat: 40.4093, lng: 49.8671 }; // Default fallback
let currentSettings = { mode: 'walk', type: 'cultural' };
let routeLayers = [];
let markerLayer = [];
let currentLang = 'en';
const GRADIENT_COLORS = ['#3a86ff', '#8338ec', '#ff006e', '#fb5607', '#ffbe0b'];

window.onload = async () => {
    initMap();
    initAI();
    setupEventListeners();
    
    // Запрашиваем геолокацию сразу с высокой точностью
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(successLoc, errorLoc, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        });
    }

    window.startSpecificRoute = (index) => {
        const clickedPlace = window.validPlacesList[index];
        if (!clickedPlace) return;

        // Создаем маршрут только к выбранной точке
        const newPlaces = [clickedPlace];
        localStorage.setItem('activeRoute', JSON.stringify({ 
            places: newPlaces, 
            mode: currentSettings.mode 
        }));
        window.location.href = 'voice.html';
    };
};

function initMap() {
    map = L.map('map', { zoomControl: false }).setView([userLocation.lat, userLocation.lng], 13);
    tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
        attribution: '© OpenStreetMap', maxZoom: 19 
    }).addTo(map);
}

function initAI() {
    genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
}

function setupEventListeners() {
    document.getElementById('lang-select').onchange = changeLanguage;
    document.getElementById('theme-btn').onclick = toggleTheme;
    document.getElementById('generate-btn').onclick = handleGenerateClick;

    document.querySelectorAll('.choice-btn').forEach(btn => {
        btn.onclick = () => selectOption(btn.dataset.cat, btn.dataset.val, btn);
    });
}

function successLoc(pos) {
    userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    map.setView([userLocation.lat, userLocation.lng], 15);
    
    // Удаляем старый маркер "Я", если есть, и ставим новый
    if (window.userMarker) map.removeLayer(window.userMarker);
    
    window.userMarker = L.circleMarker([userLocation.lat, userLocation.lng], { 
        radius: 8, color: '#fff', fillColor: '#3a86ff', fillOpacity: 1 
    }).addTo(map).bindPopup("You are here");
    
    getWeather();
}

function errorLoc() { document.getElementById('weather-display').innerText = "GPS Error"; }

async function getWeather() {
    try {
        const res = await model.generateContent(`Current weather in ${userLocation.lat},${userLocation.lng}? Short text (e.g. 20°C Sunny).`);
        document.getElementById('weather-display').innerHTML = `<i class="fas fa-cloud"></i> ${res.response.text().trim()}`;
    } catch (e) { }
}

function selectOption(category, value, element) {
    currentSettings[category] = value;
    Array.from(element.parentElement.children).forEach(b => b.classList.remove('active'));
    element.classList.add('active');

    const transportCont = document.getElementById('transport-container');
    const radiusCont = document.getElementById('radius-container');
    const radiusInput = document.getElementById('radius-input');

    if (category === 'mode') {
        if (value === 'walk') radiusInput.value = 3; // Уменьшил дефолт для пешеходов
        if (value === 'car') radiusInput.value = 15;
    }

    if (category === 'type') {
        if (value === 'mountain') {
            transportCont.classList.add('hidden');
            radiusCont.classList.add('hidden');
            currentSettings.mode = 'walk';
        } else {
            transportCont.classList.remove('hidden');
            radiusCont.classList.remove('hidden');
        }
    }
}

// Проверка расстояния по прямой (Haversine Formula)
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = deg2rad(lat2 - lat1);
    var dLon = deg2rad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function deg2rad(deg) { return deg * (Math.PI / 180) }

function showError(msg) {
    const errDiv = document.getElementById('error-msg');
    errDiv.innerText = msg;
    errDiv.style.display = 'block';
    setTimeout(() => { errDiv.style.display = 'none'; }, 5000);
}

async function handleGenerateClick() {
    const btn = document.getElementById('generate-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<div class="spinner"></div> ${translations[currentLang].planning}`;
    btn.disabled = true;
    document.getElementById('error-msg').style.display = 'none';
    document.getElementById('hint-msg').style.display = 'none';

    try {
        await generateRoute();
        btn.style.display = 'none';
        document.getElementById('hint-msg').style.display = 'block';
    } catch (e) {
        console.error(e);
        showError(e.message || "AI Error. Try again.");
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function generateRoute() {
    const isMountain = currentSettings.type === 'mountain';
    let radiusKm = isMountain ? 300 : parseInt(document.getElementById('radius-input').value) || 5;

    // Улучшенный промпт для точности координат
    let vibePrompt = isMountain 
        ? `MODE: MOUNTAIN EXPEDITION. SEARCH Greater Caucasus Mountains. Suggest 4 distinct accessible locations.` 
        : `Mode: ${currentSettings.mode}. Vibe: ${currentSettings.type}. Suggest 4-5 distinct stops.`;

    const prompt = `
    Role: Professional Guide.
    Task: Find REAL locations near ${userLocation.lat}, ${userLocation.lng}.
    Constraint: Max radius ${radiusKm}km.
    ${vibePrompt}
    IMPORTANT: Provide precise Latitude/Longitude coordinates for the main entrance/access point.
    JSON OUTPUT ONLY: [ { "name": "Place Name", "lat": 0.0, "lng": 0.0, "description": "Brief info", "risk_level": "low" } ]
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    let rawPlaces;
    try {
        rawPlaces = JSON.parse(text);
    } catch(e) {
        throw new Error("AI output malformed. Try again.");
    }

    // 1. Фильтр радиуса (грубый)
    if (!isMountain) {
        rawPlaces = rawPlaces.filter(p => {
            const dist = getDistanceFromLatLonInKm(userLocation.lat, userLocation.lng, p.lat, p.lng);
            return dist <= (radiusKm * 1.8); // Даем небольшой запас AI
        });
    }

    // 2. Валидация через OSRM (Проверка доступности)
    const validPlaces = [];
    const profile = isMountain ? 'driving' : currentSettings.mode === 'walk' ? 'walking' : 'driving';

    for (const place of rawPlaces) {
        // Добавляем radiuses=1000, чтобы найти ближайшую дорогу в радиусе 1000м от точки (помогает, если точка в парке)
        const url = `https://router.project-osrm.org/route/v1/${profile}/${userLocation.lng},${userLocation.lat};${place.lng},${place.lat}?overview=false&radiuses=1000;1000`;
        
        try {
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
                // Если OSRM нашел маршрут, используем координаты "привязанные" к дороге для лучшей навигации
                const snappedDest = data.waypoints[1].location; // [lng, lat]
                place.lng = snappedDest[0];
                place.lat = snappedDest[1];
                validPlaces.push(place);
            }
        } catch (e) { console.warn("OSRM check failed for", place.name); }
        
        if (validPlaces.length >= 4) break;
    }

    if (validPlaces.length === 0) {
        throw new Error(`No reachable paths found within ${radiusKm}km.`);
    }

    window.validPlacesList = validPlaces;
    drawMap(validPlaces, isMountain);
}

async function drawMap(places, isMountain) {
    routeLayers.forEach(l => map.removeLayer(l));
    routeLayers = [];
    markerLayer.forEach(m => map.removeLayer(m));
    markerLayer = [];

    const profile = isMountain ? 'driving' : currentSettings.mode === 'walk' ? 'walking' : 'driving';
    const allPointsBounds = [[userLocation.lat, userLocation.lng]];

    const routePromises = places.map(async (place, index) => {
        // Запрос геометрии маршрута
        const url = `https://router.project-osrm.org/route/v1/${profile}/${userLocation.lng},${userLocation.lat};${place.lng},${place.lat}?overview=full&geometries=geojson`;
        
        try {
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.routes && data.routes.length > 0) {
                const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                const color = GRADIENT_COLORS[index % GRADIENT_COLORS.length];
                
                // Рисуем линию
                const polyline = L.polyline(coords, { 
                    color: color, weight: 6, opacity: 0.8 
                }).addTo(map);
                routeLayers.push(polyline);
            }
        } catch (e) {}

        allPointsBounds.push([place.lat, place.lng]);
        
        const icon = L.divIcon({ 
            className: 'custom-div-icon', 
            html: index + 1, 
            iconSize: [30, 30],
            iconAnchor: [15, 30],
            popupAnchor: [0, -30]
        });

        const popupContent = `
            <div style="text-align:center; min-width: 160px;">
                <h3 style="margin:0 0 5px 0; color:var(--accent);">${place.name}</h3>
                <p style="font-size:12px; color:#888; margin:0 0 10px 0;">${place.description}</p>
                <button onclick="startSpecificRoute(${index})" class="btn-popup">GO HERE <i class="fas fa-location-arrow"></i></button>
            </div>
        `;

        const marker = L.marker([place.lat, place.lng], { icon: icon }).addTo(map).bindPopup(popupContent);
        markerLayer.push(marker);
    });

    await Promise.all(routePromises);

    if (allPointsBounds.length > 1) {
        map.fitBounds(L.latLngBounds(allPointsBounds), { padding: [50, 50], maxZoom: 16 });
    }
}

function changeLanguage() {
    // ... (старый код без изменений)
    const sel = document.getElementById('lang-select');
    currentLang = sel.value;
    const t = translations[currentLang];
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      if (t[k]) {
        if (el.children.length) el.childNodes[1].nodeValue = t[k];
        else el.innerText = t[k];
      }
    });
}

function toggleTheme() {
    // ... (старый код без изменений)
    document.body.classList.toggle('light-theme');
    const isLight = document.body.classList.contains('light-theme');
    document.getElementById('theme-icon').className = isLight ? 'fas fa-sun' : 'fas fa-moon';
    const url = isLight ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
    tileLayer.setUrl(url);
}
