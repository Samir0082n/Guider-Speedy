import { GoogleGenerativeAI } from "https://esm.run/@google/generative-ai";
import { CONFIG } from "./config.js";

const translations = {
  en: { transport: "Transport", vibe: "Vibe", walk: "Walk", car: "Car", cultural: "Cultural", foodie: "Foodie", mountain: "Mountain", hidden: "Hidden", create: "Create Route", start: "Start", planning: "Planning...", weather_error: "Loc Error" },
  az: { transport: "Nəqliyyat", vibe: "Əhval", walk: "Piyada", car: "Maşın", cultural: "Mədəni", foodie: "Yemək", mountain: "Dağlıq", hidden: "Gizli", create: "Yarat", start: "Başla", planning: "Gözlə...", weather_error: "Xəta" },
  ru: { transport: "Транспорт", vibe: "Вайб", walk: "Пешком", car: "Авто", cultural: "Культура", foodie: "Еда", mountain: "Горы", hidden: "Скрытые", create: "Создать", start: "Начать", planning: "Ищу...", weather_error: "Ошибка" }
};

let map, tileLayer, genAI, model;
let userLocation = { lat: 40.4093, lng: 49.8671 };
let currentSettings = { mode: 'walk', type: 'cultural' };
let routeLayers = [];
let markerLayer = [];
let currentLang = 'en';

const GRADIENT_COLORS = ['#2ecc71', '#27ae60', '#145a32', '#000000'];
const DEFAULT_COLOR = '#3a86ff';

window.onload = async () => {
  initMap();
  initAI();
  setupEventListeners();
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(successLoc, errorLoc);
};

function initMap() {
    map = L.map('map', { zoomControl: false }).setView([userLocation.lat, userLocation.lng], 13);
    tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map);
}

function initAI() {
    genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
}

function setupEventListeners() {
    document.getElementById('lang-select').onchange = changeLanguage;
    document.getElementById('theme-btn').onclick = toggleTheme;
    document.getElementById('generate-btn').onclick = handleGenerateClick;
    document.getElementById('start-btn').onclick = startVoiceMode;

    document.querySelectorAll('.choice-btn').forEach(btn => {
        btn.onclick = () => selectOption(btn.dataset.cat, btn.dataset.val, btn);
    });
}

function successLoc(pos) {
  userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  map.setView([userLocation.lat, userLocation.lng], 15);
  L.circleMarker([userLocation.lat, userLocation.lng], { radius: 8, color: '#fff', fillColor: '#3a86ff', fillOpacity: 1 }).addTo(map);
  getWeather();
}

function errorLoc() { document.getElementById('weather-display').innerText = "No Loc"; }

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
  if (category === 'type') {
    if (value === 'mountain') {
      transportCont.classList.add('hidden');
      currentSettings.mode = 'walk';
    } else {
      transportCont.classList.remove('hidden');
    }
  }
}

async function handleGenerateClick() {
  const btn = document.getElementById('generate-btn');
  const originalText = btn.innerHTML;
  btn.innerHTML = `<div class="spinner"></div> ${translations[currentLang].planning}`;
  btn.disabled = true;

  try {
    await generateRoute();
    btn.style.display = 'none';
    document.getElementById('start-btn').style.display = 'flex';
  } catch (e) {
    alert("AI Error: " + e.message);
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

async function generateRoute() {
  const isMountain = currentSettings.type === 'mountain';
  const radiusKm = isMountain ? 300 : (currentSettings.mode === 'walk' ? 15 : 50);

  let vibePrompt = "";
  if (isMountain) {
    vibePrompt = `MODE: MOUNTAIN EXPEDITION. SEARCH Greater Caucasus Mountains (Azerbaijan). Suggest 3 distinct stops (Peaks, Lakes, Campsites). NO restaurants.`;
  } else {
    vibePrompt = `Mode: ${currentSettings.mode}. Vibe: ${currentSettings.type}. Suggest 3-4 stops.`;
  }

  const prompt = `Start Location: ${userLocation.lat}, ${userLocation.lng}. ${vibePrompt} Radius: ${radiusKm}km. Analyze weather/terrain. Assign "risk_level": "high" if risky. OUTPUT JSON ONLY: [ { "name": "Place Name", "lat": 0.0, "lng": 0.0, "description": "Short desc", "safety_note": "Risk details", "risk_level": "low" } ]`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
  const places = JSON.parse(text);

  localStorage.setItem('activeRoute', JSON.stringify({ places, mode: currentSettings.mode, isMountain }));
  drawMap(places, isMountain);
}

async function drawMap(places, isMountain) {
  routeLayers.forEach(l => map.removeLayer(l));
  routeLayers = [];
  markerLayer.forEach(m => map.removeLayer(m));
  markerLayer = [];

  let coords = `${userLocation.lng},${userLocation.lat}`;
  places.forEach(p => coords += `;${p.lng},${p.lat}`);
  const profile = (isMountain) ? 'driving' : 'walking';

  const url = `https://router.project-osrm.org/route/v1/${profile}/${coords}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.routes || data.routes.length === 0) throw new Error("No path found");

  const route = data.routes[0];
  const allPoints = [[userLocation.lat, userLocation.lng]];

  route.legs.forEach((leg, index) => {
    let legCoords = [];
    leg.steps.forEach(step => {
      if (step.geometry && step.geometry.coordinates) {
        step.geometry.coordinates.forEach(c => legCoords.push([c[1], c[0]]));
      }
    });

    const color = isMountain ? (GRADIENT_COLORS[index] || '#000') : DEFAULT_COLOR;
    const polyline = L.polyline(legCoords, { color: color, weight: 6, opacity: 0.9, lineJoin: 'round' }).addTo(map);
    routeLayers.push(polyline);

    if (places[index] && places[index].risk_level === 'high') {
      const midPoint = legCoords[Math.floor(legCoords.length / 2)];
      if (midPoint) {
        const dIcon = L.divIcon({ className: 'danger-icon', html: '<i class="fas fa-exclamation"></i>', iconSize: [24, 24] });
        markerLayer.push(L.marker(midPoint, { icon: dIcon }).addTo(map).bindPopup(`<b style="color:red">SAFETY WARNING</b><br>${places[index].safety_note}`));
      }
    }
  });

  places.forEach((p, i) => {
    allPoints.push([p.lat, p.lng]);
    const icon = L.divIcon({ className: 'custom-div-icon', html: i + 1, iconSize: [30, 30] });
    markerLayer.push(L.marker([p.lat, p.lng], { icon: icon }).addTo(map).bindPopup(`<b>${p.name}</b><br>${p.description}`));
  });

  map.fitBounds(L.latLngBounds(allPoints), { padding: [50, 50] });
}

function changeLanguage() {
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
  document.body.classList.toggle('light-theme');
  const isLight = document.body.classList.contains('light-theme');
  document.getElementById('theme-icon').className = isLight ? 'fas fa-sun' : 'fas fa-moon';
  const url = isLight ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  tileLayer.setUrl(url);
}

function startVoiceMode() { window.location.href = 'voice.html'; }