import * as maplibregl from 'https://unpkg.com/maplibre-gl@^6.11.2/dist/maplibre-gl.mjs';

const STORAGE_KEY = 'commute-live-web.places.v1';
const PREF_KEY = 'commute-live-web.route.v1';
const GOOGLE_SETTINGS_KEY = 'commute-live-web.google.v1';
const USAGE_KEY = 'commute-live-web.analysis-usage.v1';
const DAILY_ANALYSIS_LIMIT = 30;
const WARNING_THRESHOLD = 25;
const JARTIC_URL = 'https://www.jartic.or.jp/map/?p=R02';
const AOMORI_ROAD_URL = 'https://aomori.cc/road/sp/';

let places = loadJSON(STORAGE_KEY, []);
let prefs = loadJSON(PREF_KEY, {
  origin: '__current__',
  destination: '',
  originText: '',
  destinationText: '',
  mapOrigin: null,
  mapDestination: null
});
let googleSettings = loadJSON(GOOGLE_SETTINGS_KEY, { apiKey: '', autoSpeak: true, voiceURI: '' });
let currentLocation = null;
let pendingMapPoint = null;
let japaneseVoices = [];

let mapMode = 'open';
let mapLibre = null;
let googleMap = null;
let googleMapMarkers = [];
let googleRouteOverlays = [];
const openMarkers = new Map();

let routesLibrary = null;
let mapsLibrary = null;
let latestAnalysis = null;
let analysisTimer = null;
let inMemoryCache = { key: '', at: 0, analysis: null };
let selectedRouteKey = 'traffic-0';
let drivingWatchId = null;
let drivingMarker = null;
let trafficMarkers = [];
let drivingSpokenAlerts = new Set();
let drivingSpokenSteps = new Set();

const $ = (id) => document.getElementById(id);
const originSelect = $('originSelect');
const destinationSelect = $('destinationSelect');
const originText = $('originText');
const destinationText = $('destinationText');

setupListeners();
render();
updateNetwork();
updateUsageUI();
prepareVoices();
initMapExperience();

window.addEventListener('online', updateNetwork);
window.addEventListener('offline', updateNetwork);

function setupListeners() {
  $('swapBtn').addEventListener('click', () => {
    const selectedOrigin = originSelect.value;
    originSelect.value = destinationSelect.value;
    destinationSelect.value = selectedOrigin;

    const typedOrigin = originText.value;
    originText.value = destinationText.value;
    destinationText.value = typedOrigin;

    const mapOrigin = prefs.mapOrigin || null;
    prefs.mapOrigin = prefs.mapDestination || null;
    prefs.mapDestination = mapOrigin;

    saveRoutePrefs();
    updateRouteSummary();
    fitSelectedPlaces();
    scheduleAutomaticAnalysis();
  });

  originSelect.addEventListener('change', () => {
    if (originSelect.value) originText.value = '';
    prefs.mapOrigin = null;
    saveRoutePrefs();
    updateRouteSummary();
    fitSelectedPlaces();
    scheduleAutomaticAnalysis(300);
  });

  destinationSelect.addEventListener('change', () => {
    if (destinationSelect.value) destinationText.value = '';
    prefs.mapDestination = null;
    saveRoutePrefs();
    updateRouteSummary();
    fitSelectedPlaces();
    scheduleAutomaticAnalysis(300);
  });

  originText.addEventListener('input', () => {
    if (originText.value.trim()) originSelect.value = '';
    prefs.mapOrigin = null;
    saveRoutePrefs();
    updateRouteSummary();
    updateSelectedLine();
  });

  destinationText.addEventListener('input', () => {
    if (destinationText.value.trim()) destinationSelect.value = '';
    prefs.mapDestination = null;
    saveRoutePrefs();
    updateRouteSummary();
    updateSelectedLine();
  });

  originText.addEventListener('change', () => scheduleAutomaticAnalysis());
  destinationText.addEventListener('change', () => scheduleAutomaticAnalysis());

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

    const place = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      name,
      address,
      lat: hasCoords ? lat : null,
      lng: hasCoords ? lng : null
    };

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

  $('analyzeBtn').addEventListener('click', () => analyzeTraffic({ speak: googleSettings.autoSpeak, force: true }));

  $('googleMapsBtn').addEventListener('click', () => openGoogleMapsNavigation());
  $('jarticBtn').addEventListener('click', () => window.open(JARTIC_URL, '_blank', 'noopener'));
  $('snowBtn').addEventListener('click', () => window.open(AOMORI_ROAD_URL, '_blank', 'noopener'));

  $('speakAnalysisBtn').addEventListener('click', () => {
    if (latestAnalysis) {
      speakAnalysis(latestAnalysis);
    } else {
      speakText('まだ交通解析結果がありません。出発地と到着地を設定し、交通状況を自動解析してください。');
    }
  });

  $('speakBtn').addEventListener('click', () => {
    speakText('事故、工事、道路規制の原因はGoogleの経路情報だけでは断定しません。必要に応じてJARTIC公式情報と雪道情報を確認してください。');
  });

  $('saveGoogleKeyBtn').addEventListener('click', () => {
    const key = $('googleApiKey').value.trim();
    if (!key) return toast('Web用APIキーを入力してください。');
    googleSettings = {
      apiKey: key,
      autoSpeak: $('autoSpeakToggle').checked,
      voiceURI: $('voiceSelect').value || googleSettings.voiceURI || ''
    };
    saveJSON(GOOGLE_SETTINGS_KEY, googleSettings);
    toast('この端末にGoogle交通解析設定を保存しました。再読み込みします。');
    setTimeout(() => location.reload(), 500);
  });

  $('removeGoogleKeyBtn').addEventListener('click', () => {
    if (!confirm('この端末に保存したGoogle交通解析用APIキーを削除しますか？')) return;
    localStorage.removeItem(GOOGLE_SETTINGS_KEY);
    toast('APIキーを削除しました。再読み込みします。');
    setTimeout(() => location.reload(), 400);
  });

  $('autoSpeakToggle').addEventListener('change', () => {
    googleSettings.autoSpeak = $('autoSpeakToggle').checked;
    saveJSON(GOOGLE_SETTINGS_KEY, googleSettings);
  });

  $('voiceSelect').addEventListener('change', () => {
    googleSettings.voiceURI = $('voiceSelect').value;
    saveJSON(GOOGLE_SETTINGS_KEY, googleSettings);
  });

  $('testVoiceBtn').addEventListener('click', () => {
    speakText('交通状況をご案内します。日本語の音声を、できるだけ自然に読み上げます。');
  });

  $('setMapOriginBtn').addEventListener('click', () => applyPendingMapPoint('origin'));
  $('setMapDestinationBtn').addEventListener('click', () => applyPendingMapPoint('destination'));
  $('cancelMapTapBtn').addEventListener('click', hideMapTapChoice);
  $('startDrivingBtn').addEventListener('click', startDrivingFollow);
  $('stopDrivingBtn').addEventListener('click', stopDrivingFollow);
}

