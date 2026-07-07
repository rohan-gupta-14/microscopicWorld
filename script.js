/**
 * ============================================
 *  MICROBIAL WORLD EXPLORER
 *  Interactive Museum Exhibit — Main Script
 * ============================================
 *
 *  Architecture:
 *    - DataManager:     Loads & queries microorganism JSON data
 *    - MapManager:      Handles map rendering & coordinate conversion
 *    - LensManager:     Microscope lens creation, movement, interactions
 *    - ParticleSystem:  Ambient floating particle animation
 *    - AudioManager:    Web Audio API sound effects
 *    - AppController:   Orchestrates all managers, handles events
 */

'use strict';

/* ============================================= */
/*  CONFIGURATION                                */
/* ============================================= */
const CONFIG = {
  /** Path to the microorganism data file */
  dataPath: 'data/microbes.json',

  /** Equirectangular map projection bounds */
  map: {
    lonMin: -180,
    lonMax: 180,
    latMin: 90,   // top of map
    latMax: -90,  // bottom of map
  },

  /** Lens behavior */
  lens: {
    /** Number of touch points required to activate a physical lens marker */
    touchFingers: 4,
    /** Grace period before hiding media when a ring is fully lifted (handles touch jitter) */
    mediaReleaseGraceMs: 0,
    /** Grace period before hiding media when a ring drags off a microbe spot */
    pointReleaseGraceMs: 80,
    /** Distance (in degrees) within which a microbe is considered "found" */
    discoveryThreshold: 6,
    /** How long (ms) the lens must hover before triggering no-result toast */
    noResultDelay: 1200,
    /** Extra hit area around a virtual lens so dragging feels forgiving */
    virtualHitPaddingPx: 28,
    /** Offset used when adding another virtual lens */
    virtualSpawnOffsetPx: 56,
  },

  display: {
    diagonalInches: 85,
    aspectWidth: 16,
    aspectHeight: 9,
  },

  media: {
    /** Physical diameter of the microorganism video circle on the 85" panel */
    videoDiameterCm: 17.5,
  },

  /**
   * Physical ring validation — only accept touch groups that match the
   * circular lens device (4 points, 12-15 cm diameter, evenly spaced).
   * Prevents random finger touches from forming a lens.
   */
  ring: {
    /**
     * Shape-only validation — no pixel/cm calibration needed.
     * The ring is identified purely by the geometry of its 4 touch points:
     *   1. All 4 points roughly equidistant from their centroid (circle shape)
     *   2. Adjacent points roughly 90° apart (even spacing)
     * This works on any screen size or pixel density without any tuning.
     */

    /** Max fractional deviation from the mean radius (0 = perfect, 0.45 = 45% tolerance) */
    circularityTolerance: 0.65,

    /** Max degrees each adjacent-point gap may deviate from the ideal 90° spacing */
    angularTolerance: 75,
    /** How different the two opposite/parallel distances may be */
    oppositePairTolerance: 0.25,

    /** Required physical distance between opposite/parallel touch pairs */
    /** Calibrated for a NovoTouch 85" 16:9 panel using the fullscreen viewport */
    diameterMinCm: 14,
    diameterMaxCm: 19,

    /** Minimum radius in px — rejects all 4 touches clustered in a tiny spot (e.g. fat-finger) */
    minRadiusPx: 40,
  },

  /** Particle system */
  particles: {
    count: 60,
    speedMin: 0.15,
    speedMax: 0.5,
    sizeMin: 1,
    sizeMax: 3,
    color: 'rgba(0, 212, 255, 0.25)',
  },

  /** Audio */
  audio: {
    enabled: true,
    discoveryFreq: 520,
    discoveryDuration: 0.6,
    noResultFreq: 280,
    noResultDuration: 0.3,
  },

};

/* ============================================= */
/*  CIRCLE GEOMETRY UTILITIES                    */
/* ============================================= */

function _groupKey(ids) {
  return [...ids].sort((a, b) => a - b).join(',');
}

function _touchDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function _displaySizeCm() {
  const diagonalCm = CONFIG.display.diagonalInches * 2.54;
  const aspectHyp = Math.hypot(CONFIG.display.aspectWidth, CONFIG.display.aspectHeight);

  return {
    width: diagonalCm * CONFIG.display.aspectWidth / aspectHyp,
    height: diagonalCm * CONFIG.display.aspectHeight / aspectHyp,
  };
}

function _touchDistanceCm(a, b) {
  const display = _displaySizeCm();
  const pxPerCmX = window.innerWidth / display.width;
  const pxPerCmY = window.innerHeight / display.height;
  const dxCm = (a.x - b.x) / pxPerCmX;
  const dyCm = (a.y - b.y) / pxPerCmY;

  return Math.hypot(dxCm, dyCm);
}

function _cmToCssPx(cm) {
  const display = _displaySizeCm();
  const pxPerCmX = window.innerWidth / display.width;
  const pxPerCmY = window.innerHeight / display.height;

  return cm * ((pxPerCmX + pxPerCmY) / 2);
}

function _quadMetrics(activeTouches, ids) {
  const points = ids.map(id => activeTouches.get(id));
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let maxPairDistance = 0;

  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      maxPairDistance = Math.max(maxPairDistance, _touchDistance(points[i], points[j]));
    }
  }

  return {
    cx,
    cy,
    radius: Math.max(80, maxPairDistance / 2),
  };
}

function _findValidRingIds(activeTouches, candidateIds, requiredId = null) {
  const ids = [...candidateIds].sort((a, b) => a - b);
  let best = null;

  for (let a = 0; a < ids.length - 3; a++) {
    for (let b = a + 1; b < ids.length - 2; b++) {
      for (let c = b + 1; c < ids.length - 1; c++) {
        for (let d = c + 1; d < ids.length; d++) {
          const quad = [ids[a], ids[b], ids[c], ids[d]];
          if (requiredId !== null && !quad.includes(requiredId)) continue;
          if (!_isValidRing(activeTouches, quad)) continue;

          const metrics = _quadMetrics(activeTouches, quad);
          const score = metrics.radius;
          if (!best || score < best.score) best = { ids: quad, score };
        }
      }
    }
  }

  return best?.ids ?? null;
}

/**
 * Partition active touches into one lens per complete 4-touch group.
 * Extra touches wait until they complete another group of four.
 */
