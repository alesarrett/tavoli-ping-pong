// Mirrors FILTER_PROPERTIES in generate_geojson.py — keep in sync manually
// if that dict changes. Values already arrive pre-translated (or, for tags
// not covered by VALUE_TRANSLATIONS, as raw OSM strings) from the pipeline.
// Righe del box "Filtri". Regione/Provincia sono un box a parte (ZONE_PROPERTIES,
// vedi ZoneControl) - non compaiono qui ne' come riga nel popup: il comune
// (spesso gia' nel nome auto-composto) e' piu' utile li', la geografia piu'
// ampia e' ridondante.
const FILTERABLE_PROPERTIES = [
  ["material", "Materiale", "\u{1F9F1}"],
  ["net", "Rete", "\u{1F945}"],
  ["net_material", "Materiale rete", "\u{1F529}"],
  ["access", "Accesso", "\u{1F513}"],
  ["covered", "Coperto", "☂️"],
];

// Box "Zona", separato e sopra "Filtri" - selezionare una Regione
// restringe le opzioni di Provincia (vedi ZoneControl).
const ZONE_PROPERTIES = [
  ["regione", "Regione", "\u{1F5FA}\u{FE0F}"],
  ["provincia", "Provincia", "\u{1F3DB}\u{FE0F}"],
];

const GEOJSON_URL = "tavoli_italia.geojson";

// Vista iniziale approssimativa sull'Italia, sostituita da fitBounds
// non appena i dati sono caricati (vedi applyFilters chiamato a fine
// fetch) - questa e' solo quel che si vede per il breve istante prima.
const map = L.map("map").setView([42.5, 12.5], 6);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const pingPongIcon = L.divIcon({
  className: "tt-marker",
  html: '<div class="tt-marker-dot"><span>\u{1F3D3}</span></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -28],
});

// Con migliaia di tavoli in tutta Italia la mappa sarebbe illeggibile a
// zoom bassi - il cluster aggrega i marker vicini in un unico pallino
// col conteggio, che si "apre" salendo di zoom (default del plugin).
const markerCluster = L.markerClusterGroup({
  // Senza questo, due tavoli molto vicini (es. nello stesso parco)
  // restano aggregati anche al massimo zoom della mappa - qui vogliamo
  // invece che allo zoom massimo si vedano sempre i marker singoli.
  disableClusteringAtZoom: 19,
  iconCreateFunction(cluster) {
    return L.divIcon({
      className: "tt-cluster",
      html: `<div class="tt-cluster-dot">${cluster.getChildCount()}</div>`,
      iconSize: [36, 36],
    });
  },
}).addTo(map);

const markerEntries = []; // { feature, layer }
const currentFilters = {};

// Spazio da lasciare libero in alto per non far aprire i popup sotto i
// due box "Zona" + "Filtri" impilati in alto a destra (desktop, entrambi
// espansi di default). Usato sia dall'autoPan iniziale del popup che dal
// ri-pan quando un'immagine finisce di caricare in ritardo.
const POPUP_TOP_CLEARANCE = 230;

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function addRow(container, label, value) {
  const row = document.createElement("div");
  row.className = "popup-row";
  const labelEl = document.createElement("span");
  labelEl.className = "popup-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.textContent = value;
  row.append(labelEl, valueEl);
  container.appendChild(row);
}

// Leaflet's autoPan runs once when the popup opens, sized to its content
// at that moment. Popup images load asynchronously and grow the popup
// afterwards, so a second, targeted pan is needed once each image loads
// (only pans if the popup's top is still hidden, e.g. under the filters
// control near the top of the viewport).
function keepPopupInView(imgEl) {
  const popupEl = imgEl.closest(".leaflet-popup");
  if (!popupEl) return;
  const mapTop = map.getContainer().getBoundingClientRect().top;
  const popupTop = popupEl.getBoundingClientRect().top;
  const overflow = mapTop + POPUP_TOP_CLEARANCE - popupTop;
  if (overflow > 0) {
    map.panBy([0, -overflow], { animate: true });
  }
}

