// Mirrors FILTER_PROPERTIES in generate_geojson.py — keep in sync manually
// if that dict changes. Values already arrive pre-translated (or, for tags
// not covered by VALUE_TRANSLATIONS, as raw OSM strings) from the pipeline.
// Righe della sezione "Caratteristiche" del pannello filtri.
// Regione/Provincia sono una sezione a parte (ZONE_PROPERTIES, vedi
// FilterControl) - non compaiono qui ne' come riga nel popup: il comune
// (spesso gia' nel nome auto-composto) e' piu' utile li', la geografia piu'
// ampia e' ridondante.
const FILTERABLE_PROPERTIES = [
  ["material", "Materiale", "\u{1F9F1}"],
  ["net", "Rete", "\u{1F945}"],
  ["net_material", "Materiale rete", "\u{1F529}"],
  ["access", "Accesso", "\u{1F513}"],
  ["covered", "Coperto", "☂️"],
];

// Sezione "Zona", sopra "Caratteristiche" nello stesso pannello -
// selezionare una Regione restringe le opzioni di Provincia e viceversa
// (vedi FilterControl).
const ZONE_PROPERTIES = [
  ["regione", "Regione", "\u{1F5FA}\u{FE0F}"],
  ["provincia", "Provincia", "\u{1F3DB}\u{FE0F}"],
];

const GEOJSON_URL = "tavoli_italia.geojson";

// Indirizzo a cui chi vuole contribuire una foto puo' scrivere - vedi
// buildEmailUrl(). Dedicato al progetto (non l'email personale del
// maintainer), visto che finisce pubblico nel sorgente del sito.
const CONTRIB_EMAIL = "pingpong.crestless933@passmail.com";

// Legge vista (lat/lng/zoom) e filtri dalla query string, cosi' un URL
// copiato/condiviso riproduce esattamente lo stato della mappa - vedi
// syncUrl() piu' sotto, che scrive nella direzione opposta.
function readStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const filters = {};
  for (const [key] of [...FILTERABLE_PROPERTIES, ...ZONE_PROPERTIES]) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  const lat = parseFloat(params.get("lat"));
  const lng = parseFloat(params.get("lng"));
  const zoom = parseInt(params.get("zoom"), 10);
  const view =
    Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(zoom)
      ? { lat, lng, zoom }
      : null;
  // Link "condividi questo tavolo" (vedi buildShareTavoloUrl()): porta
  // sempre anche lat/lng/zoom gia' centrati su quel tavolo, quindi non
  // serve altra logica qui oltre a leggere l'id - la vista e' gia'
  // gestita dal campo "view" sopra.
  const id = params.get("id");
  return { view, filters, id };
}

const urlState = readStateFromUrl();

// Vista iniziale: quella dell'URL se presente, altrimenti un'inquadratura
// approssimativa sull'Italia sostituita da fitBounds non appena i dati
// sono caricati (vedi applyFilters chiamato a fine fetch).
const map = L.map("map", { zoomControl: false }).setView(
  urlState.view ? [urlState.view.lat, urlState.view.lng] : [42.5, 12.5],
  urlState.view ? urlState.view.zoom : 6
);
// In basso a destra invece che in alto a sinistra (default Leaflet):
// libera l'angolo in alto per titolo/info/condividi (vedi InfoControl).
L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

// Pan/zoom manuali (non guidati da un cambio filtro, gia' coperto in
// applyFilters()) aggiornano comunque l'URL condivisibile.
map.on("moveend", () => syncUrl());

const pingPongIcon = L.divIcon({
  className: "tt-marker",
  html: '<div class="tt-marker-dot"><span>\u{1F3D3}</span></div>',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -28],
});

// Zoom a cui i marker non vengono mai piu' raggruppati in cluster (vedi
// sotto) - anche il link "condividi questo tavolo"/apertura da ?id=
// punta a questo stesso zoom, cosi' il marker target e' sempre gia'
// sciolto dal cluster quando si prova ad aprirne il popup (vedi piu'
// sotto per il perche').
const CLUSTER_DISABLE_ZOOM = 19;