function _findCircleGroups(activeTouches, existingGroups = new Map()) {
  const ids = [...activeTouches.keys()].sort((a, b) => a - b);
  const count = CONFIG.lens.touchFingers;
  const used = new Set();
  const groups = [];

  if (ids.length < count) return groups;

  for (const [key, state] of existingGroups) {
    const touchIds = state.touchIds || [];
    if (touchIds.length !== count) continue;
    if (!touchIds.every(id => activeTouches.has(id))) continue;
    if (!_isValidRing(activeTouches, touchIds)) continue;

    touchIds.forEach(id => used.add(id));
    const metrics = _quadMetrics(activeTouches, touchIds);
    groups.push({
      key,
      ids: touchIds,
      cx: metrics.cx,
      cy: metrics.cy,
      r: metrics.radius,
    });
  }

  // Use spatial nearest-neighbour clustering so that when two rings land
  // simultaneously their interleaved touch IDs are assigned to the correct
  // physical ring rather than merged into one large circle.
  const ungrouped = new Set(ids.filter(id => !used.has(id)));

  while (ungrouped.size >= count) {
    // Seed with the lowest remaining touch ID
    const seed   = [...ungrouped].sort((a, b) => a - b)[0];
    const seedPt = activeTouches.get(seed);

    // Limit the search to touches physically near the seed. This prevents a
    // valid lens from consuming touch points that belong to another lens.
    const nearby = [...ungrouped]
      .filter(id => id !== seed)
      .map(id => ({
        id,
        d: Math.hypot(activeTouches.get(id).x - seedPt.x, activeTouches.get(id).y - seedPt.y),
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, Math.min(7, ungrouped.size - 1))
      .map(c => c.id);

    const candidatePool = [seed, ...nearby];
    if (candidatePool.length < count) break;

    const quad = _findValidRingIds(activeTouches, candidatePool, seed);
    if (quad) {
      const metrics = _quadMetrics(activeTouches, quad);
      groups.push({
        key: _groupKey(quad),
        ids: quad,
        cx: metrics.cx,
        cy: metrics.cy,
        r: metrics.radius,
      });
      quad.forEach(id => ungrouped.delete(id));
    } else {
      // Seed's nearest neighbours don't form a valid ring; discard seed and retry
      ungrouped.delete(seed);
    }
  }

  return groups;
}

/**
 * Returns true only when the 4 touch points match the physical ring device:
 *   • diameter within CONFIG.ring.diameterCm range
 *   • all points roughly equidistant from the centroid (circularity check)
 *   • adjacent angular gaps are each close to 90° (even spacing check)
 *
 * This rejects random human finger touches, which are never arranged as a
 * precise 12-15 cm diameter circle with four evenly-spaced contact points.
 *
 * @param {Map<number,{x:number,y:number}>} activeTouches
 * @param {number[]} ids - exactly 4 touch identifiers
 * @returns {boolean}
 */
function _isValidRing(activeTouches, ids) {
  if (ids.length !== 4) return false;

  const pts = ids.map(id => activeTouches.get(id));
  const cx  = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy  = pts.reduce((s, p) => s + p.y, 0) / 4;

  const radii = pts.map(p => Math.hypot(p.x - cx, p.y - cy));
  const avgR  = radii.reduce((s, r) => s + r, 0) / 4;

  // 1. Reject touches all clustered in one tiny spot (e.g. four fingers bunched together)
  if (avgR < CONFIG.ring.minRadiusPx) return false;

  // 2. All four points must be roughly equidistant from the centre (circular shape)
  const maxDev = Math.max(...radii.map(r => Math.abs(r - avgR) / avgR));
  if (maxDev > CONFIG.ring.circularityTolerance) return false;

  // 3. Adjacent angular gaps must each be close to 90° (evenly spaced around circle)
  const angles = pts
    .map(p => Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI)
    .sort((a, b) => a - b);
  const gaps = [
    angles[1] - angles[0],
    angles[2] - angles[1],
    angles[3] - angles[2],
    360 + angles[0] - angles[3],
  ];
  if (!gaps.every(g => Math.abs(g - 90) <= CONFIG.ring.angularTolerance)) return false;

  const pairings = [
    [[0, 1], [2, 3]],
    [[0, 2], [1, 3]],
    [[0, 3], [1, 2]],
  ];

  const bestOppositePair = pairings
    .map(pairing => {
      const distances = pairing.map(([a, b]) => _touchDistanceCm(pts[a], pts[b]));
      return {
        distances,
        avg: (distances[0] + distances[1]) / 2,
        spread: Math.abs(distances[0] - distances[1]),
      };
    })
    .sort((a, b) => b.avg - a.avg)[0];

  const withinDiameter = bestOppositePair.distances.every(d =>
    d >= CONFIG.ring.diameterMinCm && d <= CONFIG.ring.diameterMaxCm
  );
  const similarOpposites =
    bestOppositePair.spread / bestOppositePair.avg <= CONFIG.ring.oppositePairTolerance;

  return withinDiameter && similarOpposites;
}

/* ============================================= */
/*  DATA MANAGER                                 */
/* ============================================= */
class DataManager {
  constructor() {
    this.microbes = [];
    this.discovered = new Set();
  }

  /**
   * Load microorganism data from JSON file.
   * @returns {Promise<Array>} Array of microbe objects
   */
  async load() {
    try {
      const response = await fetch(CONFIG.dataPath);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.microbes = await response.json();
      console.log(`[DataManager] Loaded ${this.microbes.length} microorganisms`);
      return this.microbes;
    } catch (err) {
      console.error('[DataManager] Failed to load data:', err);
      return [];
    }
  }

  /**
   * Find the nearest microbe to a given lat/lng position.
   * Returns null if none within the discovery threshold.
   * @param {number} lat - Latitude
   * @param {number} lng - Longitude
   * @returns {Object|null} The found microbe or null
   */
  findNearby(lat, lng) {
    let closest = null;
    let closestDist = Infinity;

    for (const microbe of this.microbes) {
      const dist = this._haversineApprox(lat, lng, microbe.latitude, microbe.longitude);
      if (dist < closestDist) {
        closestDist = dist;
        closest = microbe;
      }
    }

    if (closestDist <= CONFIG.lens.discoveryThreshold) {
      return closest;
    }
    return null;
  }

  /**
   * Mark a microbe as discovered.
   * @param {string} id - Microbe ID
   * @returns {boolean} True if newly discovered
   */
  markDiscovered(id) {
    if (this.discovered.has(id)) return false;
    this.discovered.add(id);
    return true;
  }

  /**
   * Simple distance approximation in degrees.
   * Good enough for our purposes on an equirectangular map.
   */
  _haversineApprox(lat1, lng1, lat2, lng2) {
    const dLat = lat2 - lat1;
    const dLng = (lng2 - lng1) * Math.cos((lat1 * Math.PI) / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }
}

/* ============================================= */
/*  MAP MANAGER                                  */
/* ============================================= */
class MapManager {
  constructor() {
    this.mapEl = document.getElementById('world-map');
    this.mapImg = document.getElementById('map-image');
    this.markersEl = document.getElementById('habitat-markers');
    this._rect = null;
  }

  /**
   * Initialize the map: wait for image load, create markers.
   * @param {Array} microbes
   */
  init(microbes) {
    // Fade in the map image when loaded
    if (this.mapImg.complete) {
      this.mapImg.classList.add('loaded');
    } else {
      this.mapImg.addEventListener('load', () => {
        this.mapImg.classList.add('loaded');
      });
    }

    // Cache bounding rect
    this._updateRect();
    window.addEventListener('resize', () => this._updateRect());

    // Create habitat markers
    this._createMarkers(microbes);
  }

  /**
   * Convert screen coordinates (relative to viewport) to lat/lng.
   * Uses equirectangular projection math.
   * @param {number} screenX
   * @param {number} screenY
   * @returns {{lat: number, lng: number}}
   */
  screenToLatLng(screenX, screenY) {
    this._updateRect();
    const rect = this._rect;

    // Normalise to 0..1 within the map bounds
    const normX = (screenX - rect.left) / rect.width;
    const normY = (screenY - rect.top) / rect.height;

    const lng = CONFIG.map.lonMin + normX * (CONFIG.map.lonMax - CONFIG.map.lonMin);
    const lat = CONFIG.map.latMin + normY * (CONFIG.map.latMax - CONFIG.map.latMin);

    return { lat, lng };
  }

  /**
   * Convert lat/lng to screen coordinates.
   * @param {number} lat
   * @param {number} lng
   * @returns {{x: number, y: number}}
   */
  latLngToScreen(lat, lng) {
    this._updateRect();
    const rect = this._rect;

    const normX = (lng - CONFIG.map.lonMin) / (CONFIG.map.lonMax - CONFIG.map.lonMin);
    const normY = (lat - CONFIG.map.latMin) / (CONFIG.map.latMax - CONFIG.map.latMin);

    return {
      x: rect.left + normX * rect.width,
      y: rect.top + normY * rect.height,
    };
  }

  /**
   * Mark a habitat marker as discovered.
   * @param {string} id - Microbe ID
   */
  markDiscovered(id) {
    const marker = this.markersEl.querySelector(`[data-microbe-id="${id}"]`);
    if (marker) marker.classList.add('discovered');
  }

  /** Update cached bounding rectangle */
  _updateRect() {
    this._rect = this.mapEl.getBoundingClientRect();
  }

  /** Create small dot markers for each microbe location */
  _createMarkers(microbes) {
    this.markersEl.innerHTML = '';
    for (const m of microbes) {
      const marker = document.createElement('div');
      marker.className = 'habitat-marker';
      marker.dataset.microbeId = m.id;

      // Position using percentage (equirectangular)
      const percX = ((m.longitude - CONFIG.map.lonMin) / (CONFIG.map.lonMax - CONFIG.map.lonMin)) * 100;
      const percY = ((m.latitude - CONFIG.map.latMin) / (CONFIG.map.latMax - CONFIG.map.latMin)) * 100;
      marker.style.left = `${percX}%`;
      marker.style.top = `${percY}%`;

      this.markersEl.appendChild(marker);
    }
  }
}

/* ============================================= */
/*  LENS MANAGER                                 */
/* ============================================= */
class LensManager {
  constructor() {
    this.lensEl = document.getElementById('microscope-lens');
    this.labelLat = document.getElementById('lens-lat');
    this.labelLng = document.getElementById('lens-lng');
    this.highlightEl = document.getElementById('habitat-highlight');
    this.isActive = false;
    this._currentMicrobe = null;
  }

  /**
   * Show the microscope lens at the given screen position.
   * @param {number} x
   * @param {number} y
   */
  show(x, y) {
    this.lensEl.style.left = `${x}px`;
    this.lensEl.style.top = `${y}px`;
    this.lensEl.classList.remove('hidden');
    this.lensEl.classList.add('visible');
    this.isActive = true;
  }

  /**
   * Move the lens to a new position.
   * @param {number} x
   * @param {number} y
   */
  moveTo(x, y) {
    this.lensEl.style.left = `${x}px`;
    this.lensEl.style.top = `${y}px`;
  }

  /** Hide the microscope lens */
  hide() {
    this.lensEl.classList.remove('visible', 'discovered', 'active');
    this.lensEl.classList.add('hidden');
    this.isActive = false;
    this._currentMicrobe = null;
    this.hideHighlight();
  }

  /**
   * Update the coordinate display on the lens.
   * @param {number} lat
   * @param {number} lng
   */
  updateCoords(lat, lng) {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lngDir = lng >= 0 ? 'E' : 'W';
    this.labelLat.textContent = `${Math.abs(lat).toFixed(1)}° ${latDir}`;
    this.labelLng.textContent = `${Math.abs(lng).toFixed(1)}° ${lngDir}`;
  }

  /**
   * Set the lens into "discovered" visual state.
   * @param {Object} microbe
   */
  setDiscovered(microbe) {
    if (this._currentMicrobe?.id === microbe.id) return; // already showing
    this._currentMicrobe = microbe;
    this.lensEl.classList.add('discovered');
    this.lensEl.classList.remove('active');
  }

  /** Reset lens to normal state */
  clearDiscovered() {
    this._currentMicrobe = null;
    this.lensEl.classList.remove('discovered');
  }

  /**
   * Show the pulsing highlight at a given screen position.
   * @param {number} x
   * @param {number} y
   */
  showHighlight(x, y) {
    this.highlightEl.style.left = `${x}px`;
    this.highlightEl.style.top = `${y}px`;
    this.highlightEl.classList.remove('hidden');
    this.highlightEl.classList.add('visible');
  }

  /** Hide the habitat highlight */
  hideHighlight() {
    this.highlightEl.classList.remove('visible');
    this.highlightEl.classList.add('hidden');
  }

  /** @returns {Object|null} Currently highlighted microbe */
  get currentMicrobe() {
    return this._currentMicrobe;
  }
}

/* ============================================= */
/*  PARTICLE SYSTEM                              */
/* ============================================= */
class ParticleSystem {
  constructor() {
    this.canvas = document.getElementById('particle-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this._animFrame = null;
  }

  /** Initialize and start the particle animation */
  init() {
    this._resize();
    this._createParticles();
    this._animate();
    window.addEventListener('resize', () => this._resize());
  }

  /** Stop the animation */
  destroy() {
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
  }

  _resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  _createParticles() {
    this.particles = [];
    const { count, speedMin, speedMax, sizeMin, sizeMax } = CONFIG.particles;

    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: Math.random() * this.canvas.width,
        y: Math.random() * this.canvas.height,
        size: sizeMin + Math.random() * (sizeMax - sizeMin),
        speedX: (Math.random() - 0.5) * (speedMax - speedMin) + speedMin * (Math.random() > 0.5 ? 1 : -1),
        speedY: (Math.random() - 0.5) * (speedMax - speedMin) + speedMin * (Math.random() > 0.5 ? 1 : -1),
        opacity: 0.1 + Math.random() * 0.3,
        pulseSpeed: 0.005 + Math.random() * 0.015,
        pulsePhase: Math.random() * Math.PI * 2,
      });
    }
  }

  _animate() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const w = this.canvas.width;
    const h = this.canvas.height;

    for (const p of this.particles) {
      // Move
      p.x += p.speedX;
      p.y += p.speedY;

      // Wrap around edges
      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      if (p.y < -10) p.y = h + 10;
      if (p.y > h + 10) p.y = -10;

      // Pulsing opacity
      p.pulsePhase += p.pulseSpeed;
      const pulsedOpacity = p.opacity * (0.5 + 0.5 * Math.sin(p.pulsePhase));

      // Draw
      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(0, 212, 255, ${pulsedOpacity})`;
      this.ctx.fill();

      // Soft glow
      if (p.size > 2) {
        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2);
        this.ctx.fillStyle = `rgba(0, 212, 255, ${pulsedOpacity * 0.1})`;
        this.ctx.fill();
      }
    }

    this._animFrame = requestAnimationFrame(() => this._animate());
  }
}

/* ============================================= */
/*  AUDIO MANAGER                                */
/* ============================================= */
class AudioManager {
  constructor() {
    this._ctx = null;
    this._initialized = false;
  }

  /**
   * Initialize the Web Audio context.
   * Must be called from a user gesture event.
   */
  init() {
    if (this._initialized) return;
    try {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._initialized = true;
      console.log('[AudioManager] Initialized');
    } catch (e) {
      console.warn('[AudioManager] Web Audio not available:', e);
      CONFIG.audio.enabled = false;
    }
  }

  /** Play a soft discovery chime */
  playDiscovery() {
    if (!CONFIG.audio.enabled || !this._ctx) return;
    this._playTone(CONFIG.audio.discoveryFreq, CONFIG.audio.discoveryDuration, 'sine', 0.08);
    // Second harmonic for richness
    setTimeout(() => {
      this._playTone(CONFIG.audio.discoveryFreq * 1.5, 0.4, 'sine', 0.04);
    }, 100);
    // Third note
    setTimeout(() => {
      this._playTone(CONFIG.audio.discoveryFreq * 2, 0.3, 'sine', 0.025);
    }, 200);
  }

  /** Play a subtle no-result sound */
  playNoResult() {
    if (!CONFIG.audio.enabled || !this._ctx) return;
    this._playTone(CONFIG.audio.noResultFreq, CONFIG.audio.noResultDuration, 'triangle', 0.04);
  }

  /**
   * Play a simple tone.
   * @param {number} freq - Frequency in Hz
   * @param {number} duration - Duration in seconds
   * @param {string} type - Oscillator type
   * @param {number} volume - Gain (0..1)
   */
  _playTone(freq, duration, type, volume) {
    const ctx = this._ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  }
}

/* ============================================= */
/*  CIRCLE RENDERER — One circle per ring group  */
/* ============================================= */
class CircleRenderer {
  static COLORS = ['#00d4ff', '#ff6b9d', '#ffd93d', '#6bcb77', '#b36bff'];

  constructor() {
    this.canvas = document.getElementById('circle-canvas');
    this.ctx    = this.canvas.getContext('2d');
    this._groups   = new Map(); // groupKey → {cx, cy, r, color, phase}
    this._colorMap = new Map(); // groupKey → color (stable across moves)
    this._nextColor = 0;
    this._raf = null;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  setGroup(key, cx, cy, r) {
    if (this._groups.has(key)) {
      const g = this._groups.get(key);
      g.cx = cx; g.cy = cy; g.r = r;
    } else {
      if (!this._colorMap.has(key)) {
        this._colorMap.set(key, CircleRenderer.COLORS[this._nextColor++ % CircleRenderer.COLORS.length]);
      }
      this._groups.set(key, { cx, cy, r, color: this._colorMap.get(key), phase: Math.random() * Math.PI * 2 });
      if (!this._raf) this._loop();
    }
  }

  removeGroup(key) {
    this._groups.delete(key);
    this._colorMap.delete(key);
    if (this._groups.size === 0) {
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  clearGroups() {
    this._groups.clear();
    this._colorMap.clear();
    this._nextColor = 0;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  getColor(key) { return this._groups.get(key)?.color ?? '#00d4ff'; }

  _loop() {
    this._raf = requestAnimationFrame(() => {
      this._draw();
      if (this._groups.size > 0) this._loop(); else this._raf = null;
    });
  }

  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const g of this._groups.values()) {
      g.phase += 0.04;
      const { cx, cy, r, color, phase } = g;
      const pulse = Math.sin(phase) * 0.08 + 0.92;

      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.35);
      glow.addColorStop(0, color + '18');
      glow.addColorStop(0.48, color + '0d');
      glow.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.35 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      const glass = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.3, r * 0.08, cx, cy, r);
      glass.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
      glass.addColorStop(0.42, color + '10');
      glass.addColorStop(0.78, 'rgba(255, 255, 255, 0.04)');
      glass.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = glass;
      ctx.fill();
    }
  }
}

/* ============================================= */
/*  LAYOUT EDITOR                                */
/* ============================================= */
class LayoutEditor {
  static CARD_STORAGE_KEY = 'microbial_card_layout';
  static CARD_BACKUP_KEY  = 'microbial_card_layout_backup';

  /* ---------------------------------------------------------------------
   *  DEFAULT CARD LAYOUT  (baked into the code — the "factory" positions)
   * ---------------------------------------------------------------------
   *  These positions are used whenever a browser/kiosk has NO saved layout
   *  in localStorage (fresh machine, cleared storage, different browser).
   *  They guarantee the cards always start in the intended arrangement and
   *  never fall back to auto-computed positions.
   *
   *  Priority order when placing a card:
   *     1. localStorage (set via the Layout Editor → "Save Layout")
   *     2. DEFAULT_CARD_LAYOUT below
   *     3. auto-computed fallback (only if a microbe is missing from both)
   *
   *  HOW TO UPDATE (admin):
   *     Open the Layout Editor (Ctrl + →), arrange the cards, click
   *     "Save Layout". That writes to localStorage. To make it the permanent
   *     factory default on every machine, copy the saved JSON and paste it
   *     here. Get the JSON by running this in the browser console (F12):
   *         copy(localStorage.getItem('microbial_card_layout'))
   *     then paste the object below (keys are microbe ids from microbes.json).
   *
   *  Each entry: { x, y, width, rotation }  (pixels / degrees, top-left anchor)
   * ------------------------------------------------------------------- */
  static DEFAULT_CARD_LAYOUT = {
    'thermus-aquaticus':             { x: 48,   y: 8,   width: 235, rotation: 180 },
    'colwellia-psychrerythraea':     { x: 790,  y: 8,   width: 245, rotation: 180 },
    'deinococcus-radiodurans':       { x: 1227, y: 85,  width: 178, rotation: 180 },
    'acidithiobacillus-ferrooxidans':{ x: 1615, y: 68,  width: 215, rotation: 180 },
    'pyrolobus-fumarii':             { x: 200,  y: 415, width: 220, rotation: 180 },
    'chroococcidiopsis':             { x: 697,  y: 672, width: 205, rotation: 0   },
    'halomonas-campisalis':          { x: 1268, y: 505, width: 200, rotation: 0   },
    'halobacterium-salinarum':       { x: 1648, y: 843, width: 200, rotation: 270 },
  };

  constructor(dataManager, mapManager) {
    this._data          = dataManager;
    this._map           = mapManager;
    this._items         = new Map(); // microbeId → { el, x, y, width, rotation }
    this._videoPreviews = [];        // background video circles (read-only reference)
    this._overlay       = null;
    this._active        = false;
  }

  get isOpen() { return this._active; }

  loadCardLayout() {
    try {
      const raw = localStorage.getItem(LayoutEditor.CARD_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  getSavedCard(id) {
    // Priority: saved (localStorage) → baked-in default → null (auto-compute)
    const saved = this.loadCardLayout();
    if (saved && Object.prototype.hasOwnProperty.call(saved, id)) return saved[id];
    return LayoutEditor.DEFAULT_CARD_LAYOUT[id] ?? null;
  }

  open() {
    if (this._active || !this._data.microbes.length) return;
    this._active = true;

    const hasBackup = !!localStorage.getItem(LayoutEditor.CARD_BACKUP_KEY);

    const overlay = document.createElement('div');
    overlay.id = 'layout-editor';
    overlay.innerHTML =
      '<div id="le-backdrop"></div>' +
      '<div id="le-toolbar">' +
        '<span id="le-title">Panel Layout Editor</span>' +
        '<p id="le-hint">Drag to move · Right-edge handle to resize · Yellow handle to rotate</p>' +
        '<div id="le-actions">' +
          '<button id="le-undo"' + (hasBackup ? '' : ' disabled') + '>↩ Undo Last Save</button>' +
          '<button id="le-save">Save Layout</button>' +
          '<button id="le-discard">Discard (ESC)</button>' +
        '</div>' +
      '</div>';
    document.getElementById('app-container').appendChild(overlay);
    this._overlay = overlay;

    const saved        = this.loadCardLayout();
    const defaultWidth = 175;

    for (const [i, m] of this._data.microbes.entries()) {
      const color     = CircleRenderer.COLORS[i % CircleRenderer.COLORS.length];
      const screenPos = this._map.latLngToScreen(m.latitude, m.longitude);

      // Non-interactive video circle at map position (reference only)
      this._videoPreviews.push(this._buildVideoPreview(m, screenPos.x, screenPos.y, color));

      // Draggable card item — saved layout wins, then baked-in default, then auto-compute
      const s        = saved[m.id] ?? LayoutEditor.DEFAULT_CARD_LAYOUT[m.id];
      const x        = s?.x        ?? Math.max(8, screenPos.x - defaultWidth / 2);
      const y        = s?.y        ?? Math.max(64, Math.min(screenPos.y - 110, window.innerHeight - 220));
      const width    = s?.width    ?? defaultWidth;
      const rotation = s?.rotation ?? 0;
      const el = this._buildItem(m, x, y, width, rotation, color);
      this._items.set(m.id, { el, x, y, width, rotation });
    }

    overlay.querySelector('#le-undo').addEventListener('click',    () => this._doUndo());
    overlay.querySelector('#le-save').addEventListener('click',    () => this._doSave());
    overlay.querySelector('#le-discard').addEventListener('click', () => this.close());

    requestAnimationFrame(() => overlay.classList.add('visible'));
  }

  _doSave() {
    // Backup the current saved layout before overwriting
    const currentRaw = localStorage.getItem(LayoutEditor.CARD_STORAGE_KEY);
    if (currentRaw) {
      try { localStorage.setItem(LayoutEditor.CARD_BACKUP_KEY, currentRaw); } catch (_) {}
    }
    // Write new layout from editor state
    const layout = {};
    for (const [id, state] of this._items) {
      layout[id] = { x: Math.round(state.x), y: Math.round(state.y), width: Math.round(state.width), rotation: Math.round(state.rotation) };
    }
    const json = JSON.stringify(layout);
    try { localStorage.setItem(LayoutEditor.CARD_STORAGE_KEY, json); }
    catch (e) { console.warn('[LayoutEditor] Save failed:', e); }

    // Convenience for the admin: log + copy the JSON so it can be pasted into
    // LayoutEditor.DEFAULT_CARD_LAYOUT to make it the permanent factory default.
    console.log('[LayoutEditor] Saved layout (paste into DEFAULT_CARD_LAYOUT to bake in):\n' + JSON.stringify(layout, null, 2));
    try { navigator.clipboard?.writeText(json); } catch (_) {}

    this.close();
  }

  _doUndo() {
    const raw = localStorage.getItem(LayoutEditor.CARD_BACKUP_KEY);
    if (!raw) return;
    let backup;
    try { backup = JSON.parse(raw); } catch { return; }

    // Restore backup positions into the currently open editor items
    for (const [id, state] of this._items) {
      const s = backup[id];
      if (!s) continue;
      state.x        = s.x;
      state.y        = s.y;
      state.width    = s.width    ?? 175;
      state.rotation = s.rotation ?? 0;
      state.el.style.left      = `${state.x}px`;
      state.el.style.top       = `${state.y}px`;
      state.el.style.width     = `${state.width}px`;
      state.el.style.transform = `rotate(${state.rotation}deg)`;
    }

    // Clear backup so undo can only go back one step
    try { localStorage.removeItem(LayoutEditor.CARD_BACKUP_KEY); } catch (_) {}
    const btn = this._overlay?.querySelector('#le-undo');
    if (btn) btn.disabled = true;
  }

  close() {
    if (!this._active) return;
    this._active = false;
    for (const [, state] of this._items) state.el.remove();
    this._items.clear();
    for (const wrap of this._videoPreviews) {
      const v = wrap.querySelector('video');
      if (v) { v.pause(); v.src = ''; }
      wrap.remove();
    }
    this._videoPreviews = [];
    if (this._overlay) {
      this._overlay.classList.remove('visible');
      const el = this._overlay;
      this._overlay = null;
      setTimeout(() => el.remove(), 280);
    }
  }

  _buildVideoPreview(microbe, cx, cy, color) {
    const size = _cmToCssPx(CONFIG.media.videoDiameterCm);
    const wrap = document.createElement('div');
    wrap.className = 'le-video-preview';
    wrap.style.left   = `${cx}px`;
    wrap.style.top    = `${cy}px`;
    wrap.style.width  = `${size}px`;
    wrap.style.height = `${size}px`;
    wrap.style.boxShadow = `0 0 28px ${color}44, inset 0 0 20px rgba(0,0,0,0.4)`;

    const video = document.createElement('video');
    video.src         = `assets/microbes/videos/${microbe.id}.mp4`;
    video.muted       = true;
    video.loop        = true;
    video.playsInline = true;
    video.autoplay    = true;
    video.play().catch(() => {});

    const vig = document.createElement('div');
    vig.className = 'le-video-vignette';

    wrap.appendChild(video);
    wrap.appendChild(vig);
    document.getElementById('app-container').appendChild(wrap);
    return wrap;
  }

  _buildItem(microbe, x, y, width, rotation, color) {
    const item = document.createElement('div');
    item.className  = 'le-item le-card-item';
    item.dataset.id = microbe.id;
    item.style.left      = `${x}px`;
    item.style.top       = `${y}px`;
    item.style.width     = `${width}px`;
    item.style.transform = `rotate(${rotation}deg)`;

    // Card content preview — matches .circle-card markup/styles
    const preview = document.createElement('div');
    preview.className = 'le-card-preview';

    const badge = document.createElement('span');
    badge.className         = 'cc-badge';
    badge.textContent       = microbe.habitat;
    badge.style.color       = color;
    badge.style.borderColor = color + '66';

    const name = document.createElement('h3');
    name.className   = 'cc-name';
    name.textContent = microbe.name;

    const sci = document.createElement('p');
    sci.className   = 'cc-sci';
    sci.textContent = microbe.scientificName;

    const desc = document.createElement('p');
    desc.className = 'cc-desc';
    const words = microbe.description.split(/\s+/);
    desc.textContent = words.length > 25 ? words.slice(0, 25).join(' ') + '…' : microbe.description;

    const loc = document.createElement('p');
    loc.className   = 'cc-loc';
    loc.textContent = `${microbe.location}, ${microbe.country}`;

    preview.append(badge, name, sci, desc, loc);
    item.appendChild(preview);

    // Yellow rotation handle above card
    const rotHandle = document.createElement('div');
    rotHandle.className = 'le-handle le-rotate-handle';
    item.appendChild(rotHandle);

    // Right-edge handle for width resize
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'le-handle le-resize-right';
    item.appendChild(resizeHandle);

    document.getElementById('app-container').appendChild(item);
    this._bindDrag(item);
    this._bindRotate(item, rotHandle);
    this._bindResizeRight(item, resizeHandle);
    return item;
  }

  /* ---- Pointer helpers ---- */

  _xy(e) {
    return e.touches
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
      : { x: e.clientX,            y: e.clientY            };
  }

  _on(el, type, fn, opts)  { el.addEventListener(type, fn, opts); }
  _off(el, type, fn)        { el.removeEventListener(type, fn); }

  _bindDrag(item) {
    let sx, sy, ox, oy;

    const onDown = (e) => {
      if (e.target.classList.contains('le-handle')) return;
      e.stopPropagation(); e.preventDefault();
      const p = this._xy(e);
      sx = p.x; sy = p.y;
      const state = this._items.get(item.dataset.id);
      ox = state.x; oy = state.y;
      item.classList.add('le-dragging');
      this._on(document, 'mousemove', onMove);
      this._on(document, 'mouseup',   onUp);
      this._on(document, 'touchmove', onMove, { passive: false });
      this._on(document, 'touchend',  onUp);
    };

    const onMove = (e) => {
      if (e.cancelable) e.preventDefault();
      const p     = this._xy(e);
      const state = this._items.get(item.dataset.id);
      state.x = ox + (p.x - sx);
      state.y = oy + (p.y - sy);
      item.style.left = `${state.x}px`;
      item.style.top  = `${state.y}px`;
    };

    const onUp = () => {
      item.classList.remove('le-dragging');
      this._off(document, 'mousemove', onMove);
      this._off(document, 'mouseup',   onUp);
      this._off(document, 'touchmove', onMove);
      this._off(document, 'touchend',  onUp);
    };

    item.addEventListener('mousedown',  onDown);
    item.addEventListener('touchstart', onDown, { passive: false });
  }

  _bindRotate(item, handle) {
    const onDown = (e) => {
      e.stopPropagation(); e.preventDefault();
      const state = this._items.get(item.dataset.id);

      const onMove = (e) => {
        if (e.cancelable) e.preventDefault();
        const p    = this._xy(e);
        const rect = item.getBoundingClientRect();
        const cx   = (rect.left + rect.right)  / 2;
        const cy   = (rect.top  + rect.bottom) / 2;
        state.rotation = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90;
        item.style.transform = `rotate(${state.rotation}deg)`;
      };

      const onUp = () => {
        this._off(document, 'mousemove', onMove);
        this._off(document, 'mouseup',   onUp);
        this._off(document, 'touchmove', onMove);
        this._off(document, 'touchend',  onUp);
      };

      this._on(document, 'mousemove', onMove);
      this._on(document, 'mouseup',   onUp);
      this._on(document, 'touchmove', onMove, { passive: false });
      this._on(document, 'touchend',  onUp);
    };

    handle.addEventListener('mousedown',  onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
  }

  _bindResizeRight(item, handle) {
    const onDown = (e) => {
      e.stopPropagation(); e.preventDefault();
      const state      = this._items.get(item.dataset.id);
      const p0         = this._xy(e);
      const startWidth = state.width;

      const onMove = (e) => {
        if (e.cancelable) e.preventDefault();
        const p      = this._xy(e);
        state.width  = Math.max(120, startWidth + (p.x - p0.x));
        item.style.width = `${state.width}px`;
      };

      const onUp = () => {
        this._off(document, 'mousemove', onMove);
        this._off(document, 'mouseup',   onUp);
        this._off(document, 'touchmove', onMove);
        this._off(document, 'touchend',  onUp);
      };

      this._on(document, 'mousemove', onMove);
      this._on(document, 'mouseup',   onUp);
      this._on(document, 'touchmove', onMove, { passive: false });
      this._on(document, 'touchend',  onUp);
    };

    handle.addEventListener('mousedown',  onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
  }
}

/* ============================================= */
/*  APP CONTROLLER                               */
/* ============================================= */
class AppController {
  constructor() {
    this.data = new DataManager();
    this.map = new MapManager();
    this.lens = new LensManager();
    this.particles = new ParticleSystem();
    this.audio = new AudioManager();
    this.circle = new CircleRenderer();
    this.layoutEditor = new LayoutEditor(this.data, this.map);

    this._noResultTimeout = null;
    this._lastFoundMicrobe = null;
    this._isTouch = false;
    this._mouseActive = false;
    this._lastPos = { x: 0, y: 0 };
    this._aboutVisible = false;
    this._activeTouches    = new Map(); // touchId → {x, y}
    this._circleGroupState = new Map(); // groupKey → {touchIds, microbe, card}
    this._virtualLenses = new Map(); // groupKey -> {x, y, r}
    this._virtualLensSeq = 0;
    this._virtualDragKey = null;
    this._virtualTouchDrag = null;
    this._pointerPos = {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
      hasValue: false,
    };

    // Discovery counter
    this.counterEl = document.getElementById('discovery-count');
    this.titleOverlay = document.getElementById('title-overlay');
    this.noResultToast = document.getElementById('no-result-toast');
    this.virtualControls = document.getElementById('virtual-lens-controls');
    this.virtualAddBtn = document.getElementById('virtual-lens-add');
  }

  /** Boot the application */
  async init() {
    console.log('[App] Starting Microbial World Explorer...');

    // Load data
    const microbes = await this.data.load();
    if (microbes.length === 0) {
      console.error('[App] No microbe data available');
      return;
    }

    // Assign a stable color to each microbe by index
    this._microbeColors = new Map(
      microbes.map((m, i) => [m.id, CircleRenderer.COLORS[i % CircleRenderer.COLORS.length]])
    );

    // Initialize subsystems
    this.map.init(microbes);
    this.particles.init();

    // Bind input events
    this._bindEvents();
    this._prepareLoopingVideo(document.getElementById('circle-video'));

    console.log('[App] Ready!');
  }

  _getMicrobeVideoSrc(microbe) {
    return microbe.microorganismVideo || `assets/microbes/videos/${microbe.id}.mp4`;
  }

  _prepareLoopingVideo(video) {
    if (!video || video.dataset.loopGuardReady === 'true') return;

    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.dataset.loopGuardReady = 'true';

    const resumeIfActive = () => {
      if (video.dataset.keepPlaying !== 'true') return;
      const wrap = video.closest('#circle-image-wrap, .circle-img-wrap');
      if (wrap?.classList.contains('hidden')) return;
      if (video.ended) {
        try {
          video.currentTime = 0;
        } catch (_) {}
      }
      const playPromise = video.play();
      if (playPromise) playPromise.catch(() => {});
    };

    video.addEventListener('ended', resumeIfActive);
    video.addEventListener('pause', () => setTimeout(resumeIfActive, 60));
    video.addEventListener('stalled', () => setTimeout(resumeIfActive, 120));
  }

  _startVideoWatchdog(video) {
    if (!video || video._loopWatchdog) return;

    video._loopWatchdog = setInterval(() => {
      if (video.dataset.keepPlaying !== 'true') return;
      const wrap = video.closest('#circle-image-wrap, .circle-img-wrap');
      if (wrap?.classList.contains('hidden')) return;
      if (video.paused || video.ended) this._playVideo(video);
    }, 500);
  }

  _stopVideoWatchdog(video) {
    if (!video?._loopWatchdog) return;
    clearInterval(video._loopWatchdog);
    video._loopWatchdog = null;
  }

  _playVideo(video) {
    this._prepareLoopingVideo(video);
    video.dataset.keepPlaying = 'true';
    this._startVideoWatchdog(video);
    if (video.ended) {
      try {
        video.currentTime = 0;
      } catch (_) {}
    }
    const playPromise = video.play();
    if (playPromise) playPromise.catch(() => {});
  }

  _pauseVideo(video, reset = false) {
    if (!video) return;
    video.dataset.keepPlaying = 'false';
    this._stopVideoWatchdog(video);
    video.pause();
    if (reset && video.currentSrc) {
      try {
        video.currentTime = 0;
      } catch (_) {}
    }
  }

  /** Bind touch and mouse events */
  _bindEvents() {
    const container = document.getElementById('app-container');

    // ---- Touch events (primary interaction) ---- //
    container.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
    container.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
    container.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: false });
    container.addEventListener('touchcancel', (e) => this._onTouchEnd(e), { passive: false });

    // ---- Mouse events (desktop fallback) ---- //
    container.addEventListener('mousedown', (e) => this._onMouseDown(e));
    container.addEventListener('mousemove', (e) => this._onMouseMove(e));
    container.addEventListener('mouseup', (e) => this._onMouseUp(e));
    container.addEventListener('mouseleave', (e) => this._onMouseUp(e));

    // Prevent context menu on long press
    container.addEventListener('contextmenu', (e) => e.preventDefault());

    // Block browser/system-like touch gestures that can otherwise surface
    // tab switching, history navigation, or callouts during kiosk fullscreen.
    const browserGestureEvents = [
      'touchstart',
      'touchmove',
      'touchend',
      'touchcancel',
      'gesturestart',
      'gesturechange',
      'gestureend',
    ];
    browserGestureEvents.forEach((eventName) => {
      document.addEventListener(eventName, (e) => this._blockBrowserGesture(e), {
        capture: true,
        passive: false,
      });
    });

    // Close about panel
    document.getElementById('about-close').addEventListener('click', () => {
      this._hideAbout();
      this._hideCircleImage();
    });

    if (this.virtualAddBtn) {
      const addLens = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._addVirtualLens();
      };
      const stopLensControl = (e) => e.stopPropagation();
      this.virtualAddBtn.addEventListener('click', addLens);
      this.virtualAddBtn.addEventListener('mousedown', stopLensControl);
      this.virtualAddBtn.addEventListener('touchstart', stopLensControl, { passive: false });
      this.virtualAddBtn.addEventListener('touchend', addLens, { passive: false });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if ((e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') && !this.layoutEditor.isOpen) {
        e.preventDefault();
        this._activateVirtualLensMode();
        return;
      }
      if (e.key === 'ArrowDown' && e.ctrlKey) {
        e.preventDefault();
        if (document.fullscreenElement) this._toggleFullscreen();
        return;
      }
      if (e.key === 'ArrowUp' && e.ctrlKey) {
        e.preventDefault();
        this.map.markersEl.classList.toggle('visible');
        return;
      }
      if (e.key === 'ArrowRight' && e.ctrlKey) {
        e.preventDefault();
        if (this.layoutEditor.isOpen) {
          this.layoutEditor.close();
        } else {
          this.layoutEditor.open();
        }
        return;
      }
      if (e.key === 'Escape') {
        if (this.layoutEditor.isOpen) { this.layoutEditor.close(); return; }
        this._hideAbout();
        this._hideCircleImage();
        this.lens.hide();
        this._clearVirtualLenses();
        this._syncTitleVisibility();
        this._hideNoResult();
      }
    });

    // Release keyboard lock on fullscreen change
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        this._lockNavigationKeys();
      } else {
        navigator.keyboard?.unlock?.();
      }
    });
  }

  _toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' })
        .then(() => this._lockNavigationKeys())
        .catch(() => {});
    } else {
      navigator.keyboard?.unlock?.();
      document.exitFullscreen().catch(() => {});
    }
  }

  _blockBrowserGesture(e) {
    const target = e.target instanceof Element ? e.target : null;

    // Let the fullscreen button receive its own startup touch. Its touchend
    // handler calls preventDefault() before toggling fullscreen.
    if (!document.fullscreenElement && target?.closest('#fullscreen-btn')) return;

    if (document.fullscreenElement || target?.closest('#app-container')) {
      if (e.cancelable) e.preventDefault();
    }
  }

  async _lockNavigationKeys() {
    if (!navigator.keyboard?.lock) return;

    const navigationKeys = [
      'Escape',
      'AltLeft',
      'AltRight',
      'Tab',
      'MetaLeft',
      'MetaRight',
      'ControlLeft',
      'ControlRight',
      'F4',
      'F11',
      'BrowserBack',
      'BrowserForward',
    ];

    try {
      await navigator.keyboard.lock(navigationKeys);
    } catch (_) {
      try {
        await navigator.keyboard.lock();
      } catch (_) {}
    }
  }

  /* ---- TOUCH HANDLERS ---- */

  _onTouchStart(e) {
    if (this.layoutEditor.isOpen) return;

    const virtualTouch = e.changedTouches.length === 1 ? e.changedTouches[0] : null;
    const virtualKey = virtualTouch ? this._getVirtualLensAt(virtualTouch.clientX, virtualTouch.clientY) : null;
    if (virtualKey) {
      e.preventDefault();
      this._isTouch = true;
      this.audio.init();
      this._fadeTitle();
      this._virtualTouchDrag = { key: virtualKey, id: virtualTouch.identifier };
      this._moveVirtualLens(virtualKey, virtualTouch.clientX, virtualTouch.clientY);
      return;
    }

    e.preventDefault();
    this._isTouch = true;
    this.audio.init();
    this._fadeTitle();

    for (const t of e.changedTouches) {
      this._activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    this._recomputeCircleGroups();
  }

  _onTouchMove(e) {
    if (this.layoutEditor.isOpen) return;

    if (this._virtualTouchDrag) {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== this._virtualTouchDrag.id) continue;
        this._moveVirtualLens(this._virtualTouchDrag.key, t.clientX, t.clientY);
        break;
      }
      return;
    }

    e.preventDefault();
    for (const t of e.changedTouches) {
      const pt = this._activeTouches.get(t.identifier);
      if (pt) { pt.x = t.clientX; pt.y = t.clientY; }
    }
    this._recomputeCircleGroups();
  }

  _onTouchEnd(e) {
    if (this.layoutEditor.isOpen) return;

    if (this._virtualTouchDrag) {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._virtualTouchDrag.id) continue;
        e.preventDefault();
        this._virtualTouchDrag = null;
        this._syncTitleVisibility();
        return;
      }
    }

    e.preventDefault();
    for (const t of e.changedTouches) {
      this._activeTouches.delete(t.identifier);
    }
    this._recomputeCircleGroups();
    if (this._activeTouches.size === 0) {
      this._syncTitleVisibility();
      this._hideCircleImage();
    }
  }

  /* ---- MOUSE HANDLERS (Desktop Fallback) ---- */

  _onMouseDown(e) {
    if (this._isTouch || this.layoutEditor.isOpen) return;
    if (e.target.closest('#about-panel, #virtual-lens-controls')) return;

    const virtualKey = this._getVirtualLensAt(e.clientX, e.clientY);
    if (virtualKey) {
      this.audio.init();
      this._virtualDragKey = virtualKey;
      this._fadeTitle();
      this._moveVirtualLens(virtualKey, e.clientX, e.clientY);
      return;
    }

    this.audio.init();
    this._mouseActive = true;
    this.lens.show(e.clientX, e.clientY);
    this._fadeTitle();
    this._processPosition(e.clientX, e.clientY);
  }

  _onMouseMove(e) {
    this._pointerPos = { x: e.clientX, y: e.clientY, hasValue: true };

    if (this._virtualDragKey) {
      this._moveVirtualLens(this._virtualDragKey, e.clientX, e.clientY);
      return;
    }

    if (this._isTouch || !this._mouseActive) return;
    this.lens.moveTo(e.clientX, e.clientY);
    this._processPosition(e.clientX, e.clientY);
    if (this._aboutVisible) {
      this._updateCircleImage(e.clientX, e.clientY);
    }
  }

  _onMouseUp(_e) {
    if (this._virtualDragKey) {
      this._virtualDragKey = null;
      this._syncTitleVisibility();
      return;
    }

    if (this._isTouch || !this._mouseActive) return;
    this._mouseActive = false;
    this.lens.hide();
    this._hideCircleImage();
    this._hideAbout();
    this._syncTitleVisibility();
    this._hideNoResult();
  }

  /* ---- POSITION PROCESSING ---- */

  /**
   * Process the current lens position:
   *  - Convert screen coords to lat/lng
   *  - Search for nearby microbes
   *  - Update UI accordingly
   * @param {number} x - Screen X
   * @param {number} y - Screen Y
   */
  _processPosition(x, y) {
    this._lastPos = { x, y };
    const { lat, lng } = this.map.screenToLatLng(x, y);
    this.lens.updateCoords(lat, lng);

    const microbe = this.data.findNearby(lat, lng);

    if (microbe) {
      this._onMicrobeFound(microbe);
    } else {
      this._onNoMicrobe();
    }
  }

  /**
   * Called when the lens is over a known microbe region.
   * @param {Object} microbe
   */
  _onMicrobeFound(microbe) {
    // Clear no-result timer
    this._clearNoResultTimer();
    this._hideNoResult();

    // If it's a new discovery (different from current)
    if (this._lastFoundMicrobe?.id !== microbe.id) {
      this._lastFoundMicrobe = microbe;

      // Update lens visuals
      this.lens.setDiscovered(microbe);

      // Show highlight at microbe's map position
      const pos = this.map.latLngToScreen(microbe.latitude, microbe.longitude);
      this.lens.showHighlight(pos.x, pos.y);

      // Mark discovered in data & map
      const isNew = this.data.markDiscovered(microbe.id);
      if (isNew) {
        this.map.markDiscovered(microbe.id);
        this._updateCounter();
        this.audio.playDiscovery();
      }

      // Mouse mode: video circle follows cursor, about panel anchored to microbe's map pin
      const cx = this._lastPos.x;
      const cy = this._lastPos.y;
      const microbePos = this.map.latLngToScreen(microbe.latitude, microbe.longitude);
      this._showCircleImage(microbe, cx, cy);
      this._showAbout(microbe, microbePos.x, microbePos.y);
    }
  }

  /** Called when the lens is not near any microbe */
  _onNoMicrobe() {
    if (this._lastFoundMicrobe) {
      this._lastFoundMicrobe = null;
      this.lens.clearDiscovered();
      this.lens.hideHighlight();
      this._hideCircleImage();
      this._hideAbout();
    }

    // Start no-result timer
    if (!this._noResultTimeout) {
      this._noResultTimeout = setTimeout(() => {
        this._showNoResult();
        this.audio.playNoResult();
      }, CONFIG.lens.noResultDelay);
    }
  }

  /* ---- UI Helpers ---- */

  _fadeTitle() {
    this.titleOverlay.classList.add('faded');
  }

  _showTitle() {
    this.titleOverlay.classList.remove('faded');
  }

  _showNoResult() {
    if (!this.noResultToast) return;
    this.noResultToast.classList.remove('hidden');
    this.noResultToast.classList.add('visible');
  }

  _hideNoResult() {
    if (!this.noResultToast) {
      this._clearNoResultTimer();
      return;
    }
    this.noResultToast.classList.remove('visible');
    this.noResultToast.classList.add('hidden');
    this._clearNoResultTimer();
  }

  _clearNoResultTimer() {
    if (this._noResultTimeout) {
      clearTimeout(this._noResultTimeout);
      this._noResultTimeout = null;
    }
  }

  _syncTitleVisibility() {
    if (this._virtualLenses.size > 0 || this._mouseActive || this._activeTouches.size > 0) {
      this._fadeTitle();
    } else {
      this._showTitle();
    }
  }

  _syncVirtualControls() {
    if (!this.virtualControls) return;
    const hasVirtualLenses = this._virtualLenses.size > 0;
    this.virtualControls.classList.toggle('hidden', !hasVirtualLenses);
    if (this.virtualAddBtn) {
      const count = this._virtualLenses.size;
      this.virtualAddBtn.setAttribute('aria-label', `Add virtual lens. ${count} active.`);
      this.virtualAddBtn.title = `Add virtual lens (${count} active)`;
    }
  }

  _activateVirtualLensMode() {
    if (this._virtualLenses.size === 0) {
      this._addVirtualLens();
      return;
    }
    this._syncVirtualControls();
    this._syncTitleVisibility();
  }

  _virtualLensRadius() {
    const avgDiameterCm = (CONFIG.ring.diameterMinCm + CONFIG.ring.diameterMaxCm) / 2;
    return Math.max(CONFIG.ring.minRadiusPx, _cmToCssPx(avgDiameterCm / 2));
  }

  _getVirtualLensSpawnPoint(r, x = null, y = null) {
    let cx = Number.isFinite(x) ? x : null;
    let cy = Number.isFinite(y) ? y : null;

    if (cx === null || cy === null) {
      const lenses = [...this._virtualLenses.values()];
      if (lenses.length > 0) {
        const last = lenses[lenses.length - 1];
        cx = last.x + CONFIG.lens.virtualSpawnOffsetPx;
        cy = last.y + CONFIG.lens.virtualSpawnOffsetPx;
      } else if (this._pointerPos.hasValue) {
        cx = this._pointerPos.x;
        cy = this._pointerPos.y;
      } else {
        cx = window.innerWidth / 2;
        cy = window.innerHeight / 2;
      }
    }

    return this._clampVirtualLensPoint(cx, cy, r);
  }

  _clampVirtualLensPoint(x, y, r) {
    return {
      x: Math.max(r, Math.min(x, window.innerWidth - r)),
      y: Math.max(r, Math.min(y, window.innerHeight - r)),
    };
  }

  _addVirtualLens(x = null, y = null) {
    const r = this._virtualLensRadius();
    const pos = this._getVirtualLensSpawnPoint(r, x, y);
    const key = `virtual-${++this._virtualLensSeq}`;

    this.audio.init();
    this._virtualLenses.set(key, { x: pos.x, y: pos.y, r });
    this.circle.setGroup(key, pos.x, pos.y, r);
    this._ensureCircleGroupState(key, { r, isVirtual: true });
    this._processGroupCircle(key, pos.x, pos.y);
    this._syncVirtualControls();
    this._syncTitleVisibility();
  }

  _moveVirtualLens(key, x, y) {
    const lens = this._virtualLenses.get(key);
    if (!lens) return;

    const pos = this._clampVirtualLensPoint(x, y, lens.r);
    lens.x = pos.x;
    lens.y = pos.y;
    this.circle.setGroup(key, lens.x, lens.y, lens.r);
    this._ensureCircleGroupState(key, { r: lens.r, isVirtual: true });
    this._processGroupCircle(key, lens.x, lens.y);
  }

  _getVirtualLensAt(x, y) {
    const lenses = [...this._virtualLenses.entries()].reverse();
    for (const [key, lens] of lenses) {
      const hitRadius = lens.r + CONFIG.lens.virtualHitPaddingPx;
      if (Math.hypot(x - lens.x, y - lens.y) <= hitRadius) return key;
    }
    return null;
  }

  _isVirtualLensKey(key) {
    return this._virtualLenses.has(key) || this._circleGroupState.get(key)?.isVirtual === true;
  }

  _clearVirtualLenses() {
    for (const key of [...this._virtualLenses.keys()]) {
      const state = this._circleGroupState.get(key);
      if (state) {
        this._destroyGroupState(key, state);
      } else {
        this.circle.removeGroup(key);
        this._virtualLenses.delete(key);
      }
    }
    this._virtualDragKey = null;
    this._virtualTouchDrag = null;
    this._syncVirtualControls();
  }

  _ensureCircleGroupState(key, { touchIds = null, r = null, isVirtual = false } = {}) {
    let state = this._circleGroupState.get(key);
    if (!state) {
      state = {
        touchIds: touchIds ?? [],
        microbe: null,
        card: null,
        r: r ?? 0,
        imgWrap: null,
        releaseTimer: null,
        pointReleaseTimer: null,
        isReleased: false,
        isOffPoint: false,
        isVirtual,
      };
      this._circleGroupState.set(key, state);
    }

    if (touchIds) state.touchIds = touchIds;
    if (typeof r === 'number') state.r = r;
    if (isVirtual) state.isVirtual = true;
    state.isReleased = false;
    if (state.releaseTimer) {
      clearTimeout(state.releaseTimer);
      state.releaseTimer = null;
    }

    return state;
  }

  /* ---- Ring group detection & lifecycle ---- */

  _recomputeCircleGroups() {
    const groups = _findCircleGroups(this._activeTouches, this._circleGroupState);
    this._debugTouchGrouping(groups);

    const newKeys = new Set(groups.map(g => g.key));
    const oldKeys = new Set(
      [...this._circleGroupState.keys()].filter(key => !this._isVirtualLensKey(key))
    );

    // Let dissolved groups survive brief touch dropouts before stopping media.
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        const state = this._circleGroupState.get(key);
        this._scheduleGroupRelease(key, state);
      }
    }

    // Add or update active groups
    for (const g of groups) {
      this.circle.setGroup(g.key, g.cx, g.cy, g.r);
      this._ensureCircleGroupState(g.key, { touchIds: g.ids, r: g.r });
      this._processGroupCircle(g.key, g.cx, g.cy);
    }
  }

  _debugTouchGrouping(groups) {
    const signature = `${this._activeTouches.size}:${groups.length}`;
    if (this._lastTouchGroupSignature === signature) return;
    this._lastTouchGroupSignature = signature;
    console.log(`[Touch] active=${this._activeTouches.size}, lenses=${groups.length}`);
  }

  _scheduleGroupRelease(key, state) {
    if (!state || state.releaseTimer) return;

    state.isReleased = true;
    state.releaseTimer = setTimeout(() => {
      const latest = this._circleGroupState.get(key);
      if (!latest || !latest.isReleased) return;
      this._destroyGroupState(key, latest);
    }, CONFIG.lens.mediaReleaseGraceMs);
  }

  _destroyGroupState(key, state) {
    if (state.releaseTimer) clearTimeout(state.releaseTimer);
    if (state.pointReleaseTimer) clearTimeout(state.pointReleaseTimer);
    if (state.card)    { this._hideCard(state.card); state.card = null; }
    if (state.imgWrap) { this._hideImgWrap(state.imgWrap); state.imgWrap = null; }
    this.circle.removeGroup(key);
    if (state.isVirtual || this._virtualLenses.has(key)) {
      this._virtualLenses.delete(key);
      this._syncVirtualControls();
    }
    this._circleGroupState.delete(key);
  }

  _processGroupCircle(key, x, y) {
    const state = this._circleGroupState.get(key);
    if (!state) return;

    if (state.imgWrap) this._updateImgWrap(state.imgWrap, x, y);

    const { lat, lng } = this.map.screenToLatLng(x, y);
    const microbe = this.data.findNearby(lat, lng);

    if (microbe) {
      state.isOffPoint = false;
      if (state.pointReleaseTimer) {
        clearTimeout(state.pointReleaseTimer);
        state.pointReleaseTimer = null;
      }

      if (state.microbe?.id !== microbe.id) {
        state.microbe = microbe;

        // Card is anchored to the microbe's map marker — shown once, never repositioned
        if (!state.card) state.card = this._createCard();
        const mColor = this._microbeColors.get(microbe.id) ?? '#00d4ff';
        this._populateCard(state.card, microbe, mColor);
        const mPos = this.map.latLngToScreen(microbe.latitude, microbe.longitude);
        this._showCard(state.card, mPos.x, mPos.y);

        // Per-group bacteria image (at circle center)
        if (!state.imgWrap) state.imgWrap = this._createImgWrap();
        this._showImgWrap(state.imgWrap, microbe, x, y, mColor);

        const isNew = this.data.markDiscovered(microbe.id);
        if (isNew) {
          this.map.markDiscovered(microbe.id);
          this._updateCounter();
          this.audio.playDiscovery();
        }
      }
    } else {
      this._schedulePointRelease(state);
    }
  }

  _schedulePointRelease(state) {
    if (!state?.microbe || state.pointReleaseTimer) return;

    state.isOffPoint = true;
    state.pointReleaseTimer = setTimeout(() => {
      if (!state.isOffPoint) return;
      state.microbe = null;
      state.pointReleaseTimer = null;
      if (state.card)    { this._hideCard(state.card); state.card = null; }
      if (state.imgWrap) { this._hideImgWrap(state.imgWrap); state.imgWrap = null; }
    }, CONFIG.lens.pointReleaseGraceMs);
  }

  _getRotationAngle(cx, cy) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const distTop = cy;
    const distBottom = h - cy;
    const distLeft = cx;
    const distRight = w - cx;
    const minDist = Math.min(distTop, distBottom, distLeft, distRight);

    if (minDist === distBottom) return 0;      // Bottom edge -> 0 deg rotation
    if (minDist === distLeft) return 90;       // Left edge -> 90 deg rotation
    if (minDist === distTop) return 180;       // Top edge -> 180 deg rotation
    return 270;                                // Right edge -> 270 deg rotation
  }

  /* ---- Per-group image helpers ---- */

  _createImgWrap() {
    const wrap = document.createElement('div');
    wrap.className = 'circle-img-wrap hidden';
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-label', 'Microorganism video');
    this._prepareLoopingVideo(video);
    const vig = document.createElement('div');
    vig.className = 'ciw-vignette';
    wrap.appendChild(video);
    wrap.appendChild(vig);
    document.getElementById('app-container').appendChild(wrap);
    return wrap;
  }

  _showImgWrap(wrap, microbe, cx, cy, color) {
    const video = wrap.querySelector('video');
    const src = this._getMicrobeVideoSrc(microbe);
    if (!video.src.endsWith(src)) {
      video.src = src;
      video.load();
    }
    wrap.style.boxShadow   = `0 0 40px ${color}55, inset 0 0 30px rgba(0,0,0,0.4)`;
    this._updateImgWrap(wrap, cx, cy);
    const angle = this._getRotationAngle(cx, cy);
    wrap.style.setProperty('--rotation', `${angle}deg`);
    wrap.classList.remove('hidden');
    requestAnimationFrame(() => wrap.classList.add('visible'));
    this._playVideo(video);
  }

  _updateImgWrap(wrap, cx, cy) {
    const size = _cmToCssPx(CONFIG.media.videoDiameterCm);
    wrap.style.left   = `${cx}px`;
    wrap.style.top    = `${cy}px`;
    wrap.style.width  = `${size}px`;
    wrap.style.height = `${size}px`;
    const video = wrap.querySelector('video');
    if (video?.dataset.keepPlaying === 'true' && video.paused) this._playVideo(video);
  }

  _hideImgWrap(wrap) {
    const video = wrap.querySelector('video');
    if (video) this._pauseVideo(video);
    wrap.classList.remove('visible');
    wrap.classList.add('hidden');
    setTimeout(() => wrap.remove(), 400);
  }

  /* ---- Per-circle info card ---- */

  _createCard() {
    const wrapper = document.createElement('div');
    wrapper.className = 'circle-card-wrapper';
    const el = document.createElement('div');
    el.className = 'circle-card hidden';
    el.innerHTML =
      '<span class="cc-badge"></span>' +
      '<h3 class="cc-name"></h3>' +
      '<p class="cc-sci"></p>' +
      '<p class="cc-desc"></p>' +
      '<p class="cc-loc"></p>';
    wrapper.appendChild(el);
    document.getElementById('app-container').appendChild(wrapper);
    return wrapper;
  }

  _populateCard(wrapper, microbe, color) {
    wrapper.dataset.microbeId = microbe.id;
    const card = wrapper.querySelector('.circle-card');
    const badge = card.querySelector('.cc-badge');
    badge.textContent = microbe.habitat;
    badge.style.color       = color;
    badge.style.borderColor = color + '66';
    card.querySelector('.cc-name').textContent = microbe.name;
    card.querySelector('.cc-sci').textContent  = microbe.scientificName;
    card.querySelector('.cc-desc').textContent = microbe.description;
    card.querySelector('.cc-loc').textContent  = `${microbe.location}, ${microbe.country}`;
  }

  _showCard(wrapper, markerX, markerY) {
    this._positionCard(wrapper, markerX, markerY);
    const card = wrapper.querySelector('.circle-card');
    card.classList.remove('hidden');
    requestAnimationFrame(() => card.classList.add('visible'));
  }

  _positionCard(wrapper, markerX, markerY) {
    const id    = wrapper.dataset.microbeId;
    const saved = id ? this.layoutEditor.getSavedCard(id) : null;
    const card  = wrapper.querySelector('.circle-card');
    if (saved) {
      wrapper.style.left   = `${saved.x}px`;
      wrapper.style.top    = `${saved.y}px`;
      wrapper.style.width  = `${saved.width || 175}px`;
      wrapper.style.height = 'auto';
      card.style.width     = `${saved.width || 175}px`;
      card.style.setProperty('--rotation', `${saved.rotation || 0}deg`);
      return;
    }
    const w = 175;
    const h = card.offsetHeight || 180;
    const { left, top, angle, visualW, visualH } = this._fixedCardPos(markerX, markerY, w, h);
    wrapper.style.left   = `${left}px`;
    wrapper.style.top    = `${top}px`;
    wrapper.style.width  = `${visualW}px`;
    wrapper.style.height = `${visualH}px`;
    card.style.setProperty('--rotation', `${angle}deg`);
  }

  _hideCard(wrapper) {
    const card = wrapper.querySelector('.circle-card');
    card.classList.remove('visible');
    card.classList.add('hidden');
    setTimeout(() => wrapper.remove(), 300);
  }

  /* ---- Circle image helpers ---- */

  _showCircleImage(microbe, cx, cy) {
    const video = document.getElementById('circle-video');
    const src = this._getMicrobeVideoSrc(microbe);
    if (!video.src.endsWith(src)) {
      video.src = src;
      video.load();
    }
    this._updateCircleImage(cx, cy);
    const wrap = document.getElementById('circle-image-wrap');
    const angle = this._getRotationAngle(cx, cy);
    wrap.style.setProperty('--rotation', `${angle}deg`);
    wrap.classList.remove('hidden');
    requestAnimationFrame(() => wrap.classList.add('visible'));
    this._playVideo(video);
  }

  _updateCircleImage(cx, cy) {
    const wrap = document.getElementById('circle-image-wrap');
    const size = _cmToCssPx(CONFIG.media.videoDiameterCm);
    wrap.style.left   = `${cx}px`;
    wrap.style.top    = `${cy}px`;
    wrap.style.width  = `${size}px`;
    wrap.style.height = `${size}px`;
    const video = document.getElementById('circle-video');
    if (video?.dataset.keepPlaying === 'true' && video.paused) this._playVideo(video);
  }

  _hideCircleImage() {
    const wrap = document.getElementById('circle-image-wrap');
    const video = document.getElementById('circle-video');
    this._pauseVideo(video);
    wrap.classList.remove('visible');
    wrap.classList.add('hidden');
  }

  /* ---- About panel helpers ---- */

  _showAbout(microbe, markerX, markerY) {
    document.getElementById('about-badge').textContent      = microbe.habitat;
    document.getElementById('about-name').textContent       = microbe.name;
    document.getElementById('about-scientific').textContent = microbe.scientificName;
    const words = microbe.description.split(/\s+/);
    const snippet = words.length > 25 ? words.slice(0, 25).join(' ') + '…' : microbe.description;
    document.getElementById('about-desc').textContent = snippet;
    document.getElementById('about-loc-name').textContent    = microbe.location;
    document.getElementById('about-loc-country').textContent = microbe.country;

    const wrapper = document.getElementById('about-panel-wrapper');
    wrapper.dataset.microbeId = microbe.id;
    const panel = document.getElementById('about-panel');
    wrapper.classList.remove('hidden');
    panel.classList.remove('hidden');
    requestAnimationFrame(() => {
      wrapper.classList.add('visible');
      panel.classList.add('visible');
    });
    this._aboutVisible = true;

    // Position after paint so offsetHeight is available
    requestAnimationFrame(() => this._positionAbout(markerX, markerY));
  }

  _positionAbout(markerX, markerY) {
    const wrapper = document.getElementById('about-panel-wrapper');
    const panel   = document.getElementById('about-panel');
    const id      = wrapper.dataset.microbeId;
    const saved   = id ? this.layoutEditor.getSavedCard(id) : null;
    if (saved) {
      wrapper.style.left   = `${saved.x}px`;
      wrapper.style.top    = `${saved.y}px`;
      wrapper.style.width  = `${saved.width || 185}px`;
      wrapper.style.height = 'auto';
      panel.style.width    = `${saved.width || 185}px`;
      panel.style.setProperty('--rotation', `${saved.rotation || 0}deg`);
      return;
    }
    const pw = panel.offsetWidth || 185;
    const ph = panel.offsetHeight || 280;
    const { left, top, angle, visualW, visualH } = this._fixedCardPos(markerX, markerY, pw, ph);
    wrapper.style.left   = `${left}px`;
    wrapper.style.top    = `${top}px`;
    wrapper.style.width  = `${visualW}px`;
    wrapper.style.height = `${visualH}px`;
    panel.style.setProperty('--rotation', `${angle}deg`);
  }

  /**
   * Returns a fixed {left, top, angle, visualW, visualH} for a card anchored
   * to a map marker. Determined solely by the marker's screen position:
   *   - angle: text faces the nearest screen edge so any user can read it
   *   - placement: card placed toward screen centre from the marker
   *   - gap: sized to the video circle so the card never overlaps it
   */
  _fixedCardPos(markerX, markerY, pw, ph) {
    const sw = window.innerWidth;
    const sh = window.innerHeight;

    // Text rotation so the card reads correctly from the nearest screen edge
    const angle     = this._getRotationAngle(markerX, markerY);
    const isRotated = (angle === 90 || angle === 270);

    // When rotated 90°/270° the card's visual footprint swaps width ↔ height
    const visualW = isRotated ? ph : pw;
    const visualH = isRotated ? pw : ph;

    // Clear the video circle (at ring/cursor centre, approx. at marker when placed)
    const videoR = _cmToCssPx(CONFIG.media.videoDiameterCm) / 2;
    const gap    = Math.max(videoR + 20, 50);

    let left, top;
    switch (angle) {
      case 0:   // nearest bottom edge → card above marker (toward centre)
        left = markerX - visualW / 2;
        top  = markerY - visualH - gap;
        break;
      case 180: // nearest top edge → card below marker (toward centre)
        left = markerX - visualW / 2;
        top  = markerY + gap;
        break;
      case 90:  // nearest left edge → card right of marker (toward centre)
        left = markerX + gap;
        top  = markerY - visualH / 2;
        break;
      default:  // nearest right edge → card left of marker (toward centre)
        left = markerX - visualW - gap;
        top  = markerY - visualH / 2;
        break;
    }

    return {
      left:    Math.max(8, Math.min(left, sw - visualW - 8)),
      top:     Math.max(8, Math.min(top,  sh - visualH - 8)),
      angle,
      visualW,
      visualH,
    };
  }

  _hideAbout() {
    const wrapper = document.getElementById('about-panel-wrapper');
    const panel = document.getElementById('about-panel');
    wrapper.classList.remove('visible');
    panel.classList.remove('visible');
    wrapper.classList.add('hidden');
    panel.classList.add('hidden');
    this._aboutVisible = false;
  }

  _updateCounter() {
    if (!this.counterEl) return;
    const count = this.data.discovered.size;
    this.counterEl.textContent = count;

    // Bump animation
    this.counterEl.classList.add('bump');
    setTimeout(() => this.counterEl.classList.remove('bump'), 400);
  }
}

/* ============================================= */
/*  BOOTSTRAP                                    */
/* ============================================= */
document.addEventListener('DOMContentLoaded', () => {
  const app = new AppController();
  app.init();
});