function buildPopupContent(properties) {
  const container = document.createElement("div");
  container.className = "popup-content";

  const title = document.createElement("h3");
  title.textContent = properties.name;
  container.appendChild(title);

  for (const [key, label] of FILTERABLE_PROPERTIES) {
    if (properties[key] !== undefined) {
      addRow(container, label, properties[key]);
    }
  }

  for (const [key, value] of Object.entries(properties.extra || {})) {
    addRow(container, capitalize(key), value);
  }

  if (properties.maps_url) {
    const link = document.createElement("a");
    link.href = properties.maps_url;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "popup-maps-btn";
    link.textContent = "Apri in Google Maps";
    container.appendChild(link);
  }

  const images = properties.images || [];
  if (images.length > 0) {
    const thumbs = document.createElement("div");
    thumbs.className = "popup-thumbs";
    images.forEach((url, index) => {
      const img = document.createElement("img");
      img.src = url;
      img.loading = "lazy";
      img.alt = properties.name;
      img.addEventListener("click", () => openLightbox(images, index));
      img.addEventListener("load", () => keepPopupInView(img));
      thumbs.appendChild(img);
    });
    container.appendChild(thumbs);
  }

  return container;
}

function deriveOptions(features, key) {
  const values = new Set();
  for (const feature of features) {
    if (feature.properties[key] !== undefined) {
      values.add(feature.properties[key]);
    }
  }
  return [...values].sort();
}

function matchesFilters(properties, filters) {
  for (const [key, value] of Object.entries(filters)) {
    if (properties[key] !== value) return false;
  }
  return true;
}

function applyFilters() {
  const visibleLayers = [];
  for (const { feature, layer } of markerEntries) {
    const match = matchesFilters(feature.properties, currentFilters);
    const onMap = markerCluster.hasLayer(layer);
    if (match) {
      visibleLayers.push(layer);
      if (!onMap) markerCluster.addLayer(layer);
    } else if (onMap) {
      markerCluster.removeLayer(layer);
    }
  }
  document.querySelectorAll(".tt-result-badge").forEach((badge) => {
    badge.textContent = `${visibleLayers.length}/${markerEntries.length}`;
  });
  // Zoom sui risultati filtrati: coi filtri attivi (es. una provincia)
  // ha senso restringere la vista, non solo la lista dei marker visibili.
  if (visibleLayers.length > 0) {
    // getBounds() per way (Polygon/Polyline), getLatLng() per i node/Point.
    const bounds = L.latLngBounds([]);
    visibleLayers.forEach((layer) => {
      bounds.extend(layer.getBounds ? layer.getBounds() : layer.getLatLng());
    });
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }
}

