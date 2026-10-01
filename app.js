import * as maplibregl from 'https://unpkg.com/maplibre-gl@^6.11.2/dist/maplibre-gl.mjs';

const STORAGE_KEY = 'commute-live-web.places.v1';
const PREF_KEY = 'commute-live-web.route.v1';
const JARTIC_URL = 'https://www.jartic.or.jp/map/?p=R02';
const AOMORI_ROAD_URL = 'https://aomori.cc/road/sp/';
let places = loadJSON(STORAGE_KEY, []);
let prefs = loadJSON(PREF_KEY, { origin: '__current__', destination: '', originText: '', destinationText: '' });
let currentLocation = null;
let map;
const markers = new Map();

const $ = (id) => document.getElementById(id);
const originSelect = $('originSelect');
const destinationSelect = $('destinationSelect');
const originText = $('originText');
const destinationText = $('destinationText');

initMap();
render();
updateNetwork();
window.addEventListener('online', updateNetwork);
window.addEventListener('offline', updateNetwork);

$('swapBtn').addEventListener('click', () => {
  const selectedOrigin = originSelect.value;
  originSelect.value = destinationSelect.value;
  destinationSelect.value = selectedOrigin;

  const typedOrigin = originText.value;
  originText.value = destinationText.value;
  destinationText.value = typedOrigin;

  saveRoutePrefs();
  updateRouteSummary();
  fitSelectedPlaces();
});

originSelect.addEventListener('change', () => {
  if (originSelect.value) originText.value = '';
  saveRoutePrefs();
  updateRouteSummary();
  fitSelectedPlaces();
});
destinationSelect.addEventListener('change', () => {
  if (destinationSelect.value) destinationText.value = '';
  saveRoutePrefs();
  updateRouteSummary();
  fitSelectedPlaces();
});
originText.addEventListener('input', () => {
  if (originText.value.trim()) originSelect.value = '';
  saveRoutePrefs();
  updateRouteSummary();
  updateSelectedLine();
});
destinationText.addEventListener('input', () => {
  if (destinationText.value.trim()) destinationSelect.value = '';
  saveRoutePrefs();
  updateRouteSummary();
  updateSelectedLine();
});
$('locateBtn').addEventListener('click', () => locate(true));
$('useCurrentBtn').addEventListener('click', async () => {
  const pos = await locate(true);
  if (!pos) return;
  $('placeLat').value = pos.lat.toFixed(6);
  $('placeLng').value = pos.lng.toFixed(6);
  $('placeName').focus();
  toast('現在地の座標を入力しました。名称を付けて保存できます。');
});

$('placeForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('placeName').value.trim();
  const address = $('placeAddress').value.trim();
  const lat = Number.parseFloat($('placeLat').value);
  const lng = Number.parseFloat($('placeLng').value);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  if (!name) return toast('地点名を入力してください。');
  if (!hasCoords && !address) return toast('住所または緯度・経度を入力してください。');
  if (hasCoords && (lat < -90 || lat > 90 || lng < -180 || lng > 180)) return toast('緯度・経度を確認してください。');

  const place = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), name, address, lat: hasCoords ? lat : null, lng: hasCoords ? lng : null };
  places.push(place);
  saveJSON(STORAGE_KEY, places);
  event.target.reset();
  render();
  if (!prefs.destination) {
    destinationSelect.value = place.id;
    saveRoutePrefs();
  }
  toast('地点を端末内に保存しました。');
});

$('googleMapsBtn').addEventListener('click', async () => {
  const typedOrigin = originText.value.trim();
  const typedDestination = destinationText.value.trim();

  if (!typedOrigin && originSelect.value === '__current__' && !currentLocation) {
    const pos = await locate(false);
    if (!pos) return;
  }

  const origin = typedOrigin || selectedValue(originSelect.value, true);
  const destination = typedDestination || selectedValue(destinationSelect.value, false);

  if (!origin || !destination) return toast('出発地と到着地を、保存地点から選ぶか住所・名称で入力してください。');
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  url.searchParams.set('travelmode', 'driving');
  url.searchParams.set('dir_action', 'navigate');
  window.open(url.toString(), '_blank', 'noopener');
});