async function initMapExperience() {
  $('googleApiKey').value = googleSettings.apiKey || '';
  $('autoSpeakToggle').checked = googleSettings.autoSpeak !== false;
  renderVoiceOptions();
  updateGoogleModeBadge();

  if (!googleSettings.apiKey) {
    initOpenMap();
    setAnalysisStatus('未設定', 'Google交通解析を使うにはWeb用APIキーをこの端末に保存してください。', 'warn');
    return;
  }

  try {
    setAnalysisStatus('Google交通解析を準備中', 'Maps JavaScript API と Routes Library を読み込んでいます。', 'loading');
    await loadGoogleMapsScript(googleSettings.apiKey);
    mapsLibrary = await google.maps.importLibrary('maps');
    routesLibrary = await google.maps.importLibrary('routes');
    initGoogleMap();
    setAnalysisStatus('準備完了', '出発地・到着地を設定すると交通状況を自動解析できます。', 'ok');
    scheduleAutomaticAnalysis(600);
  } catch (error) {
    console.error(error);
    initOpenMap();
    setAnalysisStatus('Google交通解析を開始できません', normalizeGoogleError(error), 'error');
    $('googleSetupDetails').open = true;
  }
}

function loadGoogleMapsScript(apiKey) {
  if (window.google?.maps?.importLibrary) return Promise.resolve();

  // Google公式の Dynamic Library Import bootstrap と同じ方式で、
  // importLibrary() を先に定義してから必要なライブラリを読み込みます。
  const googleNamespace = window.google || (window.google = {});
  const mapsNamespace = googleNamespace.maps || (googleNamespace.maps = {});

  let loaderPromise;
  const requestedLibraries = new Set();

  const startLoader = () => {
    if (loaderPromise) return loaderPromise;

    loaderPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const params = new URLSearchParams();

      params.set('libraries', [...requestedLibraries].join(','));
      params.set('key', apiKey);
      params.set('v', 'weekly');
      params.set('auth_referrer_policy', 'origin');
      params.set('callback', 'google.maps.__ib__');

      mapsNamespace.__ib__ = resolve;
      script.async = true;
      script.dataset.googleMapsLoader = 'true';
      script.src = 'https://maps.googleapis.com/maps/api/js?' + params.toString();
      script.onerror = () => {
        loaderPromise = null;
        reject(new Error('Google Maps JavaScript APIを読み込めませんでした。APIキーのWebサイト制限とMaps JavaScript APIの有効化を確認してください。'));
      };

      document.head.appendChild(script);
    });

    return loaderPromise;
  };

  mapsNamespace.importLibrary = (libraryName, ...args) => {
    requestedLibraries.add(libraryName);
    return startLoader().then(() => mapsNamespace.importLibrary(libraryName, ...args));
  };

  return Promise.resolve();
}

function initOpenMap() {
  mapMode = 'open';
  clearGoogleMap();

  try {
    mapLibre?.remove();
  } catch {}

  $('map').innerHTML = '';

  try {
    mapLibre = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [140.47, 40.60],
      zoom: 7.2,
      attributionControl: true
    });

    mapLibre.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    mapLibre.on('click', (event) => {
      showMapTapChoice({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    });

    mapLibre.on('load', () => {
      mapLibre.addSource('selected-pair', { type: 'geojson', data: emptyFeatureCollection() });
      mapLibre.addLayer({
        id: 'selected-pair-line',
        type: 'line',
        source: 'selected-pair',
        paint: {
          'line-color': '#38bdf8',
          'line-width': 4,
          'line-dasharray': [2, 2],
          'line-opacity': 0.8
        }
      });
      updateMarkers();
      fitSelectedPlaces();
    });

    mapLibre.on('error', () => {
      if (!navigator.onLine) $('locationStatus').textContent = 'オフライン：地図タイルは更新できません';
    });

    $('mapNote').textContent = '無料モード：MapLibre + OpenFreeMapで位置を確認します。Google経路データはこの地図には表示しません。';
  } catch (error) {
    console.error(error);
    $('locationStatus').textContent = '地図を読み込めませんでした';
  }
}

function initGoogleMap() {
  mapMode = 'google';

  try {
    mapLibre?.remove();
  } catch {}
  mapLibre = null;

  $('map').innerHTML = '';

  const MapClass = mapsLibrary?.Map || google.maps.Map;
  googleMap = new MapClass($('map'), {
    center: { lat: 40.60, lng: 140.47 },
    zoom: 8,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    gestureHandling: 'greedy'
  });

  googleMap.addListener('click', (event) => {
    if (!event.latLng) return;
    showMapTapChoice({ lat: event.latLng.lat(), lng: event.latLng.lng() });
  });

  $('mapNote').innerHTML = 'Google交通解析モード：経路・渋滞データはGoogle Map上に表示します。<span class="google-attribution"><strong>Google</strong> の経路データを使用</span>';
  updateMarkers();
  fitSelectedPlaces();
}

function clearGoogleMap() {
  clearGoogleRouteOverlays();
  for (const marker of googleMapMarkers) marker.setMap?.(null);
  googleMapMarkers = [];
  googleMap = null;
}

function render() {
  renderSelects();
  renderSuggestions();
  renderPlaces();
  updateMarkers();
  updateRouteSummary();
}

function renderSelects() {
  const options = [{ id: '__current__', name: '現在地' }, ...places];

  for (const select of [originSelect, destinationSelect]) {
    const previous = select === originSelect ? prefs.origin : prefs.destination;
    select.innerHTML = '<option value="">選択してください</option>' +
      options.map((p) => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name) + '</option>').join('');
    select.value = options.some((p) => p.id === previous)
      ? previous
      : (select === originSelect ? '__current__' : '');
  }

  originText.value = prefs.originText || '';
  destinationText.value = prefs.destinationText || '';

  if (originText.value.trim() || prefs.mapOrigin) originSelect.value = '';
  if (destinationText.value.trim() || prefs.mapDestination) destinationSelect.value = '';
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
    const coord = place.lat != null ? place.lat.toFixed(5) + ', ' + place.lng.toFixed(5) : '座標未登録';
    details.innerHTML = '<strong>' + escapeHtml(place.name) + '</strong><small>' + escapeHtml(place.address || coord) + '</small>';

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      if (!confirm('「' + place.name + '」を削除しますか？')) return;

      places = places.filter((p) => p.id !== place.id);
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
  if (mapMode === 'google') {
    updateGoogleMarkers();
  } else {
    updateOpenMarkers();
  }
}