function setSelectOptions(select, options, allLabel) {
  select.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = allLabel;
  select.appendChild(allOption);
  for (const value of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
}

// Riga con icona + label + <select>, condivisa da FiltersControl e
// ZoneControl. onChange (opzionale) gira DOPO l'aggiornamento di
// currentFilters e PRIMA di applyFilters() - usato dalla cascata
// Regione -> Provincia per ricalcolare le opzioni di Provincia senza
// far scattare applyFilters() due volte sullo stesso cambiamento.
function buildFilterRow(panel, key, label, icon, options, allLabel, onChange) {
  const row = L.DomUtil.create("div", "tt-filter-row", panel);
  const labelEl = L.DomUtil.create("label", "", row);
  const iconEl = L.DomUtil.create("span", "tt-filter-icon", labelEl);
  iconEl.textContent = icon;
  labelEl.append(label);
  const select = L.DomUtil.create("select", "", row);
  select.dataset.key = key;
  setSelectOptions(select, options, allLabel);

  select.addEventListener("change", () => {
    if (select.value === "") {
      delete currentFilters[key];
    } else {
      currentFilters[key] = select.value;
    }
    if (onChange) onChange(select.value);
    applyFilters();
  });

  return select;
}

// Struttura "card flottante collassabile" (bottone toggle su mobile +
// pannello con intestazione), condivisa da FiltersControl e ZoneControl.
function buildFilterPanel(wrapper, titleText, showBadge) {
  const toggle = L.DomUtil.create("button", "tt-filters-toggle", wrapper);
  toggle.type = "button";
  const toggleIcon = L.DomUtil.create("span", "", toggle);
  toggleIcon.textContent = titleText;
  if (showBadge) L.DomUtil.create("span", "tt-result-badge tt-badge", toggle);

  const panel = L.DomUtil.create("div", "tt-filters", wrapper);
  const header = L.DomUtil.create("div", "tt-filters-header", panel);
  const heading = L.DomUtil.create("h4", "", header);
  heading.textContent = titleText;
  if (showBadge) L.DomUtil.create("span", "tt-result-badge tt-badge", header);

  toggle.addEventListener("click", () => panel.classList.toggle("open"));
  return panel;
}

const FiltersControl = L.Control.extend({
  options: { position: "topright" },

  onAdd(mapInstance) {
    const wrapper = L.DomUtil.create("div", "tt-filters-wrapper");
    const panel = buildFilterPanel(wrapper, "\u{1F50D} Filtri", true);

    for (const [key, label, icon] of FILTERABLE_PROPERTIES) {
      buildFilterRow(panel, key, label, icon, deriveOptions(this._features, key), "Tutti");
    }

    L.DomEvent.disableClickPropagation(wrapper);
    L.DomEvent.disableScrollPropagation(wrapper);

    return wrapper;
  },
});

// Box "Zona": Regione e Provincia, con cascata (selezionare una Regione
// restringe le opzioni di Provincia alle sole provincie di quella
// regione - derivato dalle feature gia' caricate, nessuna chiamata di
// rete aggiuntiva).
const ZoneControl = L.Control.extend({
  options: { position: "topright" },

  onAdd(mapInstance) {
    const wrapper = L.DomUtil.create("div", "tt-filters-wrapper");
    const panel = buildFilterPanel(wrapper, "\u{1F5FA}\u{FE0F} Zona", false);
    const features = this._features;

    const provinceByRegione = new Map();
    for (const feature of features) {
      const { regione, provincia } = feature.properties;
      if (!regione || !provincia) continue;
      if (!provinceByRegione.has(regione)) provinceByRegione.set(regione, new Set());
      provinceByRegione.get(regione).add(provincia);
    }

    const [REGIONE, PROVINCIA] = ZONE_PROPERTIES;
    let provinciaSelect;

    buildFilterRow(
      panel,
      ...REGIONE,
      deriveOptions(features, "regione"),
      "Tutte",
      (regione) => {
        const options = regione
          ? [...(provinceByRegione.get(regione) || [])].sort()
          : deriveOptions(features, "provincia");
        const previousValue = provinciaSelect.value;
        setSelectOptions(provinciaSelect, options, "Tutte");
        if (options.includes(previousValue)) {
          provinciaSelect.value = previousValue;
        } else {
          provinciaSelect.value = "";
          delete currentFilters.provincia;
        }
      }
    );

    provinciaSelect = buildFilterRow(
      panel,
      ...PROVINCIA,
      deriveOptions(features, "provincia"),
      "Tutte"
    );

    L.DomEvent.disableClickPropagation(wrapper);
    L.DomEvent.disableScrollPropagation(wrapper);

    return wrapper;
  },
});

// Titolo sempre visibile in alto a sinistra (sotto lo zoom di default di
// Leaflet, che vive nello stesso angolo) + un bottone "i" che apre/chiude
// una breve descrizione del progetto. Non dipende dai dati del geojson,
// quindi viene aggiunto alla mappa subito, non dentro il fetch().
const InfoControl = L.Control.extend({
  options: { position: "topleft" },

  onAdd() {
    const wrapper = L.DomUtil.create("div", "tt-info-wrapper");
    const card = L.DomUtil.create("div", "tt-info-card", wrapper);

    const header = L.DomUtil.create("div", "tt-info-header", card);
    const title = L.DomUtil.create("h1", "tt-info-title", header);
    title.textContent = "\u{1F3D3} Tavoli da Ping Pong in Italia";
    const toggle = L.DomUtil.create("button", "tt-info-toggle", header);
    toggle.type = "button";
    toggle.textContent = "\u{2139}\u{FE0F}";
    toggle.setAttribute("aria-label", "Informazioni su questa mappa");

    const body = L.DomUtil.create("div", "tt-info-body", card);
    body.innerHTML = `
      <p>Mappa dei tavoli da ping pong pubblici in Italia, con dati aperti
      da <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">OpenStreetMap</a>.</p>
      <p>Usa i box "Zona" e "Filtri" in alto a destra per restringere la
      mappa per regione/provincia o per caratteristiche del tavolo
      (materiale, rete, accesso, copertura).</p>
      <p>Manca un tavolo o un dato non è corretto? Si può
      <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">contribuire direttamente su OpenStreetMap</a> -
      questa mappa viene rigenerata periodicamente dai dati aggiornati.</p>
    `;

    toggle.addEventListener("click", () => body.classList.toggle("open"));

    L.DomEvent.disableClickPropagation(wrapper);
    L.DomEvent.disableScrollPropagation(wrapper);

    return wrapper;
  },
});

new InfoControl().addTo(map);

// Lightbox

const lightboxEl = document.getElementById("lightbox");
const lightboxImage = lightboxEl.querySelector(".lightbox-image");
const lightboxPrev = lightboxEl.querySelector(".lightbox-prev");
const lightboxNext = lightboxEl.querySelector(".lightbox-next");
let lightboxImages = [];
let lightboxIndex = 0;

function showLightboxImage() {
  lightboxImage.src = lightboxImages[lightboxIndex];
  const hideNav = lightboxImages.length <= 1;
  lightboxPrev.classList.toggle("hidden-nav", hideNav);
  lightboxNext.classList.toggle("hidden-nav", hideNav);
}

function openLightbox(images, startIndex) {
  lightboxImages = images;
  lightboxIndex = startIndex;
  showLightboxImage();
  lightboxEl.classList.remove("hidden");
  lightboxEl.setAttribute("aria-hidden", "false");
}

function closeLightbox() {
  lightboxEl.classList.add("hidden");
  lightboxEl.setAttribute("aria-hidden", "true");
}

function showPrev(event) {
  event.stopPropagation();
  lightboxIndex = (lightboxIndex - 1 + lightboxImages.length) % lightboxImages.length;
  showLightboxImage();
}

function showNext(event) {
  event.stopPropagation();
  lightboxIndex = (lightboxIndex + 1) % lightboxImages.length;
  showLightboxImage();
}

lightboxEl.querySelector(".lightbox-backdrop").addEventListener("click", closeLightbox);
lightboxEl.querySelector(".lightbox-close").addEventListener("click", (event) => {
  event.stopPropagation();
  closeLightbox();
});
lightboxPrev.addEventListener("click", showPrev);
lightboxNext.addEventListener("click", showNext);

document.addEventListener("keydown", (event) => {
  if (lightboxEl.classList.contains("hidden")) return;
  if (event.key === "Escape") closeLightbox();
  if (event.key === "ArrowLeft") showPrev(event);
  if (event.key === "ArrowRight") showNext(event);
});

// Load data

fetch(GEOJSON_URL)
  .then((response) => response.json())
  .then((data) => {
    const geoJsonLayer = L.geoJSON(data, {
      pointToLayer(feature, latlng) {
        return L.marker(latlng, { icon: pingPongIcon });
      },
      onEachFeature(feature, layer) {
        layer.bindPopup(() => buildPopupContent(feature.properties), {
          maxWidth: 320,
          minWidth: 240,
          // Extra top padding keeps the popup from opening under the
          // Zona/Filtri controls (top-right) when the marker is near the
          // top of the viewport; Leaflet's default 5px autoPan padding
          // isn't enough to clear those two stacked panels.
          autoPanPaddingTopLeft: L.point(20, POPUP_TOP_CLEARANCE),
          autoPanPaddingBottomRight: L.point(20, 20),
        });
        markerCluster.addLayer(layer);
        markerEntries.push({ feature, layer });
      },
    });

    // Zona aggiunto prima di Filtri: Leaflet impila i controlli dello
    // stesso angolo nell'ordine di aggiunta, Zona deve stare sopra.
    const zoneControl = new ZoneControl();
    zoneControl._features = data.features;
    zoneControl.addTo(map);

    const filtersControl = new FiltersControl();
    filtersControl._features = data.features;
    filtersControl.addTo(map);

    applyFilters();
  })
  .catch((error) => {
    console.error("Errore nel caricamento di", GEOJSON_URL, error);
  });