$('jarticBtn').addEventListener('click', () => window.open(JARTIC_URL, '_blank', 'noopener'));
$('snowBtn').addEventListener('click', () => window.open(AOMORI_ROAD_URL, '_blank', 'noopener'));
$('speakBtn').addEventListener('click', () => {
  if (!('speechSynthesis' in window)) return toast('このブラウザでは音声読み上げを利用できません。');
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance('出発前に、Google Mapsで現在の経路を確認し、JARTICで渋滞、事故、規制を確認してください。雪の日は青森みち情報も確認してください。');
  utterance.lang = 'ja-JP';
  utterance.rate = 1.02;
  speechSynthesis.speak(utterance);
});

function initMap() {
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [140.47, 40.60],
      zoom: 7.2,
      attributionControl: true
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.on('load', () => {
      map.addSource('selected-pair', { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({
        id: 'selected-pair-line',
        type: 'line',
        source: 'selected-pair',
        paint: { 'line-color': '#38bdf8', 'line-width': 4, 'line-dasharray': [2, 2], 'line-opacity': 0.8 }
      });
      updateMarkers();
      fitSelectedPlaces();
    });
    map.on('error', () => {
      if (!navigator.onLine) $('locationStatus').textContent = 'オフライン：地図タイルは更新できません';
    });
  } catch {
    $('locationStatus').textContent = '地図を読み込めませんでした';
  }
}

function render() {
  renderSelects();
  renderSuggestions();
  renderPlaces();
  updateMarkers();
  updateRouteSummary();
}

function renderSelects() {
  const options = [
    { id: '__current__', name: '現在地' },
    ...places
  ];
  for (const select of [originSelect, destinationSelect]) {
    const previous = select === originSelect ? prefs.origin : prefs.destination;
    select.innerHTML = '<option value="">選択してください</option>' + options.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    select.value = options.some(p => p.id === previous) ? previous : (select === originSelect ? '__current__' : '');
  }

  originText.value = prefs.originText || '';
  destinationText.value = prefs.destinationText || '';

  if (originText.value.trim()) originSelect.value = '';
  if (destinationText.value.trim()) destinationSelect.value = '';
}

function renderSuggestions() {
  const list = $('savedPlaceSuggestions');
  list.innerHTML = '';
  for (const place of places) {
    const option = document.createElement('option');
    option.value = place.address || place.name;
    option.label = place.name;
    list.appendChild(option);
  }
}

function renderPlaces() {
  const list = $('placesList');
  if (!places.length) {
    list.innerHTML = '<p class="note">まだ保存地点がありません。自宅や勤務地で「現在地を保存」を使うと簡単です。</p>';
    return;
  }
  list.innerHTML = '';
  for (const place of places) {
    const card = document.createElement('div');
    card.className = 'place-card';
    const details = document.createElement('div');
    const coord = place.lat != null ? `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}` : '座標未登録';
    details.innerHTML = `<strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.address || coord)}</small>`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      if (!confirm(`「${place.name}」を削除しますか？`)) return;
      places = places.filter(p => p.id !== place.id);
      saveJSON(STORAGE_KEY, places);
      if (prefs.origin === place.id) prefs.origin = '__current__';
      if (prefs.destination === place.id) prefs.destination = '';
      saveJSON(PREF_KEY, prefs);
      render();
    });
    card.append(details, del);
    list.appendChild(card);
  }
}

function updateMarkers() {
  if (!map) return;
  for (const marker of markers.values()) marker.remove();
  markers.clear();
  for (const place of places.filter(p => p.lat != null && p.lng != null)) {
    const marker = new maplibregl.Marker().setLngLat([place.lng, place.lat]).setPopup(new maplibregl.Popup({ offset: 20 }).setText(place.name)).addTo(map);
    markers.set(place.id, marker);
  }
  if (currentLocation) {
    const el = document.createElement('div');
    el.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#2563eb;border:4px solid white;box-shadow:0 0 0 3px rgba(37,99,235,.3)';
    const marker = new maplibregl.Marker({ element: el }).setLngLat([currentLocation.lng, currentLocation.lat]).setPopup(new maplibregl.Popup({ offset: 18 }).setText('現在地')).addTo(map);
    markers.set('__current__', marker);
  }
  updateSelectedLine();
}

