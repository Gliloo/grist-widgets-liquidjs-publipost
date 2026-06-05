// Widget Grist Liquid simplifié - fonctionne avec 'read table'
// Pas de grist.docApi, pas de fetchTable, pas de getAccessToken
// Template lu depuis une colonne de la table courante via grist.onRecord

const engine = new liquidjs.Liquid({ jsTruthy: true });

let options = null;
let currentRecord = null;
let currentURL = null;
let previousHtml = "";
let refreshTimer = null;

const container = document.getElementById("container");
const settings = document.getElementById("settings");
const widgetWindow = container.contentWindow;

let lastScrollY = 0;
let lastScrollX = 0;
container.addEventListener("load", () => {
    widgetWindow.scrollTo(lastScrollX, lastScrollY);
});

// ── INIT GRIST ──────────────────────────────────────────────────────────────
grist.ready({
    onEditOptions: openConfig,
    requiredAccess: 'read table',
    allowSelectBy: true
});

// ── RÉCEPTION DES OPTIONS ───────────────────────────────────────────────────
grist.onOptions(opts => {
    options = opts || {};
    if (!options.templateColumnId) {
        openConfig();
    } else if (currentRecord) {
        render();
    }
});

// ── RÉCEPTION DU RECORD COURANT ─────────────────────────────────────────────
grist.onRecord(rec => {
    currentRecord = rec;
    if (!options) return;
    if (!options.templateColumnId) {
        openConfig();
    } else {
        render();
    }
}, { includeColumns: "all" });

// ── RENDU ───────────────────────────────────────────────────────────────────
async function render() {
    if (!currentRecord || !options || !options.templateColumnId) return;

    clearTimeout(refreshTimer);

    const templateColId = options.templateColumnId;
    const src = currentRecord[templateColId];

    if (!src || src === "") {
        showError("La colonne template est vide pour cet enregistrement.");
        return;
    }

    // Construire les données Liquid à partir du record brut
    const data = {};
    for (const [key, value] of Object.entries(currentRecord)) {
        if (key.startsWith("gristHelper_")) continue;
        if (Array.isArray(value) && value[0] === "D") {
            data[key] = new Date(value[1] * 1000);
        } else if (Array.isArray(value) && value[0] === "d") {
            data[key] = new Date(value[1] * 1000);
        } else if (typeof value === "number" && /date/i.test(key) && value > 0) {
            // Heuristique : colonne dont le nom contient "date" → timestamp Unix
            data[key] = new Date(value * 1000);
        } else {
            data[key] = value;
        }
    }

    let html;
    try {
        const parsed = engine.parse(src);
        html = await engine.render(parsed, data);
    } catch (e) {
        showError("Erreur Liquid : " + e.toString());
        return;
    }

    if (html === previousHtml) return;
    previousHtml = html;

    lastScrollY = widgetWindow.scrollY || 0;
    lastScrollX = widgetWindow.scrollX || 0;

    if (currentURL) URL.revokeObjectURL(currentURL);
    currentURL = URL.createObjectURL(new Blob([cleanUpHtml(html)], { type: "text/html" }));
    container.src = currentURL;
    container.style.display = "";
    settings.innerHTML = "";
    document.getElementById("print").style.display = "block";

    refreshTimer = setTimeout(() => render(), 5000);
}

// ── CONFIGURATION ───────────────────────────────────────────────────────────
async function openConfig() {
    clearTimeout(refreshTimer);
    previousHtml = "";
    document.getElementById("print").style.display = "none";
    container.style.display = "none";

    const currentColId = options?.templateColumnId || "";

    settings.innerHTML = `
        <div style="
            font-family: Arial, sans-serif;
            font-size: 13px;
            padding: 16px;
            max-width: 420px;
            color: #222;
        ">
            <h2 style="font-size:15px; margin-bottom:12px; color:#00308F;">
                ⚙️ Configuration du widget
            </h2>
            <p style="margin-bottom:8px; line-height:1.5;">
                Saisissez l'<strong>identifiant exact</strong> de la colonne Grist 
                qui contient votre template HTML/Liquid.<br>
                <em style="font-size:11px; color:#555;">
                    (Nom interne visible dans : Colonne → Options → Identifiant)
                </em>
            </p>
            <input
                id="col-id-input"
                type="text"
                value="${currentColId}"
                placeholder="ex: Template_convention"
                style="
                    width: 100%;
                    padding: 7px 10px;
                    border: 1px solid #aaa;
                    border-radius: 4px;
                    font-size: 13px;
                    box-sizing: border-box;
                    margin-bottom: 12px;
                "
            />
            <button
                onclick="saveConfig()"
                style="
                    background: #00308F;
                    color: white;
                    border: none;
                    padding: 8px 18px;
                    border-radius: 4px;
                    font-size: 13px;
                    cursor: pointer;
                "
            >
                Enregistrer
            </button>
            <p id="config-error" style="color:red; margin-top:8px; display:none;"></p>
        </div>
    `;
}

function saveConfig() {
    const val = document.getElementById("col-id-input").value.trim();
    if (!val) {
        document.getElementById("config-error").textContent = "Veuillez saisir un identifiant de colonne.";
        document.getElementById("config-error").style.display = "block";
        return;
    }
    grist.setOptions({ templateColumnId: val });
    options = { templateColumnId: val };
    if (currentRecord) render();
}

// ── UTILITAIRES ──────────────────────────────────────────────────────────────

function showError(msg) {
    if (currentURL) URL.revokeObjectURL(currentURL);
    const errorHtml = `<!doctype html><html><body style="font-family:Arial;color:red;padding:16px;">
        <strong>Erreur widget :</strong><br>${msg}
    </body></html>`;
    currentURL = URL.createObjectURL(new Blob([errorHtml], { type: "text/html" }));
    container.src = currentURL;
    container.style.display = "";
    settings.innerHTML = "";
}

function cleanUpHtml(input) {
    const body = (s) => /^<body[\s>]/i.test(s) ? s : `<body>${s}</body>`;
    const head = (s) => /^<head[\s>]/i.test(s) ? s : `<head><meta charset="utf-8"></head>${body(s)}`;
    const html = (s) => /^<html[\s>]/i.test(s) ? s : `<html>${head(s)}</html>`;
    const doctype = (s) => /^<!doctype/i.test(s) ? s : `<!doctype html>\n${html(s)}`;
    return doctype(input.trimStart());
}

function print() {
    container.contentWindow.print();
}
