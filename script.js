// Script for a Grist widget using Liquid templating
let options = null;
let record = null;
let records = null;
let src = "";
let previousHtml = "";
let template = undefined;
let cache;
let refreshTimer;
let tokenInfo;
let currentAccessLevel = 'read table';
const engine = new liquidjs.Liquid({
    outputEscape: "escape",
    jsTruthy: true,
});
let multiple = false;
let currentURL = null;
const container = document.getElementById("container");
const settings = document.getElementById("settings");
const widgetWindow = container.contentWindow;

let lastScrollY;
let lastScrollX;
container.addEventListener("load", () => {
    widgetWindow.scrollTo(lastScrollX, lastScrollY);
});

// On garde 'read table' pour que les editors puissent charger le widget
grist.ready({
    onEditOptions: openConfig,
    requiredAccess: 'read table',
    allowSelectBy: true
});

grist.onOptions((opts, interaction) => {
    if (interaction && interaction.access_level) {
        currentAccessLevel = interaction.access_level;
    }
});

window.addEventListener('message', async (event) => {
    if (event.source !== widgetWindow) return;
    switch (event.data.command) {
        case "select":
            grist.setCursorPos({ rowId: event.data.rowId });
            break;
        case "openCard":
            await grist.setCursorPos({ rowId: event.data.rowId });
            grist.commandApi.run('viewAsCard');
            break;
    }
});

grist.onRecords(throttle(async (recs) => {
    records = recs;
    if (multiple) {
        if (options.templateTableId === undefined) {
            cache = new CachedTables();
            await openConfig();
        } else {
            await render();
        }
    }
}, 200), { includeColumns: "all", expandRefs: false, keepEncoded: true });

grist.onRecord(throttle(async rec => {
    record = rec;
    if (!multiple) {
        if (options.templateColumnId === undefined) {
            cache = new CachedTables();
            await openConfig();
        } else {
            await render();
        }
    }
}, 200), { includeColumns: "normal", expandRefs: false, keepEncoded: true });

grist.onOptions(async opts => {
    options = opts || {};
    multiple = options.multiple;

    if ((multiple || options.templateFromOther) && options.templateTableId === undefined || !(multiple || options.templateFromOther) && options.templateColumnId === undefined) {
        cache = new CachedTables();
        await openConfig();
    } else if (record || records) {
        await render();
    }
});

async function render() {
    try {
        const templateFromOther = options.templateFromOther || multiple;
        document.getElementById("print").style.display = "block";
        cache = cache ? cache : new CachedTables();

        try {
            tokenInfo = tokenInfo || await grist.docApi.getAccessToken({ readOnly: true });
        } catch (e) {
            console.warn("Token non disponible :", e);
        }

        const tableId = await grist.selectedTable.getTableId();
        
        // 🛡️ SÉCURITÉ : Si Grist bloque la lecture du schéma, on utilise les données brutes
        let fields = [];
        try {
            fields = await cache.getFields(tableId);
        } catch (e) {
            console.warn("Grist bloque la lecture du schéma. Utilisation des données brutes de l'enregistrement.", e);
            const sourceData = multiple ? (records[0] || {}) : (record || {});
            fields = Object.keys(sourceData).map(key => ({
                colId: key,
                type: 'Any',
                id: key,
                label: key,
                widgetOptions: null
            }));
        }

        const colId = templateFromOther ? null : fields.find(t => t.id == options.templateColumnId)?.colId;
        
        let newSrc, templateRecord;
        if (templateFromOther) {
            [newSrc, templateRecord] = await getRefTemplate(options.templateTableId, options.templateId, options.templateColumnId);
        } else {
            const currentColData = record ? record[colId] : null;
            if (Array.isArray(currentColData) && currentColData[0] === "R") {
                [newSrc, templateRecord] = await getRefTemplate(currentColData[1], currentColData[2], options.templateRefColumnId);
            } else {
                [newSrc, templateRecord] = [currentColData, null];
            }
        }

        const data = multiple
            ? new RecordDrop({ records: records.map(rec => new RecordDrop(rec, fields, tokenInfo)) }, fields, tokenInfo)
            : new RecordDrop(record, fields, tokenInfo);

        if (templateRecord) {
            data._template = new RecordDrop(templateRecord, await cache.getFields(templateFromOther ? options.templateTableId : (record[colId] ? record[colId][1] : null)), tokenInfo);
        }

        if (src !== newSrc) {
            src = newSrc;
            try {
                template = { ok: engine.parse(src) };
            } catch (e) {
                template = { error: e.toString() };
            }
        }

        const html = template?.ok
            ? await engine.render(template.ok, data)
            : (template?.error ? `<p style="color:red;">Template Error: ${template.error}</p>` : "<p>En attente des données...</p>");

        if (html !== previousHtml) {
            lastScrollY = widgetWindow.scrollY;
            lastScrollX = widgetWindow.scrollX;

            if (currentURL) { URL.revokeObjectURL(currentURL); }
            currentURL = URL.createObjectURL(new Blob([cleanUpHtml(html)], { type: "text/html" }));
            container.src = currentURL;
            container.style.display = "";
            settings.innerHTML = "";
        }

        previousHtml = html;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => { cache = null; render() }, 3000);

    } catch (e) {
        console.error("Erreur critique de rendu :", e);
        settings.innerHTML = `
            <div style="padding: 16px; font-family: sans-serif; color: #555;">
                <p><strong>⚠️ Erreur d'affichage</strong></p>
                <p>Le widget n'a pas pu générer le contenu.</p>
                <p style="font-size: 0.9em; color: #888;">Détail : ${e.message || e}</p>
            </div>
        `;
        container.style.display = "none";
        document.getElementById("print").style.display = "none";
    }
}