function updateSelectedLine() {
  if (!map || !map.isStyleLoaded() || !map.getSource('selected-pair')) return;
  const a = originText.value.trim() ? null : selectedCoords(originSelect.value);
  const b = destinationText.value.trim() ? null : selectedCoords(destinationSelect.value);
  const data = (a && b) ? {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[a.lng,a.lat],[b.lng,b.lat]] } }]
  } : emptyFeatureCollection();
  map.getSource('selected-pair').setData(data);
}

function fitSelectedPlaces() {
  updateSelectedLine();
  if (!map) return;
  const coords = [
    originText.value.trim() ? null : selectedCoords(originSelect.value),
    destinationText.value.trim() ? null : selectedCoords(destinationSelect.value)
  ].filter(Boolean);
  if (coords.length === 2) {
    const bounds = new maplibregl.LngLatBounds([coords[0].lng, coords[0].lat], [coords[0].lng, coords[0].lat]);
    bounds.extend([coords[1].lng, coords[1].lat]);
    map.fitBounds(bounds, { padding: 70, maxZoom: 13, duration: 500 });
  } else if (coords.length === 1) {
    map.easeTo({ center: [coords[0].lng, coords[0].lat], zoom: 13 });
  }
}

async function locate(centerMap = false) {
  if (!('geolocation' in navigator)) {
    toast('この端末では位置情報を利用できません。');
    return null;
  }
  $('locationStatus').textContent = '現在地を取得中…';
  return await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        currentLocation = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy };
        $('locationStatus').textContent = `現在地取得済み（精度 約${Math.round(position.coords.accuracy)}m）`;
        updateMarkers();
        updateRouteSummary();
        if (centerMap && map) map.easeTo({ center: [currentLocation.lng, currentLocation.lat], zoom: 14 });
        resolve(currentLocation);
      },
      (error) => {
        $('locationStatus').textContent = '現在地を取得できません';
        toast(error.code === 1 ? '位置情報の利用を許可してください。' : '現在地を取得できませんでした。');
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  });
}

function selectedValue(id, allowCurrent) {
  if (id === '__current__') {
    if (!allowCurrent || !currentLocation) return null;
    return `${currentLocation.lat},${currentLocation.lng}`;
  }
  const p = places.find(x => x.id === id);
  if (!p) return null;
  if (p.address) return p.address;
  if (p.lat != null && p.lng != null) return `${p.lat},${p.lng}`;
  return null;
}

function selectedCoords(id) {
  if (id === '__current__') return currentLocation;
  const p = places.find(x => x.id === id);
  return p && p.lat != null && p.lng != null ? { lat:p.lat, lng:p.lng } : null;
}

function updateRouteSummary() {
  const nameFor = (id) => id === '__current__' ? '現在地' : (places.find(p => p.id === id)?.name || '');
  const a = originText.value.trim() || nameFor(originSelect.value);
  const b = destinationText.value.trim() || nameFor(destinationSelect.value);
  $('routeTitle').textContent = a && b ? `${a} → ${b}` : '出発地と到着地を設定してください';

  if (a && b && (originText.value.trim() || destinationText.value.trim())) {
    $('routeHint').textContent = '入力した住所・名称はGoogle Mapsへ渡して検索します。アプリ内地図の点線は表示されない場合があります。';
  } else if (a && b) {
    $('routeHint').textContent = '地図の点線は位置関係で、実際の道路ルートではありません。Google Mapsで最新交通を確認します。';
  } else {
    $('routeHint').textContent = '保存地点から選ぶか、住所・施設名を直接入力できます。';
  }
}

function saveRoutePrefs() {
  prefs = {
    origin: originSelect.value,
    destination: destinationSelect.value,
    originText: originText.value.trim(),
    destinationText: destinationText.value.trim()
  };
  saveJSON(PREF_KEY, prefs);
}

function updateNetwork() {
  const badge = $('networkBadge');
  if (navigator.onLine) {
    badge.textContent = 'オンライン';
    badge.className = 'badge online';
  } else {
    badge.textContent = 'オフライン';
    badge.className = 'badge offline';
  }
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJSON(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function emptyFeatureCollection() { return { type:'FeatureCollection', features:[] }; }

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}