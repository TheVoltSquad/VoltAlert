// alertzones.js
// Helpers to fetch zone geometry from api.weather.gov
(function(){
  const MAX_CONCURRENT_REQUESTS = 10;
  let activeRequests = 0;
  const requestQueue = [];
  const zoneGeometryCache = {}; // Add this line for caching
  const zoneGeometryInFlight = {}; // Tracks in-progress fetches so concurrent callers share one request

  async function rateLimitedFetch(url, fetcher) {
    return new Promise((resolve, reject) => {
      const task = async () => {
        try {
          const result = await fetcher();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          activeRequests--;
          processQueue();
        }
      };

      requestQueue.push(task);
      processQueue();
    });
  }

  function processQueue() {
    if (activeRequests < MAX_CONCURRENT_REQUESTS && requestQueue.length > 0) {
      const task = requestQueue.shift();
      activeRequests++;
      task();
    }
  }

  async function fetchZoneGeometryUncached(ugc) {
    const getZoneGeometryFromResponse = (json) => {
      if (!json || typeof json !== 'object') return null;
      if (json.geometry) return json.geometry;
      if (Array.isArray(json.features) && json.features.length > 0) {
        const geometries = json.features
          .map((feature) => feature && feature.geometry)
          .filter(Boolean);
        if (geometries.length === 0) return null;
        if (geometries.length === 1) return geometries[0];
        if (typeof window !== 'undefined' && window.turf && typeof window.turf.union === 'function' && typeof window.turf.feature === 'function') {
          try {
            return geometries.reduce((merged, geometry) => {
              if (!merged) return geometry;
              const unioned = window.turf.union(window.turf.feature(merged), window.turf.feature(geometry));
              return unioned && unioned.geometry ? unioned.geometry : merged;
            }, null);
          } catch (e) {
            console.warn('[alerts] turf.union failed on FeatureCollection geometry merge', e);
          }
        }
        const coords = [];
        geometries.forEach((geometry) => {
          if (geometry.type === 'Polygon') coords.push(geometry.coordinates);
          else if (geometry.type === 'MultiPolygon') coords.push(...geometry.coordinates);
        });
        return coords.length ? { type: 'MultiPolygon', coordinates: coords } : null;
      }
      return null;
    };

    // Decide endpoint order based on the UGC type character.
    // UGC format is typically: <STATE><TYPE><NUMBER> e.g. VAZ123 or VAC045
    // TYPE 'Z' => forecast zones, TYPE 'C' => county zones
    const getGeometryFromResponse = (json) => {
      if (!json || typeof json !== 'object') return null;
      if (json.geometry) return json.geometry;

      if (Array.isArray(json.features) && json.features.length > 0) {
        const geometries = json.features
          .map(feature => feature && feature.geometry)
          .filter(Boolean);
        if (geometries.length === 0) return null;
        if (geometries.length === 1) return geometries[0];

        if (typeof window !== 'undefined' && window.turf && typeof window.turf.union === 'function' && typeof window.turf.feature === 'function') {
          try {
            const merged = geometries.reduce((current, geometry) => {
              if (!current) return geometry;
              const unioned = window.turf.union(window.turf.feature(current), window.turf.feature(geometry));
              return unioned && unioned.geometry ? unioned.geometry : current;
            }, null);
            if (merged) return merged;
          } catch (e) {
            console.warn('[alerts] turf.union failed while merging FeatureCollection geometries', e);
          }
        }

        const coords = [];
        geometries.forEach((geometry) => {
          if (!geometry || !geometry.type) return;
          if (geometry.type === 'Polygon') coords.push(geometry.coordinates);
          else if (geometry.type === 'MultiPolygon') coords.push(...geometry.coordinates);
        });
        return coords.length ? { type: 'MultiPolygon', coordinates: coords } : null;
      }

      return null;
    };

    const urlsFor = {
      forecast: `https://api.weather.gov/zones/forecast/${ugc}`,
      county: `https://api.weather.gov/zones/county/${ugc}`,
      fire: `https://api.weather.gov/zones/fire/${ugc}`
    };

    const typeChar = (ugc && ugc.length >= 3) ? ugc.charAt(2) : '';
    let tryOrder;
    if (typeChar === 'Z') {
      // Z is forecast; if forecast fails, try fire then county
      tryOrder = ['forecast', 'fire', 'county'];
    } else if (typeChar === 'C') {
      // C is county — try county first, then fallbacks
      tryOrder = ['county', 'forecast', 'fire'];
    } else {
      // Unknown type: try forecast, county, then fire (previous default)
      tryOrder = ['forecast', 'county', 'fire'];
    }

    const tryUrls = tryOrder.map(k => urlsFor[k]);

    for (const url of tryUrls) {
      try {
        const res = await rateLimitedFetch(url, () => fetch(url));

        if (!res.ok) {
          console.warn(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
          continue; // Try next URL
        }

        let json;
        try {
          json = await res.json();
        } catch (jsonError) {
          console.warn(`Failed to parse JSON from ${url}:`, jsonError);
          continue; // Try next URL
        }

        const geometry = getGeometryFromResponse(json);
        if (geometry) {
          zoneGeometryCache[ugc] = geometry;
          return geometry;
        }
      } catch (networkError) {
        console.warn(`Network error fetching ${url}:`, networkError);
        // try next
      }
    }
    return null;
  }

  window.fetchZoneGeometry = async function(ugc) {
    if (!ugc) return null;
    // Ensure UGC is uppercase and trimmed
    ugc = String(ugc).trim().toUpperCase();

    // Check cache first
    if (zoneGeometryCache[ugc]) {
      return zoneGeometryCache[ugc];
    }

    // If a fetch for this UGC is already running, reuse it instead of firing
    // a duplicate request. Multiple alerts frequently share the same zone,
    // and previously each one raced in before the first fetch finished and
    // populated the cache, so every caller kicked off its own network
    // request and ate one of the 10 concurrent request slots — starving
    // everything else waiting in the queue.
    if (zoneGeometryInFlight[ugc]) {
      return zoneGeometryInFlight[ugc];
    }

    const promise = fetchZoneGeometryUncached(ugc).finally(() => {
      delete zoneGeometryInFlight[ugc];
    });
    zoneGeometryInFlight[ugc] = promise;
    return promise;
  };

  window.extractAlertUGCs = function(props) {
    if (!props) return [];
    const ugcs = new Set();

    const normalizeZoneCode = (value) => {
      if (!value) return null;
      const cleaned = String(value).trim().toUpperCase();
      const match = cleaned.match(/[A-Z]{2}[A-Z0-9]{1,3}\d{3}/);
      if (match) return match[0];
      const fallback = cleaned.match(/[A-Z0-9]{3,6}/);
      return fallback ? fallback[0] : null;
    };

    const addCodes = (item) => {
      if (!item) return;
      if (Array.isArray(item)) {
        for (const v of item) addCodes(v);
        return;
      }
      const parts = String(item).split(/[\s,;\/|]+/);
      for (const p of parts) {
        const code = normalizeZoneCode(p);
        if (code) ugcs.add(code);
      }
    };

    // affectedZones: array of resource URLs — last path segment is the zone id
    if (Array.isArray(props.affectedZones)) {
      for (const url of props.affectedZones) {
        try {
          const path = String(url).split('?')[0].split('#')[0];
          const parts = path.split('/').filter(Boolean);
          const id = parts.length ? parts[parts.length - 1] : null;
          const code = normalizeZoneCode(id);
          if (code) ugcs.add(code);
        } catch (e) { /* ignore */ }
      }
    }

    // parameters.UGC sometimes contains codes (array or joined string)
    try {
      const p = props.parameters || {};
      if (p.UGC) addCodes(p.UGC);
    } catch (e) { /* ignore */ }

    // geocode.UGC is commonly used in NWS alert payloads
    try {
      const g = props.geocode || {};
      if (g && g.UGC) addCodes(g.UGC);
    } catch (e) { /* ignore */ }

    // fallback top-level properties
    try {
      if (props.UGC) addCodes(props.UGC);
      if (props.ugc) addCodes(props.ugc);
    } catch (e) { /* ignore */ }

    return Array.from(ugcs);
  };
})();
