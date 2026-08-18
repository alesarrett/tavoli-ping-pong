// Mirrors FILTER_PROPERTIES in generate_geojson.py — keep in sync manually
// if that dict changes. Values already arrive pre-translated (or, for tags
// not covered by VALUE_TRANSLATIONS, as raw OSM strings) from the pipeline.
const FILTERABLE_PROPERTIES = [
  ["material", "Materiale", "\u{1F9F1}"],
  ["net", "Rete", "\u{1F945}"],
  ["net_material", "Materiale rete", "\u{1F529}"],
  ["access", "Accesso", "\u{1F513}"],
  ["covered", "Coperto", "☂️"],
];

const GEOJSON_URL = "tavoli_padova.geojson";

const map = L.map("map").setView([45.4, 11.87], 10);

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

const markerEntries = []; // { feature, layer }
const currentFilters = {};

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
  const topPadding = 100;
  const mapTop = map.getContainer().getBoundingClientRect().top;
  const popupTop = popupEl.getBoundingClientRect().top;
  const overflow = mapTop + topPadding - popupTop;
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
  let visibleCount = 0;
  for (const { feature, layer } of markerEntries) {
    const match = matchesFilters(feature.properties, currentFilters);
    if (match) visibleCount += 1;
    const onMap = map.hasLayer(layer);
    if (match && !onMap) map.addLayer(layer);
    if (!match && onMap) map.removeLayer(layer);
  }
  document.querySelectorAll(".tt-result-badge").forEach((badge) => {
    badge.textContent = `${visibleCount}/${markerEntries.length}`;
  });
}

const FiltersControl = L.Control.extend({
  options: { position: "topright" },

  onAdd(mapInstance) {
    const wrapper = L.DomUtil.create("div", "tt-filters-wrapper");

    const toggle = L.DomUtil.create("button", "tt-filters-toggle", wrapper);
    toggle.type = "button";
    const toggleIcon = L.DomUtil.create("span", "", toggle);
    toggleIcon.textContent = "\u{1F50D} Filtri";
    const toggleBadge = L.DomUtil.create("span", "tt-result-badge tt-badge", toggle);

    const panel = L.DomUtil.create("div", "tt-filters", wrapper);

    const header = L.DomUtil.create("div", "tt-filters-header", panel);
    const heading = L.DomUtil.create("h4", "", header);
    heading.textContent = "\u{1F50D} Filtri";
    const headerBadge = L.DomUtil.create("span", "tt-result-badge tt-badge", header);

    for (const [key, label, icon] of FILTERABLE_PROPERTIES) {
      const row = L.DomUtil.create("div", "tt-filter-row", panel);
      const labelEl = L.DomUtil.create("label", "", row);
      const iconEl = L.DomUtil.create("span", "tt-filter-icon", labelEl);
      iconEl.textContent = icon;
      labelEl.append(label);
      const select = L.DomUtil.create("select", "", row);
      select.dataset.key = key;

      const allOption = document.createElement("option");
      allOption.value = "";
      allOption.textContent = "Tutti";
      select.appendChild(allOption);

      for (const value of deriveOptions(this._features, key)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      }

      select.addEventListener("change", () => {
        if (select.value === "") {
          delete currentFilters[key];
        } else {
          currentFilters[key] = select.value;
        }
        applyFilters();
      });
    }

    toggle.addEventListener("click", () => panel.classList.toggle("open"));

    L.DomEvent.disableClickPropagation(wrapper);
    L.DomEvent.disableScrollPropagation(wrapper);

    return wrapper;
  },
});

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
          // filters control (top-right) when the marker is near the top
          // of the viewport; Leaflet's default 5px autoPan padding isn't
          // enough to clear that overlapping panel.
          autoPanPaddingTopLeft: L.point(20, 100),
          autoPanPaddingBottomRight: L.point(20, 20),
        });
        layer.addTo(map);
        markerEntries.push({ feature, layer });
      },
    });

    if (data.features.length > 0) {
      map.fitBounds(geoJsonLayer.getBounds(), { padding: [20, 20], maxZoom: 15 });
    }

    const filtersControl = new FiltersControl();
    filtersControl._features = data.features;
    filtersControl.addTo(map);
    applyFilters();
  })
  .catch((error) => {
    console.error("Errore nel caricamento di", GEOJSON_URL, error);
  });