function cleanUpHtml(input) {
    const body = (s) => /^<body[\s>]/i.test(s) ? s : `<body>${s}</body>`;
    const head = (s) => /^<head[\s>]/i.test(s) ? s : `<head><meta charset="utf-8"></head>${body(s)}`;
    const html = (s) => /^<html[\s>]/i.test(s) ? s : `<html>${head(s)}</html>`;
    const doctype = (s) => /^<!doctype/i.test(s) ? s : `<!doctype html>\n${html(s)}`;
    return doctype(input.trimStart());
}

async function openConfig(opts) {
    if (currentAccessLevel !== 'full') {
        settings.innerHTML = `
            <div style="padding: 16px; font-family: sans-serif; color: #555;">
                <p><strong>🔒 Configuration réservée aux administrateurs</strong></p>
                <p>La configuration du widget nécessite des droits complets sur le document.</p>
                <p>Le widget fonctionne normalement pour la visualisation et l'impression.</p>
                <p style="font-size: 0.9em; color: #888;">
                    Pour configurer ce widget, connectez-vous avec un compte ayant les droits complets.
                </p>
            </div>
        `;
        container.style.display = "none";
        document.getElementById("print").style.display = "none";
        return;
    }

    clearTimeout(refreshTimer);
    previousHtml = "";
    let colId = opts && "colId" in opts ? opts.colId : options?.templateColumnId;
    let labelId = opts && "labelId" in opts ? opts.labelId : options?.templateLabelColumnId;
    let other = opts && "templateFromOther" in opts ? opts.templateFromOther : options?.templateFromOther;
    document.getElementById("print").style.display = "none";
    const multipleConfig = opts && "multiple" in opts ? opts.multiple : multiple;
    const otherTable = other || multipleConfig;

    const tableId = otherTable ? (opts?.tid || options?.templateTableId) : await grist.selectedTable.getTableId();
    const tables = otherTable ? await cache.getTables() : null;

    const handlers = {};
    let out = `<div style="padding: 8px;"><fieldset><legend>Mode</legend>
  <div>
    <input type="radio" id="single" name="mode" value="single" onclick="setMultiple(false)" ${multipleConfig ? "" : "checked"} />
    <label for="single">Single record</label>
    <input type="radio" id="multiple" name="mode" value="multiple" onclick="setMultiple(true)" ${multipleConfig ? "checked" : ""}/>
    <label for="multiple">Record list</label>
  </div>
</fieldset>`;

    if (!multipleConfig) {
        out += `<fieldset><legend>Get template from:</legend>
            <p>
                <span><input type="radio" id="tplcol" name="tplsrc" ${other ? "" : "checked"} /><label for="tplcol">Column</label></span>
                <span><input type="radio" id="tpltbl" name="tplsrc" ${other ? "checked" : ""} /><label for="tpltbl">Other table</label></span>
            </p></fieldset>`;
        handlers["tplcol"] = ["click", () => setOther(opts, false)];
        handlers["tpltbl"] = ["click", () => setOther(opts, true)];
    }

    out += `<fieldset><legend>Template</legend>`;
    let cond = null;

    if (otherTable) {
        out += `<p>Table: <select id="template-table-id"><option value=""></option>` +
            Object.values(tables).map(table => `<option value="${table.id}" ${table.id === tableId ? "selected" : ""}>${table.tableId}</option>`).join("<br/>") +
            `</select></p>`;
        handlers["template-table-id"] = ["change", () => selectTemplatesTable(opts)];
    }

    if (!otherTable || tableId) {
        const fields = await cache.getFields(otherTable ? tables[tableId].tableId : tableId);
        const field = colId ? fields.find(t => t.id === colId) : undefined;

        out += `<p>Column: <select id="template-col-id"><option value=""></option>` +
            fields.filter(f => f.type === "Text" || (otherTable ? false : f.type.startsWith("Ref:"))).map(col => `<option value="${col.id}" ${col.id === colId ? "selected" : ""}>${col.label}</option>`).join("<br/>") +
            `</select></p>`;
        handlers["template-col-id"] = ["change", () => selectTemplateColumn(opts, otherTable ? tableId : null)];

        if (otherTable) {
            out += `<p>Label: <select id="template-label-id"><option value=""></option>` +
                fields.filter(f => f.type === "Text" && f.id !== colId).map(col => `<option value="${col.id}" ${col.id === labelId ? "selected" : ""}>${col.label}</option>`).join("<br/>") +
                `</select></p>`;
            handlers["template-label-id"] = ["change", () => selectLabelColumn(opts, tableId, colId)];
        } else {
            const fieldRef = field?.type.startsWith("Ref") ? field.type.slice(4) : null;
            const refFields = fieldRef ? await cache.getFields(fieldRef) : null;
            out += (refFields ?
                `<p>Code: <select id="template-ref-col-id"><option value=""></option>` +
                refFields.filter(f => f.type === "Text").map(col => `<option value="${col.id}" ${col.id === options?.templateRefColumnId ? "selected" : ""}>${col.label}</option>`).join("<br/>") +
                `</select></p>` : "");
            cond = {
                multiple: multipleConfig,
                templateFromOther: other,
                templateTableId: tableId,
                templateColumnId: colId,
                isRef: refFields ? true : false
            };
        }

        if (otherTable && colId && labelId) {
            const recordsData = await cache.getTable(tables[tableId].tableId);
            const fieldLabel = fields.find(f => f.id === labelId).colId;
            out += `<p>Template: <select id="template-id"><option value=""></option>` +
                recordsData.map(rec => `<option value="${rec.id}" ${rec.id === options?.templateId ? "selected" : ""}>${rec[fieldLabel]}</option>`).join("<br/>") +
                `</select></p>`;
            cond = {
                multiple: multipleConfig,
                templateFromOther: other,
                templateTableId: tableId,
                templateColumnId: colId,
                templateLabelColumnId: labelId
            };
        }
    }

    out += `</fieldset>`;
    out += `<p><button onclick="openConfig()">Revert</button> ` +
        `<button id="config-ok" ${cond ? "" : "disabled"}>Ok</button></p></div>`;
    settings.innerHTML = out;
    container.style.display = "none";
    for (const [id, [event, handler]] of Object.entries(handlers)) {
        document.getElementById(id).addEventListener(event, handler);
    }
    document.getElementById("config-ok").onclick = () => validateTemplate(cond);
}