// Con migliaia di tavoli in tutta Italia la mappa sarebbe illeggibile a
// zoom bassi - il cluster aggrega i marker vicini in un unico pallino
// col conteggio, che si "apre" salendo di zoom (default del plugin).
const markerCluster = L.markerClusterGroup({
  // Senza questo, due tavoli molto vicini (es. nello stesso parco)
  // restano aggregati anche al massimo zoom della mappa - qui vogliamo
  // invece che allo zoom massimo si vedano sempre i marker singoli.
  disableClusteringAtZoom: CLUSTER_DISABLE_ZOOM,
  iconCreateFunction(cluster) {
    return L.divIcon({
      className: "tt-cluster",
      html: `<div class="tt-cluster-dot">${cluster.getChildCount()}</div>`,
      iconSize: [36, 36],
    });
  },
}).addTo(map);

const markerEntries = []; // { feature, layer }
// Pre-popolato dall'URL: le select dei filtri si auto-selezionano di
// conseguenza in buildFilterRow(), nessun altro cablaggio necessario.
const currentFilters = { ...urlState.filters };

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

// Posizionamento del popup: invece di inseguire i bordi della viewport
// con dei margini (il vecchio approccio basato sull'autoPan nativo di
// Leaflet, disattivato qui sotto con autoPan:false - si e' rivelato
// fragile: bastava una card in un angolo o un'immagine che finiva di
// caricare per farlo sballare, vedi commit precedenti) si fa in due
// passi geometrici espliciti, uno per asse:
//
// 1) centerMarkerHorizontally(): appena il popup si apre, centra SUBITO
//    l'icona del marker a meta' larghezza della mappa - la larghezza del
//    popup e' gia' nota/stabile da subito (maxWidth/minWidth fissi, solo
//    l'ALTEZZA cresce con le immagini), quindi l'orizzontale si sistema
//    una volta sola e non ha bisogno di essere ricalcolato.
// 2) centerPopupBlockVertically(): una volta che il popup ha le sue
//    dimensioni finali (con eventuali immagini gia' caricate), centra
//    verticalmente il blocco COMPLETO icona+popup, cosi' l'insieme (non
//    solo il marker) sta in mezzo allo schermo - il che tiene entrambi
//    lontani per costruzione dalle card in alto (Filtri/Info) senza
//    doverne conoscere le dimensioni.
//
// Il passo 2 gira con un piccolo debounce (scheduleCenterPopupBlock):
// va rieseguito ad ogni immagine che finisce di caricare (i popup con
// foto crescono in modo asincrono), ma raggruppando piu' 'load' vicini
// in un solo ricalcolo invece di uno per immagine evita di misurare la
// geometria a meta' di una correzione precedente.
function centerMarkerHorizontally(layer) {
  const mapRect = map.getContainer().getBoundingClientRect();
  const point = map.latLngToContainerPoint(layer.getLatLng());
  const deltaX = point.x - mapRect.width / 2;
  if (Math.abs(deltaX) > 1) {
    map.panBy([deltaX, 0], { animate: false });
  }
}

function centerPopupBlockVertically(layer) {
  const popupEl = layer.getPopup()?.getElement();
  const markerEl = layer.getElement();
  if (!popupEl || !markerEl) return;
  const mapRect = map.getContainer().getBoundingClientRect();
  const popupRect = popupEl.getBoundingClientRect();
  const markerRect = markerEl.getBoundingClientRect();
  const blockTop = Math.min(popupRect.top, markerRect.top);
  const blockBottom = Math.max(popupRect.bottom, markerRect.bottom);
  const blockMid = (blockTop + blockBottom) / 2;
  const viewportMid = mapRect.top + mapRect.height / 2;
  const deltaY = blockMid - viewportMid;
  if (Math.abs(deltaY) > 1) {
    map.panBy([0, deltaY], { animate: false });
  }
}

let popupCenterTimer = null;
function scheduleCenterPopupBlock(layer) {
  clearTimeout(popupCenterTimer);
  popupCenterTimer = setTimeout(() => centerPopupBlockVertically(layer), 80);
}

// Prova la Web Share API (mobile: apre il foglio di condivisione nativo),
// altrimenti copia negli appunti - stessa logica sia per "condividi
// questa vista" (InfoControl) che per "condividi questo tavolo" (popup),
// centralizzata qui per non duplicare il try/catch in due punti.
async function shareUrl(url, onCopied) {
  if (navigator.share) {
    try {
      await navigator.share({ title: document.title, url });
    } catch (error) {
      // L'utente ha annullato la condivisione - non e' un errore.
    }
    return;
  }
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(url);
    if (onCopied) onCopied();
  }
}