function updateOpenMarkers() {
  if (!mapLibre) return;

  for (const marker of openMarkers.values()) marker.remove();
  openMarkers.clear();

  for (const place of places.filter((p) => p.lat != null && p.lng != null)) {
    const marker = new maplibregl.Marker()
      .setLngLat([place.lng, place.lat])
      .setPopup(new maplibregl.Popup({ offset: 20 }).setText(place.name))
      .addTo(mapLibre);

    openMarkers.set(place.id, marker);
  }

  if (currentLocation) {
    const el = document.createElement('div');
    el.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#2563eb;border:4px solid white;box-shadow:0 0 0 3px rgba(37,99,235,.3)';

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([currentLocation.lng, currentLocation.lat])
      .setPopup(new maplibregl.Popup({ offset: 18 }).setText('現在地'))
      .addTo(mapLibre);

    openMarkers.set('__current__', marker);
  }

  addOpenPickedMarker('map-origin', prefs.mapOrigin, '出', '#22c55e', '地図で選択した出発地');
  addOpenPickedMarker('map-destination', prefs.mapDestination, '着', '#ef4444', '地図で選択した到着地');

  updateSelectedLine();
}

function updateGoogleMarkers() {
  if (!googleMap || !window.google?.maps) return;

  for (const marker of googleMapMarkers) marker.setMap?.(null);
  googleMapMarkers = [];

  for (const place of places.filter((p) => p.lat != null && p.lng != null)) {
    const marker = new google.maps.Marker({
      map: googleMap,
      position: { lat: place.lat, lng: place.lng },
      title: place.name
    });
    googleMapMarkers.push(marker);
  }

  if (currentLocation) {
    const marker = new google.maps.Marker({
      map: googleMap,
      position: { lat: currentLocation.lat, lng: currentLocation.lng },
      title: '現在地'
    });
    googleMapMarkers.push(marker);
  }

  if (prefs.mapOrigin) {
    googleMapMarkers.push(new google.maps.Marker({
      map: googleMap,
      position: prefs.mapOrigin,
      title: '地図で選択した出発地',
      label: '出'
    }));
  }

  if (prefs.mapDestination) {
    googleMapMarkers.push(new google.maps.Marker({
      map: googleMap,
      position: prefs.mapDestination,
      title: '地図で選択した到着地',
      label: '着'
    }));
  }
}

function updateSelectedLine() {
  if (mapMode !== 'open') return;
  if (!mapLibre || !mapLibre.isStyleLoaded() || !mapLibre.getSource('selected-pair')) return;

  const a = prefs.mapOrigin || (originText.value.trim() ? null : selectedCoords(originSelect.value));
  const b = prefs.mapDestination || (destinationText.value.trim() ? null : selectedCoords(destinationSelect.value));

  const data = (a && b)
    ? {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [[a.lng, a.lat], [b.lng, b.lat]]
          }
        }]
      }
    : emptyFeatureCollection();

  mapLibre.getSource('selected-pair').setData(data);
}

function fitSelectedPlaces() {
  const coords = [
    prefs.mapOrigin || (originText.value.trim() ? null : selectedCoords(originSelect.value)),
    prefs.mapDestination || (destinationText.value.trim() ? null : selectedCoords(destinationSelect.value))
  ].filter(Boolean);

  if (mapMode === 'open') {
    updateSelectedLine();
    if (!mapLibre) return;

    if (coords.length === 2) {
      const bounds = new maplibregl.LngLatBounds([coords[0].lng, coords[0].lat], [coords[0].lng, coords[0].lat]);
      bounds.extend([coords[1].lng, coords[1].lat]);
      mapLibre.fitBounds(bounds, { padding: 70, maxZoom: 13, duration: 500 });
    } else if (coords.length === 1) {
      mapLibre.easeTo({ center: [coords[0].lng, coords[0].lat], zoom: 13 });
    }

    return;
  }

  if (!googleMap || !window.google?.maps || !coords.length) return;

  if (coords.length === 1) {
    googleMap.setCenter(coords[0]);
    googleMap.setZoom(13);
    return;
  }

  const bounds = new google.maps.LatLngBounds();
  coords.forEach((coord) => bounds.extend(coord));
  googleMap.fitBounds(bounds, 70);
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
        currentLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy
        };

        $('locationStatus').textContent = '現在地取得済み（精度 約' + Math.round(position.coords.accuracy) + 'm）';
        updateMarkers();
        updateRouteSummary();

        if (centerMap) {
          if (mapMode === 'google' && googleMap) {
            googleMap.setCenter(currentLocation);
            googleMap.setZoom(14);
          } else if (mapLibre) {
            mapLibre.easeTo({ center: [currentLocation.lng, currentLocation.lat], zoom: 14 });
          }
        }

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
    return currentLocation.lat + ',' + currentLocation.lng;
  }

  const place = places.find((p) => p.id === id);
  if (!place) return null;

  if (place.lat != null && place.lng != null) return place.lat + ',' + place.lng;
  if (place.address) return place.address;
  return place.name || null;
}

function selectedCoords(id) {
  if (id === '__current__') return currentLocation;

  const place = places.find((p) => p.id === id);
  return place && place.lat != null && place.lng != null
    ? { lat: place.lat, lng: place.lng }
    : null;
}

async function routeEndpoints() {
  const typedOrigin = originText.value.trim();
  const typedDestination = destinationText.value.trim();

  if (!typedOrigin && originSelect.value === '__current__' && !currentLocation) {
    const pos = await locate(false);
    if (!pos) return null;
  }

  const origin = typedOrigin || prefs.mapOrigin || routeEndpointValue(originSelect.value, true);
  const destination = typedDestination || prefs.mapDestination || routeEndpointValue(destinationSelect.value, false);

  if (!origin || !destination) {
    toast('出発地と到着地を、保存地点から選ぶか住所・名称で入力してください。');
    return null;
  }

  return { origin, destination };
}

function routeEndpointValue(id, allowCurrent) {
  if (id === '__current__') {
    if (!allowCurrent || !currentLocation) return null;
    return { lat: currentLocation.lat, lng: currentLocation.lng };
  }

  const place = places.find((p) => p.id === id);
  if (!place) return null;

  if (place.lat != null && place.lng != null) return { lat: place.lat, lng: place.lng };
  return place.address || place.name || null;
}

function scheduleAutomaticAnalysis(delay = 1200) {
  clearTimeout(analysisTimer);

  if (!googleSettings.apiKey || !routesLibrary) return;
  if (!hasBothRouteEndpoints()) return;

  analysisTimer = setTimeout(() => {
    analyzeTraffic({ speak: googleSettings.autoSpeak, force: false });
  }, delay);
}

function hasBothRouteEndpoints() {
  const originReady = Boolean(originText.value.trim() || prefs.mapOrigin || originSelect.value);
  const destinationReady = Boolean(destinationText.value.trim() || prefs.mapDestination || destinationSelect.value);
  return originReady && destinationReady;
}