function setMultiple(bool) {
    openConfig({ multiple: bool, allowSelectBy: document.getElementById("template-allow-select-by")?.checked });
}

function setOther(opts, bool) {
    openConfig({ ...opts, templateFromOther: bool });
}

function selectTemplatesTable(opts) {
    openConfig({ ...opts, tid: parseInt(document.getElementById("template-table-id").value) });
}

function selectTemplateColumn(opts, tid) {
    openConfig({ ...opts, tid, colId: parseInt(document.getElementById("template-col-id").value) });
}

function selectLabelColumn(opts, tid, colId) {
    openConfig({ ...opts, tid, colId, labelId: parseInt(document.getElementById("template-label-id").value) });
}

function validateTemplate(opts) {
    if (opts.multiple || opts.templateFromOther) {
        const templateId = parseInt(document.getElementById("template-id")?.value);
        if (!templateId) {
            alert("Please select a template.");
            return;
        }
        if (options.templateTableId !== opts.templateTableId || options.templateColumnId !== opts.templateColumnId || options.templateLabelColumnId !== opts.templateLabelColumnId || options.templateId !== templateId) {
            grist.setOptions({
                multiple: opts.multiple,
                templateFromOther: opts.templateFromOther,
                templateTableId: opts.templateTableId,
                templateColumnId: opts.templateColumnId,
                templateLabelColumnId: opts.templateLabelColumnId,
                templateId: templateId,
            });
        }
    } else {
        const templateRefColumnId = opts.isRef ? parseInt(document.getElementById("template-ref-col-id")?.value) : null;
        if (!opts.templateColumnId || (opts.isRef && !templateRefColumnId)) {
            alert("Please select a column.");
            return;
        }
        if (options.templateColumnId !== opts.templateColumnId || options.templateRefColumnId !== templateRefColumnId) {
            grist.setOptions({
                multiple: false,
                templateColumnId: opts.templateColumnId,
                templateRefColumnId: templateRefColumnId,
            });
        }
    }
    render();
}

