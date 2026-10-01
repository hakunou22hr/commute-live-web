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
let prefs = loadJSON(PREF_KEY, { origin: '__current__', destination: '', originText: '', destinationText: '' });
let googleSettings = loadJSON(GOOGLE_SETTINGS_KEY, { apiKey: '', autoSpeak: true });
let currentLocation = null;

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

const $ = (id) => document.getElementById(id);
const originSelect = $('originSelect');
const destinationSelect = $('destinationSelect');
const originText = $('originText');
const destinationText = $('destinationText');

setupListeners();
render();
updateNetwork();
updateUsageUI();
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

    saveRoutePrefs();
    updateRouteSummary();
    fitSelectedPlaces();
    scheduleAutomaticAnalysis();
  });

  originSelect.addEventListener('change', () => {
    if (originSelect.value) originText.value = '';
    saveRoutePrefs();
    updateRouteSummary();
    fitSelectedPlaces();
    scheduleAutomaticAnalysis(300);
  });

  destinationSelect.addEventListener('change', () => {
    if (destinationSelect.value) destinationText.value = '';
    saveRoutePrefs();
    updateRouteSummary();
    fitSelectedPlaces();
    scheduleAutomaticAnalysis(300);
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
      autoSpeak: $('autoSpeakToggle').checked
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
}

async function initMapExperience() {
  $('googleApiKey').value = googleSettings.apiKey || '';
  $('autoSpeakToggle').checked = googleSettings.autoSpeak !== false;
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
}

function updateSelectedLine() {
  if (mapMode !== 'open') return;
  if (!mapLibre || !mapLibre.isStyleLoaded() || !mapLibre.getSource('selected-pair')) return;

  const a = originText.value.trim() ? null : selectedCoords(originSelect.value);
  const b = destinationText.value.trim() ? null : selectedCoords(destinationSelect.value);

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
    originText.value.trim() ? null : selectedCoords(originSelect.value),
    destinationText.value.trim() ? null : selectedCoords(destinationSelect.value)
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

  const origin = typedOrigin || routeEndpointValue(originSelect.value, true);
  const destination = typedDestination || routeEndpointValue(destinationSelect.value, false);

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
  const originReady = Boolean(originText.value.trim() || originSelect.value);
  const destinationReady = Boolean(destinationText.value.trim() || destinationSelect.value);
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
    inMemoryCache = { key: cacheKey, at: Date.now(), analysis: latestAnalysis };

    renderAnalysis(latestAnalysis);
    drawGoogleRoutes(latestAnalysis);
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
      label: '通常ルート',
      durationMinutes,
      staticMinutes: durationMinutes,
      delayMinutes: 0,
      distanceKm: Number.isFinite(normalRoute.distanceMeters) ? normalRoute.distanceMeters / 1000 : null,
      eta: new Date(now + durationMinutes * 60000),
      speedSummary: { normal: 0, slow: 0, jam: 0 },
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

  const allCards = [
    analysis.recommended,
    ...(analysis.alternatives || []),
    ...(analysis.normal ? [analysis.normal] : [])
  ];

  for (const item of allCards) {
    const card = document.createElement('article');
    card.className = 'route-card ' + item.type;

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
    `;

    container.appendChild(card);
  }

  const attribution = document.createElement('p');
  attribution.className = 'google-attribution';
  attribution.innerHTML = '<strong>Google</strong> の経路・交通データを使用。事故・工事など遅れの原因は未確認の場合があります。';
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

  if (analysis.normal?.route?.path?.length) {
    googleRouteOverlays.push(new google.maps.Polyline({
      map: googleMap,
      path: pathToGoogle(analysis.normal.route.path),
      strokeColor: '#2563eb',
      strokeOpacity: 0.45,
      strokeWeight: 7,
      zIndex: 1
    }));
  }

  for (const alt of analysis.alternatives || []) {
    if (!alt.route?.path?.length) continue;

    googleRouteOverlays.push(new google.maps.Polyline({
      map: googleMap,
      path: pathToGoogle(alt.route.path),
      strokeColor: '#f59e0b',
      strokeOpacity: 0.7,
      strokeWeight: 5,
      zIndex: 2
    }));
  }

  const recommended = analysis.recommended;

  if (recommended.route?.speedPaths?.length) {
    for (const speedPath of recommended.route.speedPaths) {
      googleRouteOverlays.push(new google.maps.Polyline({
        map: googleMap,
        path: pathToGoogle(speedPath.path || []),
        strokeColor: colorForSpeed(speedPath.speed),
        strokeOpacity: 0.95,
        strokeWeight: 8,
        zIndex: 4
      }));
    }
  } else if (recommended.route?.path?.length) {
    googleRouteOverlays.push(new google.maps.Polyline({
      map: googleMap,
      path: pathToGoogle(recommended.route.path),
      strokeColor: '#22c55e',
      strokeOpacity: 0.95,
      strokeWeight: 8,
      zIndex: 4
    }));
  }

  fitGoogleRoutePaths([
    recommended.route,
    ...(analysis.alternatives || []).map((item) => item.route),
    analysis.normal?.route
  ].filter(Boolean));
}

function clearGoogleRouteOverlays() {
  for (const overlay of googleRouteOverlays) overlay.setMap?.(null);
  googleRouteOverlays = [];
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

  if (alternatives.length) {
    const bestAlternative = alternatives[0];
    text += '代替ルートは約' + bestAlternative.durationMinutes + '分です。';
  }

  text += '事故や工事など遅れの原因はGoogleの経路情報だけでは断定しません。必要に応じて公式道路情報を確認してください。';

  speakText(text);
}

function speakText(text) {
  if (!('speechSynthesis' in window)) {
    toast('このブラウザでは音声読み上げを利用できません。');
    return;
  }

  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP';
  utterance.rate = 1.02;

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

  window.open(url.toString(), '_blank', 'noopener');
}

function endpointForUrl(value) {
  if (typeof value === 'string') return value;
  if (value && Number.isFinite(value.lat) && Number.isFinite(value.lng)) return value.lat + ',' + value.lng;
  return String(value || '');
}

function updateRouteSummary() {
  const nameFor = (id) => id === '__current__'
    ? '現在地'
    : (places.find((p) => p.id === id)?.name || '');

  const a = originText.value.trim() || nameFor(originSelect.value);
  const b = destinationText.value.trim() || nameFor(destinationSelect.value);

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
    destinationText: destinationText.value.trim()
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
    navigator.serviceWorker.register('./sw.js?v=7').catch(() => {});
  });
}