async function analyzeTraffic({ speak = false, force = false } = {}) {
  if (!googleSettings.apiKey) {
    $('googleSetupDetails').open = true;
    toast('Google交通解析のWeb用APIキーを設定してください。');
    return;
  }

  if (!routesLibrary) {
    toast('Google交通解析を準備中です。数秒後にもう一度お試しください。');
    return;
  }

  const endpoints = await routeEndpoints();
  if (!endpoints) return;

  const cacheKey = stableEndpointKey(endpoints.origin) + '→' + stableEndpointKey(endpoints.destination);

  if (!force && inMemoryCache.analysis && inMemoryCache.key === cacheKey && Date.now() - inMemoryCache.at < 5 * 60 * 1000) {
    latestAnalysis = inMemoryCache.analysis;
    renderAnalysis(latestAnalysis);
    drawGoogleRoutes(latestAnalysis);
    updateSelectedRoutePanel();
    if (speak) speakAnalysis(latestAnalysis);
    return;
  }

  if (!reserveAnalysis()) {
    setAnalysisStatus('本日の解析上限に達しました', '新しいGoogle経路解析は明日まで停止します。Google Mapsでナビ開始は引き続き利用できます。', 'warn');
    return;
  }

  updateUsageUI();
  $('analyzeBtn').disabled = true;
  $('analyzeBtn').textContent = '解析中…';
  setAnalysisStatus('現在の道路状況を解析中', '現在交通を考慮した経路と、交通を優先しない通常経路を比較しています。', 'loading');

  try {
    const { Route } = routesLibrary;

    const trafficRequest = {
      origin: endpoints.origin,
      destination: endpoints.destination,
      travelMode: 'DRIVING',
      routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
      computeAlternativeRoutes: true,
      extraComputations: ['TRAFFIC_ON_POLYLINE'],
      fields: [
        'path',
        'routeLabels',
        'viewport',
        'durationMillis',
        'staticDurationMillis',
        'distanceMeters',
        'speedPaths',
        'legs',
        'description',
        'warnings'
      ],
      language: 'ja',
    };

    const normalRequest = {
      origin: endpoints.origin,
      destination: endpoints.destination,
      travelMode: 'DRIVING',
      routingPreference: 'TRAFFIC_UNAWARE',
      computeAlternativeRoutes: false,
      fields: [
        'path',
        'routeLabels',
        'viewport',
        'durationMillis',
        'staticDurationMillis',
        'distanceMeters',
        'legs',
        'description',
        'warnings'
      ],
      language: 'ja',
    };

    const [trafficResult, normalResult] = await Promise.all([
      Route.computeRoutes(trafficRequest),
      Route.computeRoutes(normalRequest)
    ]);

    const trafficRoutes = [...(trafficResult.routes || [])]
      .filter((route) => Number.isFinite(route.durationMillis))
      .sort((a, b) => a.durationMillis - b.durationMillis);

    const normalRoute = normalResult.routes?.[0] || null;

    if (!trafficRoutes.length) throw new Error('利用できる経路が見つかりませんでした。');

    latestAnalysis = buildAnalysisModel(trafficRoutes, normalRoute);
    selectedRouteKey = latestAnalysis.recommended.key;
    drivingSpokenAlerts.clear();
    drivingSpokenSteps.clear();
    inMemoryCache = { key: cacheKey, at: Date.now(), analysis: latestAnalysis };

    renderAnalysis(latestAnalysis);
    drawGoogleRoutes(latestAnalysis);
    updateSelectedRoutePanel();
    setAnalysisStatus('解析完了', buildStatusSummary(latestAnalysis), latestAnalysis.recommended.delayMinutes >= 8 ? 'warn' : 'ok');

    if (speak) speakAnalysis(latestAnalysis);
  } catch (error) {
    console.error(error);
    setAnalysisStatus('交通解析に失敗しました', normalizeGoogleError(error), 'error');
    $('googleSetupDetails').open = true;
  } finally {
    $('analyzeBtn').disabled = false;
    $('analyzeBtn').textContent = '交通状況を自動解析';
  }
}

function buildAnalysisModel(trafficRoutes, normalRoute) {
  const now = Date.now();

  const traffic = trafficRoutes.map((route, index) => {
    const durationMinutes = Math.max(1, Math.round(route.durationMillis / 60000));
    const staticMinutes = Number.isFinite(route.staticDurationMillis)
      ? Math.max(1, Math.round(route.staticDurationMillis / 60000))
      : durationMinutes;

    const speedSummary = summarizeSpeedPaths(route.speedPaths || []);
    const navigationSteps = extractNavigationSteps(route);
    const trafficSegments = deriveTrafficSegments(route, navigationSteps);

    return {
      key: 'traffic-' + index,
      route,
      type: index === 0 ? 'recommended' : 'alternative',
      label: index === 0 ? '推奨ルート' : '代替ルート ' + index,
      durationMinutes,
      staticMinutes,
      delayMinutes: Math.max(0, durationMinutes - staticMinutes),
      distanceKm: Number.isFinite(route.distanceMeters) ? route.distanceMeters / 1000 : null,
      eta: new Date(now + durationMinutes * 60000),
      speedSummary,
      navigationSteps,
      trafficSegments,
      description: route.description || ''
    };
  });

  let normal = null;

  if (normalRoute) {
    const durationMinutes = Math.max(1, Math.round(normalRoute.durationMillis / 60000));
    normal = {
      key: 'normal',
      route: normalRoute,
      type: 'normal',
      label: '通常ルート（渋滞回避を優先しない）',
      durationMinutes,
      staticMinutes: durationMinutes,
      delayMinutes: 0,
      distanceKm: Number.isFinite(normalRoute.distanceMeters) ? normalRoute.distanceMeters / 1000 : null,
      eta: new Date(now + durationMinutes * 60000),
      speedSummary: { normal: 0, slow: 0, jam: 0 },
      navigationSteps: extractNavigationSteps(normalRoute),
      trafficSegments: [],
      description: normalRoute.description || ''
    };
  }

  const recommended = traffic[0];
  const baselineMinutes = normal?.durationMinutes ?? recommended.staticMinutes;
  const trafficImpactMinutes = Math.max(0, recommended.durationMinutes - baselineMinutes);

  return {
    createdAt: new Date(),
    recommended,
    alternatives: traffic.slice(1),
    normal,
    trafficImpactMinutes
  };
}

function summarizeSpeedPaths(speedPaths) {
  const summary = { normal: 0, slow: 0, jam: 0 };

  for (const segment of speedPaths) {
    const speed = String(segment.speed || '').toUpperCase();
    if (speed.includes('TRAFFIC_JAM')) summary.jam += 1;
    else if (speed.includes('SLOW')) summary.slow += 1;
    else summary.normal += 1;
  }

  return summary;
}