// Link diretto a un singolo tavolo: id (per riaprirne il popup al
// caricamento - vedi readStateFromUrl()) piu' lat/lng/zoom gia' centrati
// su di lui, cosi' chi apre il link lo vede sempre, indipendentemente
// dai filtri eventualmente attivi su chi lo ha condiviso (il link non li
// porta con se').
function buildShareTavoloUrl(id, [lng, lat]) {
  const params = new URLSearchParams();
  params.set("id", id);
  params.set("lat", lat.toFixed(5));
  params.set("lng", lng.toFixed(5));
  params.set("zoom", CLUSTER_DISABLE_ZOOM);
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

// Email precompilata per contribuire una foto: oggetto/corpo gia'
// riempiti col tavolo giusto (nome + link alla mappa, riusando
// buildShareTavoloUrl() - cosi' chi riceve la mail apre lo stesso link
// "condividi questo tavolo" e vede subito di quale si tratta) - la foto
// va allegata a mano, un mailto: non puo' portare un allegato (limite
// del protocollo, non aggirabile lato client).
function buildEmailUrl(properties, coordinates) {
  const subject = `Foto tavolo: ${properties.name}`;
  const mapUrl = buildShareTavoloUrl(properties.id, coordinates);
  const body = [
    `Vorrei contribuire alla mappa dei Tavoli da Ping Pong in Italia con una foto del tavolo "${properties.name}" e URL per visualizzarlo in mappa: ${mapUrl}`,
    "",
    "Dichiaro che la foto è mia o che ne detengo i diritti e ne autorizzo la pubblicazione sul sito.",
  ].join("\n");
  // encodeURIComponent, non URLSearchParams: un mailto: (RFC 6068) vuole
  // gli spazi percent-encoded (%20), non "+" come nella query string di
  // un URL http normale - alcuni client di posta trattano "+" alla
  // lettera invece che come spazio.
  return `mailto:${CONTRIB_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Bottone link esterno del popup (Maps/OSM/email): stile neutro
// condiviso, l'icona davanti al testo distingue le tre destinazioni
// invece di uno sfondo colorato per ciascuna (nessun hex "ufficiale" di
// brand certo da usare comunque, e le emoji sono coerenti con lo stile
// a icone gia' usato ovunque nell'app). target/rel solo sui link http:
// per un mailto: aprirebbero comunque il client di posta, ma target
// "_blank" puo' lasciare una scheda vuota aperta in alcuni browser.
function buildPopupLinkButton(url, icon, label) {
  const link = document.createElement("a");
  link.href = url;
  if (!url.startsWith("mailto:")) {
    link.target = "_blank";
    link.rel = "noopener";
  }
  link.className = "popup-link-btn";
  const iconEl = document.createElement("span");
  iconEl.textContent = icon;
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  link.append(iconEl, labelEl);
  return link;
}

function buildPopupContent(properties, coordinates, layer) {
  const container = document.createElement("div");
  container.className = "popup-content";

  const titleRow = document.createElement("div");
  titleRow.className = "popup-title-row";
  const title = document.createElement("h3");
  title.textContent = properties.name;
  titleRow.appendChild(title);

  if (properties.id && coordinates) {
    const shareButton = document.createElement("button");
    shareButton.type = "button";
    shareButton.className = "popup-share-btn";
    shareButton.innerHTML = SHARE_ICON_SVG;
    shareButton.setAttribute("aria-label", "Condividi questo tavolo");
    shareButton.addEventListener("click", () =>
      shareUrl(buildShareTavoloUrl(properties.id, coordinates), () => {
        shareButton.innerHTML = "✅";
        setTimeout(() => {
          shareButton.innerHTML = SHARE_ICON_SVG;
        }, 1500);
      })
    );
    titleRow.appendChild(shareButton);
  }

  container.appendChild(titleRow);

  for (const [key, label] of FILTERABLE_PROPERTIES) {
    if (properties[key] !== undefined) {
      addRow(container, label, properties[key]);
    }
  }

  for (const [key, value] of Object.entries(properties.extra || {})) {
    addRow(container, capitalize(key), value);
  }

  if (properties.maps_url) {
    container.appendChild(buildPopupLinkButton(properties.maps_url, "\u{1F4CD}", "Apri in Google Maps"));
  }

  if (properties.osm_url) {
    container.appendChild(buildPopupLinkButton(properties.osm_url, "\u{1F30D}", "Apri su OpenStreetMap"));
  }

  if (properties.id && coordinates) {
    container.appendChild(
      buildPopupLinkButton(buildEmailUrl(properties, coordinates), "\u{1F4E7}", "Invia foto via email")
    );
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
      img.addEventListener("load", () => scheduleCenterPopupBlock(layer));
      thumbs.appendChild(img);
    });
    container.appendChild(thumbs);
  }

  return container;
}

// Molti tavoli sono mappati in OSM come way (Polygon/LineString), non
// come node singoli - normalizzarli a Point qui (un centroide) prima di
// costruire i layer fa si' che ricevano la stessa icona ping-pong e
// finiscano nello stesso markerCluster (che si aspetta layer con
// getLatLng(), non Polygon/Polyline) dei tavoli puntuali, invece di
// apparire come contorni vettoriali non aggregati. Una semplice media
// dei vertici basta: sono geometrie piccole (il contorno di un tavolo),
// non serve un centroide pesato per area.
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

function applyFilters({ fitBounds = true } = {}) {
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
  // Disattivabile (fitBounds:false) solo per il primo caricamento quando
  // l'URL specifica gia' una vista precisa - non ha senso ricalcolarla.
  if (fitBounds && visibleLayers.length > 0) {
    const bounds = L.latLngBounds([]);
    visibleLayers.forEach((layer) => bounds.extend(layer.getLatLng()));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }
  syncUrl();
}

// Scrive vista corrente + filtri attivi nella query string, senza
// aggiungere voci alla cronologia (replaceState, non pushState) - cosi'
// l'URL nella barra degli indirizzi e' sempre lo stato copiabile/
// condivisibile corrente. Vedi anche il bottone "condividi" in InfoControl.
function syncUrl() {
  const params = new URLSearchParams();
  const center = map.getCenter();
  params.set("lat", center.lat.toFixed(5));
  params.set("lng", center.lng.toFixed(5));
  params.set("zoom", map.getZoom());
  for (const [key, value] of Object.entries(currentFilters)) {
    params.set(key, value);
  }
  history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
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

// Riga con icona + label + <select>, condivisa da tutte le sezioni del
// pannello filtri. onChange (opzionale) gira DOPO l'aggiornamento di
// currentFilters e PRIMA di applyFilters() - usato dalla cascata
// Regione <-> Provincia per ricalcolare le opzioni/selezioni senza far
// scattare applyFilters() due volte sullo stesso cambiamento.
function buildFilterRow(panel, key, label, icon, options, allLabel, onChange) {
  const row = L.DomUtil.create("div", "tt-filter-row", panel);
  const labelEl = L.DomUtil.create("label", "", row);
  const iconEl = L.DomUtil.create("span", "tt-filter-icon", labelEl);
  iconEl.textContent = icon;
  labelEl.append(label);
  const select = L.DomUtil.create("select", "", row);
  select.dataset.key = key;
  setSelectOptions(select, options, allLabel);
  // Pre-selezione da un filtro gia' impostato all'avvio (es. dall'URL
  // condiviso - vedi readStateFromUrl()): currentFilters e' gia' la
  // fonte di verita' a questo punto, qui si allinea solo la <select>.
  if (currentFilters[key] && options.includes(currentFilters[key])) {
    select.value = currentFilters[key];
  }

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

// Pulsante che azzera SEMPRE tutti i filtri (Zona + Filtri insieme),
// non solo quelli della sezione in cui si trova - un solo posto da
// premere per chi non ricorda cosa ha impostato e vuole ripartire da
// zero. Interroga il DOM (select[data-key]) invece dei singoli
// riferimenti alle <select> perche' viene chiamato da fuori dalle
// closure di FilterControl.onAdd().
function resetAllFilters(features) {
  for (const key of Object.keys(currentFilters)) delete currentFilters[key];
  document.querySelectorAll("select[data-key]").forEach((select) => {
    if (select.dataset.key === "provincia") {
      // La lista di Provincia puo' essere stata ristretta dalla cascata
      // di Regione - va rimessa completa, non basta svuotare il valore.
      setSelectOptions(select, deriveOptions(features, "provincia"), "Tutte");
    } else {
      select.value = "";
    }
  });
  applyFilters();
}

// Struttura "card flottante collassabile" (bottone toggle su mobile +
// pannello con intestazione + pulsante azzera) del pannello filtri
// unico. Icona ed etichetta sono <span> separati (non un'unica
// stringa) cosi' la media query mobile puo' nascondere solo la label
// nel toggle collassato, tenendo il pulsante piccolo, senza toccare il
// pannello espanso (dove la label resta, li' lo spazio non manca).
function buildFilterPanel(wrapper, icon, label, features) {
  const toggle = L.DomUtil.create("button", "tt-filters-toggle", wrapper);
  toggle.type = "button";
  L.DomUtil.create("span", "tt-panel-icon", toggle).textContent = icon;
  L.DomUtil.create("span", "tt-panel-label", toggle).textContent = label;
  L.DomUtil.create("span", "tt-result-badge tt-badge", toggle);

  const panel = L.DomUtil.create("div", "tt-filters", wrapper);
  const header = L.DomUtil.create("div", "tt-filters-header", panel);
  const heading = L.DomUtil.create("h4", "", header);
  heading.textContent = `${icon} ${label}`;

  const actions = L.DomUtil.create("div", "tt-filters-actions", header);
  const resetButton = L.DomUtil.create("button", "tt-filters-reset", actions);
  resetButton.type = "button";
  L.DomUtil.create("span", "tt-panel-icon", resetButton).textContent = "↺";
  L.DomUtil.create("span", "tt-panel-label", resetButton).textContent = "Azzera";
  resetButton.addEventListener("click", () => resetAllFilters(features));
  L.DomUtil.create("span", "tt-result-badge tt-badge", actions);

  toggle.addEventListener("click", () => panel.classList.toggle("open"));
  return panel;
}

function buildFilterSectionHeading(panel, title) {
  L.DomUtil.create("h5", "tt-filter-section", panel).textContent = title;
}

// Un unico box in alto a destra con due sezioni interne (Zona, poi
// Filtri) invece di due card separate: su mobile due toggle/popover
// indipendenti potevano aprirsi entrambi e sovrapporsi in modo confuso
// - un solo toggle/pannello elimina il problema alla radice, e da'
// anche un solo posto naturale per il pulsante "Azzera" (sopra).
const FilterControl = L.Control.extend({
  options: { position: "topright" },

  onAdd(mapInstance) {
    const wrapper = L.DomUtil.create("div", "tt-filters-wrapper");
    const features = this._features;
    const panel = buildFilterPanel(wrapper, "\u{1F50D}", "Filtri", features);

    // --- Zona: Regione e Provincia, cascata nei due versi -----------
    buildFilterSectionHeading(panel, "Zona");

    const provinceByRegione = new Map();
    const regioneByProvincia = new Map();
    for (const feature of features) {
      const { regione, provincia } = feature.properties;
      if (!regione || !provincia) continue;
      if (!provinceByRegione.has(regione)) provinceByRegione.set(regione, new Set());
      provinceByRegione.get(regione).add(provincia);
      regioneByProvincia.set(provincia, regione);
    }

    // Se l'URL condiviso specificava una Provincia ma non la Regione
    // corrispondente, derivarla subito cosi' le due select partono gia'
    // coerenti invece di aspettare la prima interazione dell'utente.
    if (currentFilters.provincia && !currentFilters.regione) {
      const inferredRegione = regioneByProvincia.get(currentFilters.provincia);
      if (inferredRegione) currentFilters.regione = inferredRegione;
    }

    const [REGIONE, PROVINCIA] = ZONE_PROPERTIES;
    let provinciaSelect;

    // Selezionare una Regione restringe le opzioni di Provincia a
    // quella regione (e deseleziona la Provincia se non piu' valida).
    const regioneSelect = buildFilterRow(
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

    // Se una Regione e' gia' impostata all'avvio (es. da URL condiviso),
    // le opzioni iniziali di Provincia partono gia' ristrette a quella
    // regione - altrimenti per un istante mostrerebbero l'elenco
    // completo prima che l'utente tocchi nulla.
    const initialRegione = currentFilters.regione;
    const initialProvinciaOptions =
      initialRegione && provinceByRegione.has(initialRegione)
        ? [...provinceByRegione.get(initialRegione)].sort()
        : deriveOptions(features, "provincia");

    // Verso opposto: selezionare direttamente una Provincia imposta la
    // Regione corrispondente, cosi' non resta mai un'incoerenza
    // invisibile (Provincia scelta ma Regione ancora su "Tutte" o su
    // un'altra regione, senza alcun effetto sulla mappa).
    provinciaSelect = buildFilterRow(
      panel,
      ...PROVINCIA,
      initialProvinciaOptions,
      "Tutte",
      (provincia) => {
        if (!provincia) return;
        const regione = regioneByProvincia.get(provincia);
        if (!regione || regioneSelect.value === regione) return;
        regioneSelect.value = regione;
        currentFilters.regione = regione;
        const options = [...(provinceByRegione.get(regione) || [])].sort();
        setSelectOptions(provinciaSelect, options, "Tutte");
        provinciaSelect.value = provincia;
      }
    );

    // --- Filtri: caratteristiche del tavolo --------------------------
    buildFilterSectionHeading(panel, "Caratteristiche");
    for (const [key, label, icon] of FILTERABLE_PROPERTIES) {
      buildFilterRow(panel, key, label, icon, deriveOptions(features, key), "Tutti");
    }

    L.DomEvent.disableClickPropagation(wrapper);
    L.DomEvent.disableScrollPropagation(wrapper);

    return wrapper;
  },
});

// Icona SVG inline (non un'emoji, resa incoerente tra piattaforme) per
// il bottone condividi - la classica icona "share" Material Design (tre
// pallini connessi da due linee), non la scatola-con-freccia che si usa
// di solito per "upload"/"esporta".
const SHARE_ICON_SVG = `
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
    <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/>
  </svg>
`;

// Titolo sempre visibile in alto a sinistra (sotto lo zoom, spostato in
// basso a destra - vedi sopra) + un bottone "i" che apre/chiude una
// breve descrizione del progetto, e un bottone condividi. Non dipende
// dai dati del geojson, quindi viene aggiunto alla mappa subito, non
// dentro il fetch().
const InfoControl = L.Control.extend({
  options: { position: "topleft" },

  onAdd() {
    const wrapper = L.DomUtil.create("div", "tt-info-wrapper");
    const card = L.DomUtil.create("div", "tt-info-card", wrapper);

    const header = L.DomUtil.create("div", "tt-info-header", card);
    const title = L.DomUtil.create("h1", "tt-info-title", header);
    // Icona ed etichetta separate come nel pannello filtri: su mobile
    // la media query nasconde solo l'etichetta, tenendo il titolo compatto.
    L.DomUtil.create("span", "tt-panel-icon", title).textContent = "\u{1F3D3}";
    L.DomUtil.create("span", "tt-panel-label", title).textContent = "Tavoli da Ping Pong in Italia";

    const infoToggle = L.DomUtil.create("button", "tt-info-toggle", header);
    infoToggle.type = "button";
    infoToggle.textContent = "\u{2139}\u{FE0F}";
    infoToggle.setAttribute("aria-label", "Informazioni su questa mappa");

    const shareButton = L.DomUtil.create("button", "tt-info-toggle", header);
    shareButton.type = "button";
    shareButton.innerHTML = SHARE_ICON_SVG;
    shareButton.setAttribute("aria-label", "Condividi questa vista");

    const body = L.DomUtil.create("div", "tt-info-body", card);
    body.innerHTML = `
      <p>Mappa dei tavoli da ping pong pubblici in Italia, con dati aperti
      da <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">OpenStreetMap</a>.</p>
      <p>Usa il pannello "Filtri" in alto a destra per restringere la
      mappa per regione/provincia o per caratteristiche del tavolo
      (materiale, rete, accesso, copertura); il pulsante "Azzera" lì
      dentro rimuove tutti i filtri attivi in un colpo solo.</p>
      <p>Manca un tavolo o un dato non è corretto? Si può
      <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">contribuire direttamente su OpenStreetMap</a> -
      questa mappa viene rigenerata periodicamente dai dati aggiornati.</p>
    `;

    infoToggle.addEventListener("click", () => body.classList.toggle("open"));

    // L'URL e' gia' sincronizzato in automatico (syncUrl()) ad ogni pan/
    // zoom/filtro, quindi qui basta condividere/copiare window.location
    // cosi' com'e' - nessun calcolo aggiuntivo al click.
    shareButton.addEventListener("click", () =>
      shareUrl(window.location.href, () => {
        shareButton.textContent = "✅";
        setTimeout(() => {
          shareButton.innerHTML = SHARE_ICON_SVG;
        }, 1500);
      })
    );

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

// Chiude il pannello filtri e la card informazioni al click fuori da
// essi - altrimenti su mobile l'unico modo per richiuderli e' ricliccare
// esattamente sul loro toggle, non ovvio per chi non l'ha aperto lui
// stesso. Va escluso esplicitamente ogni click dentro ai due wrapper
// (non basta L.DomEvent.disableClickPropagation(): per il 'click' usa
// un flag interno di Leaflet, controllato solo dal click handler della
// mappa - non e' un vero stopPropagation DOM, quindi l'evento arriva
// comunque fin qui e senza questo controllo richiuderebbe il pannello
// nello stesso click che lo ha appena aperto).
document.addEventListener("click", (event) => {
  if (event.target.closest(".tt-filters-wrapper, .tt-info-wrapper")) return;
  document
    .querySelectorAll(".tt-filters.open, .tt-info-body.open")
    .forEach((el) => el.classList.remove("open"));
});

// Load data

fetch(GEOJSON_URL)
  .then((response) => response.json())
  .then((data) => {
    for (const feature of data.features) {
      feature.geometry = toPointGeometry(feature.geometry);
    }
    const geoJsonLayer = L.geoJSON(data, {
      pointToLayer(feature, latlng) {
        return L.marker(latlng, { icon: pingPongIcon });
      },
      onEachFeature(feature, layer) {
        layer.bindPopup(() => buildPopupContent(feature.properties, feature.geometry.coordinates, layer), {
          maxWidth: 320,
          minWidth: 240,
          // autoPan nativo disattivato - la centratura orizzontale del
          // marker + verticale del blocco icona+popup (vedi
          // centerMarkerHorizontally()/centerPopupBlockVertically()
          // sopra) sostituisce interamente la logica di Leaflet basata
          // su margini dai bordi.
          autoPan: false,
        });
        layer.on("popupopen", () => {
          centerMarkerHorizontally(layer);
          scheduleCenterPopupBlock(layer);
        });
        markerCluster.addLayer(layer);
        markerEntries.push({ feature, layer });
      },
    });

    const filterControl = new FilterControl();
    filterControl._features = data.features;
    filterControl.addTo(map);

    // Se l'URL specificava gia' una vista precisa (link condiviso), non
    // sovrascriverla con il fitBounds automatico sui risultati filtrati.
    applyFilters({ fitBounds: !urlState.view });

    // Link "condividi questo tavolo" (vedi buildShareTavoloUrl()): riapre
    // subito il popup del tavolo in questione. La vista e' gia' quella
    // giusta (urlState.view, letta sopra) e i filtri del link sono
    // volutamente assenti, quindi il tavolo e' sempre visibile a
    // prescindere dai filtri di chi lo ha condiviso.
    if (urlState.id) {
      const entry = markerEntries.find((e) => e.feature.properties.id === urlState.id);
      if (entry) {
        // Se lo zoom richiesto (es. un vecchio link, o uno costruito a
        // mano) e' sotto la soglia a cui i cluster si sciolgono, il
        // marker potrebbe essere ancora dentro a un cluster: aprire un
        // popup su un marker cosi' fa scattare lo zoom-automatico-per-
        // rivelarlo di Leaflet.markercluster, la cui animazione interagisce
        // male con la centratura fatta al popupopen (vedi sopra) e in
        // certi casi il popup finisce mal posizionato e si richiude da
        // solo poco dopo. Forzare subito lo zoom minimo evita del tutto
        // quel percorso - animate:
        // false e' essenziale qui, non solo un dettaglio: uno zoom animato
        // (il default) lascerebbe la mappa a meta' transizione mentre la
        // riga successiva apre gia' il popup, ed e' proprio quella
        // sovrapposizione a produrre il comportamento descritto sopra.
        if (map.getZoom() < CLUSTER_DISABLE_ZOOM) {
          map.setZoom(CLUSTER_DISABLE_ZOOM, { animate: false });
        }
        entry.layer.openPopup();
      }
    }
  })
  .catch((error) => {
    console.error("Errore nel caricamento di", GEOJSON_URL, error);
  });
