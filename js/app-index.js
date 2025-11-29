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
let generatedPlaces = [];

const GRADIENT_COLORS = ['#3a86ff', '#8338ec', '#ff006e', '#fb5607', '#ffbe0b'];

window.onload = async () => {
  initMap();
  initAI();
  setupEventListeners();
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(successLoc, errorLoc);
  
  window.startSpecificRoute = (index) => {
      // Ищем в массиве validPlaces (который теперь отфильтрован)
      const clickedPlace = window.validPlacesList[index];
      if (!clickedPlace) return;
      
      const newPlaces = [clickedPlace];
      localStorage.setItem('activeRoute', JSON.stringify({ places: newPlaces, mode: currentSettings.mode, isMountain: currentSettings.type === 'mountain' }));
      window.location.href = 'voice.html';
  };
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

    document.querySelectorAll('.choice-btn').forEach(btn => {
        btn.onclick = () => selectOption(btn.dataset.cat, btn.dataset.val, btn);
    });
}

function successLoc(pos) {
  userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  map.setView([userLocation.lat, userLocation.lng], 15);
  L.circleMarker([userLocation.lat, userLocation.lng], { radius: 8, color: '#fff', fillColor: '#3a86ff', fillOpacity: 1 }).addTo(map).bindPopup("You are here");
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
  const radiusCont = document.getElementById('radius-container');
  const radiusInput = document.getElementById('radius-input');

  if (category === 'mode') {
      if (value === 'walk') radiusInput.value = 5;
      if (value === 'car') radiusInput.value = 20;
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

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  var R = 6371; 
  var dLat = deg2rad(lat2-lat1);  
  var dLon = deg2rad(lon2-lon1); 
  var a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2)
    ; 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  var d = R * c; 
  return d;
}

function deg2rad(deg) { return deg * (Math.PI/180) }

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
    // Если ошибка пришла с текстом "No objects...", показываем её
    showError(e.message.includes("No objects") ? e.message : "AI Error. Try again.");
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

async function generateRoute() {
  const isMountain = currentSettings.type === 'mountain';
  
  let radiusKm = 5;
  if (isMountain) {
      radiusKm = 300; 
  } else {
      const inputVal = document.getElementById('radius-input').value;
      radiusKm = inputVal ? parseInt(inputVal) : 5;
  }

  let vibePrompt = "";
  if (isMountain) {
    vibePrompt = `MODE: MOUNTAIN EXPEDITION. SEARCH Greater Caucasus Mountains (Azerbaijan). Suggest 5 distinct stops (Peaks, Lakes, Campsites). NO restaurants.`;
  } else {
    vibePrompt = `Mode: ${currentSettings.mode}. Vibe: ${currentSettings.type}. Suggest 5-6 stops. STRICTLY within ${radiusKm}km radius. DO NOT suggest locations in the Sea/Water.`;
  }

  const prompt = `Start Location: ${userLocation.lat}, ${userLocation.lng}. ${vibePrompt} Radius: ${radiusKm}km. 
  IMPORTANT: Calculate distances accurately. Do not suggest places further than ${radiusKm}km!
  OUTPUT JSON ONLY: [ { "name": "Place Name", "lat": 0.0, "lng": 0.0, "description": "Short desc", "safety_note": "Risk details", "risk_level": "low" } ]`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
  let rawPlaces = JSON.parse(text);

  // 1. Фильтр по математическому радиусу
  if (!isMountain) {
      rawPlaces = rawPlaces.filter(p => {
          const dist = getDistanceFromLatLonInKm(userLocation.lat, userLocation.lng, p.lat, p.lng);
          return dist <= (radiusKm * 1.5); 
      });
  }

  // 2. СТРОГИЙ ФИЛЬТР OSRM (Проверка на "Море")
  // Мы пытаемся построить маршрут. Если OSRM говорит "нет пути" - значит точка в море или недоступна.
  const validPlaces = [];
  const profile = (isMountain) ? 'driving' : 'walking'; 

  // Проверяем каждую точку
  for (const place of rawPlaces) {
      const url = `https://router.project-osrm.org/route/v1/${profile}/${userLocation.lng},${userLocation.lat};${place.lng},${place.lat}?overview=false`;
      try {
          const res = await fetch(url);
          const data = await res.json();
          // Если маршрут найден (data.routes существует и не пуст) - точка валидная
          if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
             validPlaces.push(place);
          }
      } catch(e) { }
      // Ограничиваем количество валидных точек до 3-х, чтобы не спамить карту
      if (validPlaces.length >= 3) break;
  }

  // ЕСЛИ ПОСЛЕ ВСЕХ ПРОВЕРОК ПУСТО -> ОШИБКА
  if (validPlaces.length === 0) {
      throw new Error(`No objects found within ${radiusKm} km. Try increasing radius.`);
  }

  // Сохраняем глобально для доступа из кнопки GO HERE
  window.validPlacesList = validPlaces;
  
  // Рисуем только валидные
  drawMap(validPlaces, isMountain);
}

async function drawMap(places, isMountain) {
  routeLayers.forEach(l => map.removeLayer(l));
  routeLayers = [];
  markerLayer.forEach(m => map.removeLayer(m));
  markerLayer = [];

  const profile = (isMountain) ? 'driving' : 'walking'; 
  const allPointsBounds = [[userLocation.lat, userLocation.lng]];

  const routePromises = places.map(async (place, index) => {
      const url = `https://router.project-osrm.org/route/v1/${profile}/${userLocation.lng},${userLocation.lat};${place.lng},${place.lat}?overview=full&geometries=geojson`;
      
      try {
          const res = await fetch(url);
          const data = await res.json();
          
          if (data.routes && data.routes.length > 0) {
              const route = data.routes[0];
              const coordinates = route.geometry.coordinates.map(c => [c[1], c[0]]);
              const color = GRADIENT_COLORS[index % GRADIENT_COLORS.length];
              
              const polyline = L.polyline(coordinates, { 
                  color: color, 
                  weight: 5, 
                  opacity: 0.8, 
                  lineJoin: 'round' 
              }).addTo(map);
              routeLayers.push(polyline);

              if (place.risk_level === 'high') {
                  const midPoint = coordinates[Math.floor(coordinates.length / 2)];
                  const dIcon = L.divIcon({ className: 'danger-icon', html: '<i class="fas fa-exclamation"></i>', iconSize: [24, 24] });
                  const m = L.marker(midPoint, { icon: dIcon }).addTo(map).bindPopup(`<b style="color:red">SAFETY WARNING</b><br>${place.safety_note}`);
                  markerLayer.push(m);
              }
          }
      } catch (e) { console.error("Route error", e); }

      allPointsBounds.push([place.lat, place.lng]);
      const icon = L.divIcon({ className: 'custom-div-icon', html: index + 1, iconSize: [30, 30] });
      
      const popupContent = `
          <div style="text-align:center;">
              <b>${place.name}</b><br>
              <span style="font-size:12px; color:#888;">${place.description}</span><br>
              <button onclick="startSpecificRoute(${index})" class="btn-popup">GO HERE 🚀</button>
          </div>
      `;

      const marker = L.marker([place.lat, place.lng], { icon: icon }).addTo(map)
          .bindPopup(popupContent);
      markerLayer.push(marker);
  });

  await Promise.all(routePromises);

  if (allPointsBounds.length > 1) {
      map.fitBounds(L.latLngBounds(allPointsBounds), { padding: [50, 50] });
  }
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