function renderAnalysis(analysis) {
  const container = $('analysisResults');
  container.hidden = false;
  container.innerHTML = '';

  const allCards = routeItems(analysis);

  for (const item of allCards) {
    const card = document.createElement('article');
    card.className = 'route-card ' + item.type + (item.key === selectedRouteKey ? ' selected' : '');

    const trafficText = trafficTextFor(item);
    const distanceText = item.distanceKm == null ? '—' : item.distanceKm.toFixed(1) + ' km';
    const delayText = item.type === 'normal'
      ? '交通未考慮'
      : item.delayMinutes > 0
        ? '+' + item.delayMinutes + '分'
        : '大きな遅れなし';

    card.innerHTML = `
      <div class="route-card-head">
        <div>
          <h3>${escapeHtml(item.label)}</h3>
          <span class="note">${escapeHtml(item.description || trafficText)}</span>
        </div>
        <span class="tag">${escapeHtml(trafficText)}</span>
      </div>
      <div class="metrics">
        <div class="metric"><strong>${item.durationMinutes}分</strong><span>所要時間</span></div>
        <div class="metric"><strong>${formatTime(item.eta)}</strong><span>到着予定</span></div>
        <div class="metric"><strong>${distanceText}</strong><span>距離</span></div>
        <div class="metric"><strong>${delayText}</strong><span>交通影響</span></div>
      </div>
      ${renderTrafficBars(item)}
      ${renderTrafficLocations(item)}
      <button class="route-select-button secondary" type="button" data-route-key="${escapeHtml(item.key)}">
        ${item.key === selectedRouteKey ? 'この経路を選択中' : 'この経路を選ぶ'}
      </button>
    `;

    container.appendChild(card);
  }

  container.querySelectorAll('[data-route-key]').forEach((button) => {
    button.addEventListener('click', () => selectRoute(button.dataset.routeKey));
  });

  const attribution = document.createElement('p');
  attribution.className = 'google-attribution';
  attribution.innerHTML = '<strong>Google</strong> の経路・交通データを使用。渋滞位置は交通速度区分から示します。事故・工事・規制の原因は別データがない限り断定しません。';
  container.appendChild(attribution);
}

function renderTrafficBars(item) {
  if (item.type === 'normal') {
    return '<p class="note">現在交通を優先せず計算した比較用ルートです。</p>';
  }

  const summary = item.speedSummary;
  const total = summary.normal + summary.slow + summary.jam;

  if (!total) {
    return '<p class="note">交通区間の分類を取得できませんでした。</p>';
  }

  const segments = [];
  for (let i = 0; i < summary.normal; i++) segments.push('<span class="normal"></span>');
  for (let i = 0; i < summary.slow; i++) segments.push('<span class="slow"></span>');
  for (let i = 0; i < summary.jam; i++) segments.push('<span class="jam"></span>');

  return '<div class="traffic-bars" aria-label="緑は通常、橙は混雑、赤は渋滞">' + segments.slice(0, 30).join('') + '</div>';
}

function trafficTextFor(item) {
  if (item.type === 'normal') return '通常比較';

  if (item.speedSummary.jam > 0) return '渋滞区間あり';
  if (item.speedSummary.slow > 0) return '混雑区間あり';
  if (item.delayMinutes >= 8) return '遅れあり';
  return '概ね順調';
}

function buildStatusSummary(analysis) {
  const rec = analysis.recommended;
  const traffic = trafficTextFor(rec);

  if (rec.delayMinutes > 0) {
    return traffic + '。推奨ルートは約' + rec.durationMinutes + '分、到着予定' + formatTime(rec.eta) + '。通常時目安より約' + rec.delayMinutes + '分の遅れです。';
  }

  return traffic + '。推奨ルートは約' + rec.durationMinutes + '分、到着予定' + formatTime(rec.eta) + 'です。';
}

function drawGoogleRoutes(analysis) {
  if (mapMode !== 'google' || !googleMap || !window.google?.maps) return;

  clearGoogleRouteOverlays();

  const all = routeItems(analysis);
  const selected = selectedRouteItem();

  for (const item of all) {
    if (!item?.route?.path?.length) continue;
    if (selected && item.key === selected.key) continue;

    const color = item.type === 'normal' ? '#2563eb' : '#94a3b8';
    googleRouteOverlays.push(new google.maps.Polyline({
      map: googleMap,
      path: pathToGoogle(item.route.path),
      strokeColor: color,
      strokeOpacity: 0.28,
      strokeWeight: 5,
      zIndex: 1
    }));
  }

  if (selected?.route?.speedPaths?.length) {
    for (const speedPath of selected.route.speedPaths) {
      googleRouteOverlays.push(new google.maps.Polyline({
        map: googleMap,
        path: pathToGoogle(speedPath.path || []),
        strokeColor: colorForSpeed(speedPath.speed),
        strokeOpacity: 0.98,
        strokeWeight: 9,
        zIndex: 5
      }));
    }
  } else if (selected?.route?.path?.length) {
    googleRouteOverlays.push(new google.maps.Polyline({
      map: googleMap,
      path: pathToGoogle(selected.route.path),
      strokeColor: selected.type === 'normal' ? '#2563eb' : '#22c55e',
      strokeOpacity: 0.98,
      strokeWeight: 9,
      zIndex: 5
    }));
  }

  addTrafficMarkers(selected);

  if (selected?.route) {
    fitGoogleRoutePaths([selected.route]);
  }
}

function clearGoogleRouteOverlays() {
  for (const overlay of googleRouteOverlays) overlay.setMap?.(null);
  googleRouteOverlays = [];
  for (const marker of trafficMarkers) marker.setMap?.(null);
  trafficMarkers = [];
}

function pathToGoogle(path) {
  return (path || [])
    .map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function fitGoogleRoutePaths(routes) {
  if (!googleMap || !window.google?.maps) return;

  const bounds = new google.maps.LatLngBounds();
  let hasPoint = false;

  for (const route of routes) {
    for (const point of pathToGoogle(route.path || [])) {
      bounds.extend(point);
      hasPoint = true;
    }
  }

  if (hasPoint) googleMap.fitBounds(bounds, 45);
}

function colorForSpeed(speed) {
  const value = String(speed || '').toUpperCase();
  if (value.includes('TRAFFIC_JAM')) return '#ef4444';
  if (value.includes('SLOW')) return '#f59e0b';
  return '#22c55e';
}

function speakAnalysis(analysis) {
  const rec = analysis.recommended;
  const alternatives = analysis.alternatives || [];
  const traffic = trafficTextFor(rec);

  let text = '交通解析が完了しました。' + traffic + '。';
  text += '推奨ルートは約' + rec.durationMinutes + '分、到着予定は' + spokenTime(rec.eta) + 'です。';

  if (rec.delayMinutes > 0) {
    text += '通常時の目安より約' + rec.delayMinutes + '分遅れています。';
  }

  const notable = rec.trafficSegments
    .filter((segment) => segment.level === 'jam' || segment.level === 'slow')
    .slice(0, 3);

  if (notable.length) {
    text += '交通情報です。';
    for (const segment of notable) {
      text += segment.label + 'で' + (segment.level === 'jam' ? '渋滞' : '混雑') + 'があります。';
    }
  }

  if (alternatives.length) {
    const bestAlternative = alternatives[0];
    text += '代替ルートは約' + bestAlternative.durationMinutes + '分です。';
  }

  text += '経路カードから、推奨ルート、代替ルート、渋滞回避を優先しない通常ルートを選べます。';
  text += '事故や工事、規制の原因は、現在のGoogle経路データだけでは断定していません。';

  speakText(text);
}

function speakText(text) {
  if (!('speechSynthesis' in window)) {
    toast('このブラウザでは音声読み上げを利用できません。');
    return;
  }

  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(
    String(text)
      .replace(/。+/g, '。 ')
      .replace(/、+/g, '、 ')
      .replace(/\s+/g, ' ')
      .trim()
  );

  const voice = bestJapaneseVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang || 'ja-JP';
  } else {
    utterance.lang = 'ja-JP';
  }

  // iPhoneでは少しゆっくりめの方が日本語の抑揚が自然になりやすい。
  utterance.rate = 0.94;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  try {
    speechSynthesis.speak(utterance);
  } catch {
    toast('音声読み上げを開始できませんでした。');
  }
}

