// Pagina dedicata al censimento manutenzione dei tavoli del Comune di
// Padova (vedi padova.html), pensata per essere condivisa in un gruppo
// WhatsApp eterogeneo: niente filtri, niente cluster, niente pulsante
// "segnala tavolo mancante" - solo mappa + un pulsante per tavolo che apre
// il Google Form del censimento. Riusa lo stesso tavoli_italia.geojson
// della mappa nazionale (nessuna nuova pipeline), filtrato qui a comune
// "Padova".

const GEOJSON_URL = "tavoli_italia.geojson";
const COMUNE_FILTRO = "Padova";

// Conteggio dei censimenti raccolti per tavolo (OSM id -> numero di
// risposte), rigenerato da update_padova_censiti.py leggendo le risposte
// del Google Form: vedi quello script per i dettagli. E' un aggiornamento
// "a scatti", non in tempo reale - il conteggio qui e' quello dell'ultima
// volta che lo script e' stato rilanciato.
const CENSITI_URL = "padova_censiti.json";

const FORM_BASE_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSd3jgB6G3wilv4EI26D-Ew3teXNwp2z7gpp9HMWMzhGo9Hwwg/viewform";
const FORM_ID_ENTRY = "entry.183717027";

function buildCensimentoFormUrl(osmId) {
  const params = new URLSearchParams({ [FORM_ID_ENTRY]: osmId });
  return `${FORM_BASE_URL}?${params.toString()}`;
}

const map = L.map("map", { zoomControl: false }).setView([45.4064, 11.8768], 13);
L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

// Il badge (tick per 1 censimento, numero per 2+, assente per 0) e' un
// elemento fratello di .tt-marker-dot, non un suo figlio - vedi il
// commento su .tt-marker-badge in css/style.css sul perche'.
function buildTavoloIcon(count) {
  const badge = count === 0 ? "" : `<span class="tt-marker-badge">${count === 1 ? "✓" : count}</span>`;
  return L.divIcon({
    className: "tt-marker",
    html: `<div class="tt-marker-dot"><span>\u{1F3D3}</span></div>${badge}`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28],
  });
}

// Stesso banner-informazioni-sempre-aperto della card "i" della mappa
// nazionale (vedi InfoControl in js/app.js), ma qui il testo e' fisso e
// non richiede un toggle: l'unica cosa da comunicare e' che l'iniziativa
// e' per ora circoscritta al Comune di Padova.
const InfoBanner = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const div = L.DomUtil.create("div", "tt-padova-banner");
    div.innerHTML = `
      <h1>\u{1F3D3} Censimento tavoli — Comune di Padova</h1>
      <p>Iniziativa attiva per ora solo nel Comune di Padova. Tocca un tavolo sulla mappa e compila il modulo per segnalarne stato e manutenzione.</p>
    `;
    L.DomEvent.disableClickPropagation(div);
    return div;
  },
});
new InfoBanner().addTo(map);

// Copiata da js/app.js (buildPopupLinkButton) invece di condividerla:
// le due pagine non condividono un bundler/modulo, e la funzione e'
// abbastanza piccola da non giustificare l'infrastruttura per riusarla.
function buildPopupLinkButton(url, icon, label) {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.className = "popup-link-btn";
  const iconEl = document.createElement("span");
  iconEl.textContent = icon;
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  link.append(iconEl, labelEl);
  return link;
}

function buildPadovaPopupContent(properties, count) {
  const container = document.createElement("div");
  container.className = "popup-content";

  const title = document.createElement("h3");
  title.textContent = properties.name;
  container.appendChild(title);

  if (count > 0) {
    const countRow = document.createElement("p");
    countRow.className = "popup-report-hint";
    countRow.textContent =
      count === 1 ? "✓ 1 censimento raccolto" : `✓ ${count} censimenti raccolti`;
    container.appendChild(countRow);
  }

  container.appendChild(
    buildPopupLinkButton(buildCensimentoFormUrl(properties.id), "\u{1F4DD}", "Compila il censimento")
  );

  return container;
}

// Stessa normalizzazione way->punto di js/app.js (toPointGeometry): i
// tavoli di Padova sono oggi tutti dei node OSM, ma un tavolo rimappato
// come way in futuro non deve rompere silenziosamente questa pagina.
function toPointGeometry(geometry) {
  if (geometry.type === "Point") return geometry;
  const ring = geometry.type === "Polygon" ? geometry.coordinates[0] : geometry.coordinates;
  const vertices =
    ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  const [lngSum, latSum] = vertices.reduce(
    ([lng, lat], [vLng, vLat]) => [lng + vLng, lat + vLat],
    [0, 0]
  );
  return { type: "Point", coordinates: [lngSum / vertices.length, latSum / vertices.length] };
}

Promise.all([
  fetch(GEOJSON_URL).then((response) => response.json()),
  // padova_censiti.json potrebbe non esistere ancora al primo giro (prima
  // che update_padova_censiti.py sia stato rilanciato almeno una volta) -
  // in quel caso si procede con un conteggio vuoto invece di rompere il
  // caricamento della mappa.
  fetch(CENSITI_URL)
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({})),
])
  .then(([data, censiti]) => {
    const features = data.features.filter((feature) => feature.properties.comune === COMUNE_FILTRO);
    for (const feature of features) {
      feature.geometry = toPointGeometry(feature.geometry);
    }

    const geoJsonLayer = L.geoJSON(
      { type: "FeatureCollection", features },
      {
        pointToLayer(feature, latlng) {
          const count = censiti[feature.properties.id] || 0;
          return L.marker(latlng, { icon: buildTavoloIcon(count) });
        },
        onEachFeature(feature, layer) {
          const count = censiti[feature.properties.id] || 0;
          layer.bindPopup(() => buildPadovaPopupContent(feature.properties, count), {
            maxWidth: 280,
            minWidth: 220,
          });
        },
      }
    ).addTo(map);

    if (features.length > 0) {
      map.fitBounds(geoJsonLayer.getBounds(), { padding: [40, 40] });
    }
  })
  .catch((error) => {
    console.error("Errore nel caricamento di", GEOJSON_URL, error);
  });