async function getRefTemplate(tableId, rowId, templateRefColumnId) {
    const fields = await cache.getFields(tableId);
    const colId = fields.find(t => t.id === templateRefColumnId).colId;
    const table = await cache.getTable(tableId, true);
    const template = table.find(r => r.id === rowId);
    return [template[colId], template];
}

class CachedTables {
    #tables = null;
    #types = {};
    #tablesData = {};

    async getTables() {
        if (this.#tables) return this.#tables;
        const raw = await grist.docApi.fetchTable('_grist_Tables');
        this.#tables = Object.fromEntries(raw.id.map((id, i) =>
            [id, Object.fromEntries(Object.keys(raw).map(k => [k, raw[k][i]]))]
        ));
        return this.#tables;
    }

    async getFields(tableId) {
        if (this.#types[tableId]) return this.#types[tableId];
        let tid = tableId;
        if (typeof tableId === "string") {
            const tables = await this.getTables();
            tid = Object.values(tables).find(table => table.tableId === tableId).id;
        }
        const columns = await grist.docApi.fetchTable('_grist_Tables_column');
        const fields = Object.keys(columns);
        const colIndexes = columns.parentId.map((id, i) => [id, i]).filter(item => item[0] === tid).map(item => item[1]);

        this.#types[tableId] = colIndexes.map(index => {
            let t = Object.fromEntries(fields.map(f => [f, columns[f][index]]));
            t.widgetOptions = safeParse(t.widgetOptions);
            return t;
        });
        return this.#types[tableId];
    }

    async getTable(tableId) {
        if (typeof tableId === "number") {
            const tables = await this.getTables();
            tableId = tables[tableId].tableId;
        }
        if (this.#tablesData[tableId]) return this.#tablesData[tableId];
        const table = await grist.docApi.fetchTable(tableId);
        const fields = Object.keys(table);
        this.#tablesData[tableId] = table.id.map((_, i) => {
            let row = Object.fromEntries(fields.map(f => [f, table[f][i]]));
            return row;
        });
        return this.#tablesData[tableId];
    }
}

function safeParse(value) {
    try { return JSON.parse(value); } catch (err) { return null; }
}

class RecordDrop extends liquidjs.Drop {
    constructor(record, fields, tokenInfo) {
        super();
        if (fields) {
            this._ = Object.fromEntries(fields.map(f => {
                const opts = f.widgetOptions;
                if (opts) {
                    opts.styles = stylesFromOptions(opts);
                    opts.headerStyles = headerStylesFromOptions(opts);
                }
                return [f.colId, opts];
            }));
        } else {
            this._ = {};
        }

        for (const key of Object.keys(record).filter(k => !k.startsWith("gristHelper_"))) {
            let field = fields?.find(f => f.colId === key);
            let type = field?.type?.split(":")[0];
            let rules;
            if (field) {
                rules = field.rules?.slice(1).map(cid => fields.find(f => f.id === cid)).map(f => record[f.colId]);
            }
            switch (type) {
                case "Ref":
                    if (Array.isArray(record[key]) && record[key][0] == "R") {
                        const tableId = field?.type?.split(":")[1];
                        Object.defineProperty(this, key, { get: refGetter(tableId, record[key][2], tokenInfo) });
                    } else if (typeof record[key] === "number") {
                        const tableId = field?.type?.split(":")[1];
                        Object.defineProperty(this, key, { get: refGetter(tableId, record[key], tokenInfo) });
                    } else {
                        this[key] = record[key];
                    }
                    break;
                case "RefList":
                    if (Array.isArray(record[key]) && record[key][0] == "L") {
                        const tableId = field?.type?.split(":")[1];
                        Object.defineProperty(this, key, { get: refListGetter(tableId, record[key]?.slice(1), tokenInfo) });
                    } else if (typeof record[key] === "number") {
                        const tableId = field?.type?.split(":")[1];
                        Object.defineProperty(this, key, { get: refListGetter(tableId, record[key], tokenInfo) });
                    } else {
                        this[key] = record[key];
                    }
                    break;
                case "Attachments":
                    if (Array.isArray(record[key])) {
                        this[key] = record[key]?.slice(1).map(id => `${tokenInfo.baseUrl}/attachments/${id}/download?auth=${tokenInfo.token}`);
                    } else {
                        this[key] = record[key];
                    }
                    break;
                case "ChoiceList":
                    if (Array.isArray(record[key])) {
                        this[key] = record[key]?.slice(1).map(c => new ValueDrop(c, field?.widgetOptions?.choiceOptions?.[c], rules));
                    } else {
                        this[key] = record[key];
                    }
                    break;
                case "Choice":
                    this[key] = new ValueDrop(record[key], field?.widgetOptions?.choiceOptions?.[record[key]], rules);
                    break;
                default:
                    any(this, key, record[key], tokenInfo, field?.widgetOptions, rules);
            }
        }
    }
}