async function openGoogleMapsNavigation() {
  const endpoints = await routeEndpoints();
  if (!endpoints) return;

  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', endpointForUrl(endpoints.origin));
  url.searchParams.set('destination', endpointForUrl(endpoints.destination));
  url.searchParams.set('travelmode', 'driving');
  url.searchParams.set('dir_action', 'navigate');

  const selected = selectedRouteItem();
  const path = pathToGoogle(selected?.route?.path || []);
  if (path.length >= 8) {
    const waypointIndices = [0.25, 0.5, 0.75]
      .map((ratio) => Math.min(path.length - 2, Math.max(1, Math.round((path.length - 1) * ratio))));
    const waypoints = waypointIndices.map((index) => path[index].lat + ',' + path[index].lng);
    url.searchParams.set('waypoints', waypoints.join('|'));
  }

  window.open(url.toString(), '_blank', 'noopener');
}

function endpointForUrl(value) {
  if (typeof value === 'string') return value;
  if (value && Number.isFinite(value.lat) && Number.isFinite(value.lng)) return value.lat + ',' + value.lng;
  return String(value || '');
}

function routeItems(analysis = latestAnalysis) {
  if (!analysis) return [];
  return [
    analysis.recommended,
    ...(analysis.alternatives || []),
    ...(analysis.normal ? [analysis.normal] : [])
  ].filter(Boolean);
}

function selectedRouteItem() {
  const items = routeItems();
  return items.find((item) => item.key === selectedRouteKey) || items[0] || null;
}

function selectRoute(key) {
  const item = routeItems().find((route) => route.key === key);
  if (!item) return;

  selectedRouteKey = item.key;
  drivingSpokenAlerts.clear();
  drivingSpokenSteps.clear();
  renderAnalysis(latestAnalysis);
  drawGoogleRoutes(latestAnalysis);
  updateSelectedRoutePanel();
  speakText(item.label + 'を選択しました。所要時間は約' + item.durationMinutes + '分、到着予定は' + spokenTime(item.eta) + 'です。');
}

function updateSelectedRoutePanel() {
  const panel = $('selectedRoutePanel');
  const item = selectedRouteItem();

  if (!panel || !item) {
    if (panel) panel.hidden = true;
    return;
  }

  panel.hidden = false;
  $('selectedRouteTitle').textContent = item.label;
  $('selectedRouteSummary').textContent =
    '約' + item.durationMinutes + '分・' + formatTime(item.eta) + '着' +
    (item.trafficSegments?.length ? '・混雑/渋滞区間 ' + item.trafficSegments.length + '件' : '');
}

function extractNavigationSteps(route) {
  const steps = [];
  for (const leg of route?.legs || []) {
    for (const step of leg.steps || []) {
      const path = pathToGoogle(step.path || []);
      const start = directionalLocationToPoint(step.startLocation) || path[0] || null;
      const end = directionalLocationToPoint(step.endLocation) || path[path.length - 1] || null;
      steps.push({
        instructions: stripHtml(step.instructions || ''),
        maneuver: String(step.maneuver || ''),
        distanceMeters: Number(step.distanceMeters) || 0,
        path,
        start,
        end
      });
    }
  }
  return steps;
}