class DictDrop extends liquidjs.Drop {
    constructor(dict, tokenInfo) {
        super();
        for (const key of Object.keys(dict).filter(k => !k.startsWith("gristHelper_"))) {
            any(this, key, dict[key], tokenInfo);
        }
    }
}

class ValueDrop extends liquidjs.Drop {
    constructor(value, options, rules) {
        super();
        this.value = value;
        this._ = { ...options };
        if (options) {
            this._.styles = stylesFromOptions(options);
            this._.headerStyles = headerStylesFromOptions(options);
            if (rules) {
                this._.conditionalStyles = options.rulesOptions?.filter((_, idx) => rules[idx]).map(ropt => stylesFromOptions(ropt)).join();
            }
        }
    }
    valueOf() { return this.value; }
}

function stylesFromOptions(options) {
    return (options.alignment ? `text-align: ${options.alignment};` : "") +
        (options.textColor ? `color: ${options.textColor};` : "") +
        (options.fillColor ? `background-color: ${options.fillColor};` : "") +
        (options.fontBold ? `font-weight: bold;` : "") +
        (options.fontUnderline ? `text-decoration: underline;` : "") +
        (options.fontItalic ? `font-style: italic;` : "") +
        (options.fontStrikethrough ? `text-decoration-line: line-through;` : "");
}

function headerStylesFromOptions(options) {
    return (options.headerAlignment ? `text-align: ${options.headerAlignment};` : "") +
        (options.headerTextColor ? `color: ${options.headerTextColor};` : "") +
        (options.headerFillColor ? `background-color: ${options.headerFillColor};` : "") +
        (options.headerFontBold ? `font-weight: bold;` : "") +
        (options.headerFontUnderline ? `text-decoration: underline;` : "") +
        (options.headerFontItalic ? `font-style: italic;` : "") +
        (options.headerFontStrikethrough ? `text-decoration-line: line-through;` : "");
}

function any(o, key, data, tokenInfo, options, rules) {
    if (Array.isArray(data)) {
        switch (data[0]) {
            case 'L': o[key] = data?.slice(1); break;
            case 'O': o[key] = new DictDrop(data[1], tokenInfo); break;
            case 'D': o[key] = new Date(data[1] * 1000); break;
            case 'd': o[key] = new Date(data[1] * 1000); break;
            case 'R': Object.defineProperty(o, key, { get: refGetter(data[1], data[2]) }); break;
            case 'r': Object.defineProperty(o, key, { get: refListGetter(data[1], data[2], tokenInfo) }); break;
            default: o[key] = data;
        }
    } else {
        o[key] = new ValueDrop(data, options, rules);
    }
}

function refGetter(tableId, rowId) {
    let ref;
    return async function () {
        if (ref) return ref;
        const table = await cache.getTable(tableId);
        const fields = await cache.getFields(tableId);
        const row = table.find(r => r.id === rowId);
        if (!row) return null;
        ref = new RecordDrop(row, fields, tokenInfo);
        return ref;
    };
}

function refListGetter(tableId, ids, tokenInfo) {
    let refList;
    return async function () {
        if (refList) return refList;
        const table = await cache.getTable(tableId);
        const fields = await cache.getFields(tableId);
        refList = ids.map(rowId => {
            let row = table.find(r => r.id === rowId);
            return row ? new RecordDrop(row, fields, tokenInfo) : null;
        });
        return refList;
    };
}

function throttle(fn, delay) {
    let lastTime = 0;
    return function (...args) {
        const now = Date.now();
        if (now - lastTime >= delay) {
            fn.apply(this, args);
            lastTime = now;
        }
    };
}

function print() {
    container.contentWindow.print();
}