function directionalLocationToPoint(location) {
  if (!location) return null;
  const latLng = location.latLng || location.location || location;
  const lat = typeof latLng.lat === 'function' ? latLng.lat() : Number(latLng.lat);
  const lng = typeof latLng.lng === 'function' ? latLng.lng() : Number(latLng.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function deriveTrafficSegments(route, navigationSteps) {
  const routePath = pathToGoogle(route?.path || []);
  const result = [];

  for (const speedPath of route?.speedPaths || []) {
    const level = speedLevel(speedPath.speed);
    if (level === 'normal') continue;

    const path = pathToGoogle(speedPath.path || []);
    if (!path.length) continue;

    const midpoint = path[Math.floor(path.length / 2)];
    const routeIndex = nearestPathIndex(routePath, midpoint);
    const distanceKm = routeIndex >= 0 ? pathDistanceKm(routePath, routeIndex) : null;
    const step = nearestNavigationStep(navigationSteps, midpoint);
    const instruction = step?.instructions || '';
    const label = instruction
      ? (distanceKm == null ? instruction : '出発から約' + distanceKm.toFixed(1) + 'km付近・' + instruction)
      : (distanceKm == null ? '経路上' : '出発から約' + distanceKm.toFixed(1) + 'km付近');

    result.push({
      id: level + '-' + result.length + '-' + midpoint.lat.toFixed(4) + '-' + midpoint.lng.toFixed(4),
      level,
      midpoint,
      path,
      label,
      instruction
    });
  }

  return result.slice(0, 12);
}

function renderTrafficLocations(item) {
  if (item.type === 'normal') {
    return '<p class="traffic-location-note">このルートは交通を優先せず比較した経路です。現在の渋滞区分は付けていません。</p>';
  }

  const segments = item.trafficSegments || [];
  if (!segments.length) {
    return '<p class="traffic-location-note">目立った混雑・渋滞区間は検出されていません。</p>';
  }

  const rows = segments.slice(0, 6).map((segment) => {
    const kind = segment.level === 'jam' ? '渋滞' : '混雑';
    return '<li class="' + segment.level + '"><strong>' + kind + '</strong><span>' + escapeHtml(segment.label) + '</span></li>';
  }).join('');

  return '<div class="traffic-locations"><strong>交通が遅い場所</strong><ul>' + rows + '</ul></div>';
}

function addTrafficMarkers(item) {
  if (!googleMap || !window.google?.maps || !item?.trafficSegments?.length) return;

  for (const segment of item.trafficSegments) {
    const jam = segment.level === 'jam';
    const marker = new google.maps.Marker({
      map: googleMap,
      position: segment.midpoint,
      title: (jam ? '渋滞：' : '混雑：') + segment.label,
      label: {
        text: jam ? '渋' : '混',
        color: '#ffffff',
        fontWeight: '700',
        fontSize: '11px'
      },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 14,
        fillColor: jam ? '#ef4444' : '#f59e0b',
        fillOpacity: 0.95,
        strokeColor: '#ffffff',
        strokeWeight: 2
      },
      zIndex: 20
    });
    trafficMarkers.push(marker);
  }
}

function speedLevel(speed) {
  const value = String(speed || '').toUpperCase();
  if (value.includes('TRAFFIC_JAM')) return 'jam';
  if (value.includes('SLOW')) return 'slow';
  return 'normal';
}

function nearestNavigationStep(steps, point) {
  let best = null;
  let bestDistance = Infinity;

  for (const step of steps || []) {
    const candidates = step.path?.length ? step.path : [step.start, step.end].filter(Boolean);
    for (const candidate of candidates) {
      const distance = haversineMeters(point, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = step;
      }
    }
  }
  return best;
}

function nearestPathIndex(path, point) {
  if (!path?.length || !point) return -1;
  let bestIndex = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < path.length; i++) {
    const distance = haversineMeters(point, path[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function pathDistanceKm(path, endIndex) {
  let meters = 0;
  for (let i = 1; i <= endIndex && i < path.length; i++) {
    meters += haversineMeters(path[i - 1], path[i]);
  }
  return meters / 1000;
}

function haversineMeters(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function stripHtml(value) {
  const el = document.createElement('div');
  el.innerHTML = String(value || '');
  return (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
}

function startDrivingFollow() {
  const item = selectedRouteItem();
  if (!item?.route?.path?.length) {
    toast('先に交通解析を行い、経路を選択してください。');
    return;
  }

  if (!navigator.geolocation) {
    toast('この端末では位置情報の追従を利用できません。');
    return;
  }

  if (drivingWatchId != null) stopDrivingFollow();

  drivingSpokenAlerts.clear();
  drivingSpokenSteps.clear();
  $('startDrivingBtn').hidden = true;
  $('stopDrivingBtn').hidden = false;
  $('drivingStatus').hidden = false;
  $('drivingProgress').textContent = '現在地を取得中…';
  $('drivingInstruction').textContent = '選択した経路に沿って地図を追従します。';

  speakText(item.label + 'で走行追従を開始します。画面を開いたまま利用してください。');

  drivingWatchId = navigator.geolocation.watchPosition(
    handleDrivingPosition,
    (error) => {
      $('drivingProgress').textContent = '現在地を取得できません';
      $('drivingInstruction').textContent = error.code === 1
        ? '位置情報の利用を許可してください。'
        : 'GPS情報を取得できませんでした。';
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 12000 }
  );
}

function stopDrivingFollow() {
  if (drivingWatchId != null) {
    navigator.geolocation.clearWatch(drivingWatchId);
    drivingWatchId = null;
  }

  if (drivingMarker) {
    drivingMarker.setMap?.(null);
    drivingMarker = null;
  }

  $('startDrivingBtn').hidden = false;
  $('stopDrivingBtn').hidden = true;
  $('drivingStatus').hidden = true;
  toast('走行追従を停止しました。');
}

function handleDrivingPosition(position) {
  const item = selectedRouteItem();
  if (!item) return;

  const point = {
    lat: position.coords.latitude,
    lng: position.coords.longitude
  };
  currentLocation = { ...point, accuracy: position.coords.accuracy };

  if (googleMap && window.google?.maps) {
    if (!drivingMarker) {
      drivingMarker = new google.maps.Marker({
        map: googleMap,
        position: point,
        title: '走行中の現在地',
        zIndex: 100
      });
    } else {
      drivingMarker.setPosition(point);
    }
    googleMap.panTo(point);
    if ((googleMap.getZoom?.() || 0) < 15) googleMap.setZoom(15);
  }

  const routePath = pathToGoogle(item.route.path || []);
  const nearestIndex = nearestPathIndex(routePath, point);
  const totalKm = Math.max(0.01, pathDistanceKm(routePath, routePath.length - 1));
  const progressKm = nearestIndex >= 0 ? pathDistanceKm(routePath, nearestIndex) : 0;
  const progressPct = Math.min(100, Math.max(0, Math.round(progressKm / totalKm * 100)));
  const remainingKm = Math.max(0, totalKm - progressKm);

  $('drivingProgress').textContent =
    item.label + '・進行 ' + progressPct + '%・残り約' + remainingKm.toFixed(1) + 'km';

  const nextStep = nearestUpcomingStep(item.navigationSteps, point);
  $('drivingInstruction').textContent = nextStep?.instructions || '選択した経路を走行中です。';

  maybeSpeakDrivingStep(nextStep, point);
  maybeSpeakTrafficAlert(item, point);
}

function nearestUpcomingStep(steps, point) {
  let best = null;
  let bestDistance = Infinity;

  for (let i = 0; i < (steps || []).length; i++) {
    const step = steps[i];
    const target = step.start || step.path?.[0] || step.end;
    if (!target) continue;
    const distance = haversineMeters(point, target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { ...step, index: i, distanceMetersFromCurrent: distance };
    }
  }

  return best;
}

function maybeSpeakDrivingStep(step, point) {
  if (!step?.instructions || step.distanceMetersFromCurrent > 220) return;
  const key = step.index + ':' + step.instructions;
  if (drivingSpokenSteps.has(key)) return;
  drivingSpokenSteps.add(key);
  speakText('まもなく、' + step.instructions + '。');
}

function maybeSpeakTrafficAlert(item, point) {
  for (const segment of item.trafficSegments || []) {
    const distance = haversineMeters(point, segment.midpoint);
    if (distance > 1200 || drivingSpokenAlerts.has(segment.id)) continue;

    drivingSpokenAlerts.add(segment.id);
    const kind = segment.level === 'jam' ? '渋滞' : '混雑';
    const distanceText = distance >= 1000
      ? '約' + (distance / 1000).toFixed(1) + 'キロ先'
      : '約' + Math.max(100, Math.round(distance / 100) * 100) + 'メートル先';

    speakText(distanceText + '、' + segment.label + 'で' + kind + 'があります。選択中の経路はこの区間を通ります。');
  }
}

function showMapTapChoice(point) {
  pendingMapPoint = {
    lat: Number(point.lat),
    lng: Number(point.lng)
  };

  if (!Number.isFinite(pendingMapPoint.lat) || !Number.isFinite(pendingMapPoint.lng)) return;

  $('mapTapCoords').textContent =
    pendingMapPoint.lat.toFixed(5) + ', ' + pendingMapPoint.lng.toFixed(5);
  $('mapTapChoice').hidden = false;
}

function hideMapTapChoice() {
  pendingMapPoint = null;
  $('mapTapChoice').hidden = true;
}

function applyPendingMapPoint(kind) {
  if (!pendingMapPoint) return;

  const point = { ...pendingMapPoint };

  if (kind === 'origin') {
    prefs.mapOrigin = point;
    originText.value = '';
    originSelect.value = '';
    toast('地図で選んだ地点を出発地に設定しました。');
  } else {
    prefs.mapDestination = point;
    destinationText.value = '';
    destinationSelect.value = '';
    toast('地図で選んだ地点を到着地に設定しました。');
  }

  hideMapTapChoice();
  saveRoutePrefs();
  updateMarkers();
  updateRouteSummary();
  fitSelectedPlaces();
  scheduleAutomaticAnalysis(350);
}

function addOpenPickedMarker(key, point, label, color, title) {
  if (!mapLibre || !point) return;

  const el = document.createElement('div');
  el.textContent = label;
  el.style.cssText =
    'width:30px;height:30px;border-radius:50%;display:grid;place-items:center;' +
    'background:' + color + ';color:white;font-weight:900;border:3px solid white;' +
    'box-shadow:0 3px 12px rgba(0,0,0,.35);font-size:12px';

  const marker = new maplibregl.Marker({ element: el })
    .setLngLat([point.lng, point.lat])
    .setPopup(new maplibregl.Popup({ offset: 18 }).setText(title))
    .addTo(mapLibre);

  openMarkers.set(key, marker);
}

function prepareVoices() {
  if (!('speechSynthesis' in window)) return;

  const refresh = () => {
    japaneseVoices = speechSynthesis.getVoices()
      .filter((voice) => /^ja(?:-|_)/i.test(voice.lang || '') || /japan|日本/i.test(voice.name || ''));
    renderVoiceOptions();
  };

  refresh();
  speechSynthesis.addEventListener?.('voiceschanged', refresh);
}

function renderVoiceOptions() {
  const select = $('voiceSelect');
  if (!select) return;

  const selected = googleSettings.voiceURI || '';
  select.innerHTML = '<option value="">自動（日本語の自然な音声を優先）</option>';

  const voices = [...japaneseVoices].sort((a, b) => voiceScore(b) - voiceScore(a));

  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    option.textContent = voice.name + '（' + voice.lang + '）';
    select.appendChild(option);
  }

  select.value = voices.some((voice) => voice.voiceURI === selected) ? selected : '';
}

function bestJapaneseVoice() {
  if (!('speechSynthesis' in window)) return null;

  const voices = japaneseVoices.length
    ? japaneseVoices
    : speechSynthesis.getVoices().filter((voice) => /^ja(?:-|_)/i.test(voice.lang || ''));

  if (!voices.length) return null;

  if (googleSettings.voiceURI) {
    const preferred = voices.find((voice) => voice.voiceURI === googleSettings.voiceURI);
    if (preferred) return preferred;
  }

  return [...voices].sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
}

function voiceScore(voice) {
  let score = 0;
  const lang = String(voice.lang || '').toLowerCase();
  const name = String(voice.name || '').toLowerCase();

  if (lang === 'ja-jp') score += 50;
  else if (lang.startsWith('ja')) score += 35;

  if (voice.localService) score += 12;
  if (/siri|premium|enhanced|kyoko|otoya|hattori|haruka/.test(name)) score += 20;
  if (/compact|basic/.test(name)) score -= 8;

  return score;
}

function updateRouteSummary() {
  const nameFor = (id) => id === '__current__'
    ? '現在地'
    : (places.find((p) => p.id === id)?.name || '');

  const a = originText.value.trim() || (prefs.mapOrigin ? '地図で選択した出発地' : nameFor(originSelect.value));
  const b = destinationText.value.trim() || (prefs.mapDestination ? '地図で選択した到着地' : nameFor(destinationSelect.value));

  $('routeTitle').textContent = a && b ? a + ' → ' + b : '出発地と到着地を設定してください';

  if (a && b && googleSettings.apiKey) {
    $('routeHint').textContent = '現在交通を考慮した推奨・代替ルートと、交通を優先しない通常ルートを比較できます。';
  } else if (a && b) {
    $('routeHint').textContent = 'Web用Google APIキーを設定すると、この2地点の交通状況を自動解析できます。';
  } else {
    $('routeHint').textContent = '保存地点から選ぶか、住所・施設名を直接入力できます。';
  }
}

function saveRoutePrefs() {
  prefs = {
    origin: originSelect.value,
    destination: destinationSelect.value,
    originText: originText.value.trim(),
    destinationText: destinationText.value.trim(),
    mapOrigin: prefs.mapOrigin || null,
    mapDestination: prefs.mapDestination || null
  };
  saveJSON(PREF_KEY, prefs);
}

function setAnalysisStatus(title, message, type = '') {
  const el = $('analysisStatus');
  el.className = 'analysis-status' + (type ? ' ' + type : '');
  el.innerHTML = '<strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(message) + '</span>';
}

function updateGoogleModeBadge() {
  const badge = $('googleModeBadge');

  if (googleSettings.apiKey) {
    badge.textContent = '設定済み';
    badge.className = 'badge online';
  } else {
    badge.textContent = '未設定';
    badge.className = 'badge';
  }
}

function usageToday() {
  const today = localDateKey();
  const stored = loadJSON(USAGE_KEY, { date: today, count: 0 });

  if (stored.date !== today) return { date: today, count: 0 };
  return stored;
}

function reserveAnalysis() {
  const usage = usageToday();

  if (usage.count >= DAILY_ANALYSIS_LIMIT) return false;

  usage.count += 1;
  saveJSON(USAGE_KEY, usage);

  if (usage.count === WARNING_THRESHOLD) {
    toast('本日の交通解析が25回になりました。上限は30回です。');
  }

  return true;
}

function updateUsageUI() {
  const usage = usageToday();
  $('analysisUsage').textContent = '本日 ' + usage.count + ' / ' + DAILY_ANALYSIS_LIMIT + '回';
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

function normalizeGoogleError(error) {
  const raw = String(error?.message || error || '不明なエラー');

  if (/referer|referrer|not authorized|denied|api key/i.test(raw)) {
    return 'APIキーのWebサイト制限を https://hakunou22hr.github.io に設定し、API制限に Maps JavaScript API と Routes API の両方が含まれているか確認してください。';
  }

  if (/billing/i.test(raw)) {
    return 'Google Cloudの請求先設定または無料枠・利用条件を確認してください。';
  }

  return raw.length > 180 ? raw.slice(0, 180) + '…' : raw;
}

function formatTime(date) {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function spokenTime(date) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(date);

  const hour = parts.find((part) => part.type === 'hour')?.value || '';
  const minute = parts.find((part) => part.type === 'minute')?.value || '00';
  return hour + '時' + minute + '分';
}

function stableEndpointKey(value) {
  if (typeof value === 'string') return value.trim().toLowerCase();
  return Number(value?.lat).toFixed(5) + ',' + Number(value?.lng).toFixed(5);
}

function localDateKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js?v=10').catch(() => {});
  });
}
