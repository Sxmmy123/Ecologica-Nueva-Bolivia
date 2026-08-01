(function () {
  "use strict";

  const APP_ID = window.APP_SYNC_ID || "apk-asistencia-colegio";
  const DATABASE_ROOT = "sistemaEscolar";
  const PENDING_KEY = "__firebasePendingChanges";
  const LAST_SYNC_KEY = "__firebaseLastSyncAt";
  const LAST_PULL_KEY = "__firebaseLastPullAt";
  const STATUS_KEY = "__firebaseSyncStatus";
  const LAST_ERROR_KEY = "__firebaseLastError";
  const STRUCTURE_KEY = "__firebaseStructureVersion";
  const LOCAL_DIRTY_KEY = "__firebaseLocalDirtyAt";
  const PACKAGE_META_KEY = "__firebasePackageMeta";
  const DEVICE_ID_KEY = "__firebaseDeviceId";
  const ONLINE_ONLY_KEY = "__appOnlineOnlyVersion";
  const ONLINE_ONLY_VERSION = "online-v2-rtdb";
  const STRUCTURE_VERSION = "4";
  const RETRY_SYNC_DELAY = 30000;
  const DIRECTOR_STATS_KEY = "estadisticasDirector";
  const DIRECTOR_STATS_COLLECTION = "estadisticas_director";
  const DIRECTOR_STATS_SOURCE_KEYS = new Set(["alumnos", "actividades", "notas", "asistencias", "trimestresAsistencia"]);

  const META_KEYS = new Set([PENDING_KEY, LAST_SYNC_KEY, LAST_PULL_KEY, STATUS_KEY, STRUCTURE_KEY, LAST_ERROR_KEY, LOCAL_DIRTY_KEY, PACKAGE_META_KEY, DEVICE_ID_KEY, ONLINE_ONLY_KEY]);
  const KEY_ALIASES = { alumnosci: "alumnosCI" };

  const SINGLE_KEYS = {
    cursos: { collection: "sistema", doc: "cursos" },
    cursoColores: { collection: "sistema", doc: "curso_colores" },
    horasPrimaria: { collection: "sistema", doc: "horas_primaria" },
    director: { collection: "director", doc: "actual" },
    docentes: { collection: "docentes", doc: "todos" }
  };

  const COURSE_OBJECT_KEYS = {
    alumnos: "alumnos",
    notas: "notas",
    ser: "ser",
    serCriterios: "ser_criterios",
    autoevaluacion: "autoevaluacion",
    autoevaluacionConfig: "autoevaluacion_config"
  };

  const COURSE_ENTRY_KEYS = {
    asistencias: "asistencias",
    trimestresAsistencia: "trimestres_asistencia",
    asistenciaEdiciones: "asistencia_ediciones"
  };

  const TEACHER_SYNC_KEYS = [
    "docentes",
    "asistencias",
    "trimestresAsistencia",
    "asistenciaEdiciones",
    "actividades",
    "notas",
    "ser",
    "serCriterios",
    "autoevaluacion",
    "autoevaluacionConfig"
  ];

  const COURSE_STORAGE_PREFIXES = [
    { prefix: "horario_", collection: "horarios" },
    { prefix: "horarioDocente_", collection: "horarios_docente", normalizeCourse: false },
    { prefix: "materias_", collection: "materias" },
    { prefix: "materiasPersonalizadas_", collection: "materias_personalizadas" },
    { prefix: "materiaColores_", collection: "materia_colores" },
    { prefix: "materiasModo_", collection: "materias_modo" }
  ];

  const DEFAULT_COURSES = [
    "Pre Inicial - Inicial",
    "1.\u00ba de Primaria",
    "2.\u00ba de Primaria",
    "3.\u00ba de Primaria",
    "4.\u00ba de Primaria",
    "5.\u00ba de Primaria",
    "6.\u00ba de Primaria"
  ];

  const rawSetItem = localStorage.setItem.bind(localStorage);
  const rawGetItem = localStorage.getItem.bind(localStorage);
  const rawRemoveItem = localStorage.removeItem.bind(localStorage);
  let applyingRemote = false;
  let booting = true;
  let syncing = false;
  let syncTimer = null;
  const activeWrites = new Map();
  let lastInternetRequiredAlertAt = 0;
  let db = null;
  let baseRef = null;
  let legacyRef = null;
  let permissionBlocked = false;

  function canonicalKey(key) {
    const text = String(key || "");
    return KEY_ALIASES[text.toLowerCase()] || text;
  }

  function slug(text) {
    return String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/pre\s*inicial\s*[-–]\s*inicial/g, "pre_inicial_inicial")
      .replace(/1\s*\.?\s*º?\s*de\s*primaria/g, "1_primaria")
      .replace(/2\s*\.?\s*º?\s*de\s*primaria/g, "2_primaria")
      .replace(/3\s*\.?\s*º?\s*de\s*primaria/g, "3_primaria")
      .replace(/4\s*\.?\s*º?\s*de\s*primaria/g, "4_primaria")
      .replace(/5\s*\.?\s*º?\s*de\s*primaria/g, "5_primaria")
      .replace(/6\s*\.?\s*º?\s*de\s*primaria/g, "6_primaria")
      .replace(/primero\s*["']?a["']?/g, "1_primaria")
      .replace(/segundo\s*["']?a["']?/g, "2_primaria")
      .replace(/tercero\s*["']?a["']?/g, "3_primaria")
      .replace(/cuarto\s*["']?a["']?/g, "4_primaria")
      .replace(/quinto\s*["']?a["']?/g, "5_primaria")
      .replace(/sexto\s*["']?a["']?/g, "6_primaria")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "general";
  }

  function rtdbKey(text) {
    return String(text || "general").replace(/[.#$\[\]\/]/g, "_") || "general";
  }

  function parseJSON(raw, fallback) {
    try { return JSON.parse(raw ?? ""); }
    catch (error) { return fallback; }
  }

  function stringify(value) {
    return JSON.stringify(value ?? null);
  }

  function parseStoredValue(value, fallback) {
    if (typeof value === "string") return parseJSON(value, fallback);
    if (value === undefined || value === null) return fallback;
    return value;
  }

  function valueForDatabase(value) {
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (!text) return value;
    try { return JSON.parse(text); }
    catch (error) { return value; }
  }

  function valueForLocalStorage(value, fallback = "") {
    if (value === undefined || value === null) return typeof fallback === "string" ? fallback : stringify(fallback);
    return typeof value === "string" ? value : stringify(value);
  }

  function withoutUndefined(value) {
    if (Array.isArray(value)) return value.map(withoutUndefined);
    if (value && typeof value === "object") {
      return Object.entries(value).reduce((next, [key, item]) => {
        if (item !== undefined) next[key] = withoutUndefined(item);
        return next;
      }, {});
    }
    return value;
  }

  function dataForDatabase(data) {
    const next = { ...data };
    if (Object.prototype.hasOwnProperty.call(next, "value")) next.value = valueForDatabase(next.value);
    if (Object.prototype.hasOwnProperty.call(next, "activeIds")) next.activeIds = valueForDatabase(next.activeIds);
    return withoutUndefined(next);
  }

  function deviceId() {
    let id = rawGetItem(DEVICE_ID_KEY);
    if (!id) {
      id = `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      rawSetItem(DEVICE_ID_KEY, id);
    }
    return id;
  }

  function readPackageMeta() {
    const meta = parseJSON(rawGetItem(PACKAGE_META_KEY), {});
    return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  }

  function writePackageMeta(meta) {
    rawSetItem(PACKAGE_META_KEY, stringify(meta));
  }

  function packageUpdatedAt(key) {
    const meta = readPackageMeta()[canonicalKey(key)] || {};
    return Number(meta.updatedAt || 0);
  }

  function setPackageMeta(key, updatedAt, source = "local") {
    const normalized = canonicalKey(key);
    if (!normalized || !shouldSync(normalized)) return;
    const meta = readPackageMeta();
    const previous = meta[normalized] || {};
    const nextUpdatedAt = Math.max(Number(previous.updatedAt || 0), Number(updatedAt || Date.now()));
    meta[normalized] = {
      ...previous,
      updatedAt: nextUpdatedAt,
      source,
      role: currentRole() || previous.role || "",
      deviceId: deviceId()
    };
    writePackageMeta(meta);
  }

  function touchPackageMeta(key, updatedAt = Date.now()) {
    setPackageMeta(key, updatedAt, "local");
  }

  function normalizeCourseName(value) {
    const text = String(value || "")
      .replaceAll("\u00c2\u00ba", "\u00ba")
      .replaceAll("\u00ba", "\u00ba")
      .replaceAll("\u00e2\u20ac\u201c", "-")
      .replaceAll("\u2013", "-")
      .replace(/\s+/g, " ")
      .trim();
    const primaria = text.match(/^([1-6])\.\s*(?:\u00ba|o)?\s*de\s*Primaria$/i);
    if (primaria) return `${primaria[1]}.\u00ba de Primaria`;
    if (/^pre\s*inicial\s*-\s*inicial$/i.test(text)) return "Pre Inicial - Inicial";
    return text;
  }

  function mergeValues(current, incoming) {
    if (Array.isArray(current) || Array.isArray(incoming)) {
      return [...new Set([...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])])];
    }
    if (current && incoming && typeof current === "object" && typeof incoming === "object") {
      return { ...current, ...incoming };
    }
    return incoming ?? current;
  }

  function normalizeCourseObjectKey(storageKey, dirtyKeys) {
    const value = parseJSON(rawGetItem(storageKey), null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const next = {};
    let changed = false;
    Object.entries(value).forEach(([course, data]) => {
      const normalized = normalizeCourseName(course);
      if (normalized !== course) changed = true;
      next[normalized] = Object.prototype.hasOwnProperty.call(next, normalized) ? mergeValues(next[normalized], data) : data;
    });
    if (changed) {
      rawSetItem(storageKey, stringify(next));
      dirtyKeys.add(storageKey);
    }
  }

  function normalizeCourseEntryKey(storageKey, dirtyKeys) {
    const value = parseJSON(rawGetItem(storageKey), null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const next = {};
    let changed = false;
    Object.entries(value).forEach(([entryKey, data]) => {
      const parts = String(entryKey).split("|");
      if (parts.length >= 2) {
        const normalized = normalizeCourseName(parts[1]);
        if (normalized !== parts[1]) {
          parts[1] = normalized;
          changed = true;
        }
      }
      next[parts.join("|")] = data;
    });
    if (changed) {
      rawSetItem(storageKey, stringify(next));
      dirtyKeys.add(storageKey);
    }
  }

  function normalizeActivities(dirtyKeys) {
    const list = parseJSON(rawGetItem("actividades"), null);
    if (!Array.isArray(list)) return;
    let changed = false;
    const next = list.map(activity => {
      const normalized = normalizeCourseName(activity?.curso);
      if (normalized && normalized !== activity.curso) {
        changed = true;
        return { ...activity, curso: normalized };
      }
      return activity;
    });
    if (changed) {
      rawSetItem("actividades", stringify(next));
      dirtyKeys.add("actividades");
    }
  }



  function normalizeStudentRecord(item, course, alumnosCI, estados) {
    const nombre = typeof item === "string" ? item : String(item?.nombre || item?.name || "").trim();
    if (!nombre) return null;
    const ci = String((item && typeof item === "object" ? item.ci : "") || alumnosCI?.[course]?.[nombre] || "").trim();
    const activo = item && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, "activo")
      ? item.activo !== false
      : estados?.[course]?.[nombre] !== false;
    return { nombre, ci, activo };
  }

  function normalizeStudents(dirtyKeys) {
    const alumnos = parseJSON(rawGetItem("alumnos"), {});
    if (!alumnos || typeof alumnos !== "object" || Array.isArray(alumnos)) return;
    const alumnosCI = parseJSON(rawGetItem("alumnosCI"), {});
    const estados = parseJSON(rawGetItem("alumnosEstado"), {});
    let changed = rawGetItem("alumnosCI") !== null || rawGetItem("alumnosEstado") !== null;
    const next = {};

    Object.entries(alumnos).forEach(([courseRaw, list]) => {
      const course = normalizeCourseName(courseRaw);
      const seen = new Set();
      const source = Array.isArray(list) ? list : [];
      next[course] = source.map(item => normalizeStudentRecord(item, courseRaw, alumnosCI, estados))
        .filter(Boolean)
        .filter(item => {
          const key = (item.ci || item.nombre).toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      if (course !== courseRaw || stringify(source) !== stringify(next[course])) changed = true;
    });

    if (changed) {
      rawSetItem("alumnos", stringify(next));
      rawRemoveItem("alumnosCI");
      rawRemoveItem("alumnosEstado");
      dirtyKeys.add("alumnos");
    }
  }

  function normalizeTeachers(dirtyKeys) {
    const docentes = parseJSON(rawGetItem("docentes"), null);
    if (!Array.isArray(docentes)) return;
    let changed = false;
    const next = docentes.map(docente => {
      const copy = { ...docente };
      if (copy.curso) {
        const normalized = normalizeCourseName(copy.curso);
        if (normalized !== copy.curso) {
          copy.curso = normalized;
          changed = true;
        }
      }
      if (Array.isArray(copy.asignaciones)) {
        copy.asignaciones = copy.asignaciones.map(asig => {
          const normalized = normalizeCourseName(asig?.curso);
          if (normalized && normalized !== asig.curso) changed = true;
          return { ...asig, curso: normalized || asig.curso };
        });
      }
      return copy;
    });
    if (changed) {
      rawSetItem("docentes", stringify(next));
      dirtyKeys.add("docentes");
    }
  }

  function normalizePrefixedCourseKeys(dirtyKeys) {
    const pairs = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = canonicalKey(localStorage.key(i));
      const spec = COURSE_STORAGE_PREFIXES.find(item => key.startsWith(item.prefix));
      if (!spec) continue;
      if (spec.normalizeCourse === false) continue;
      const course = key.slice(spec.prefix.length);
      const normalized = normalizeCourseName(course);
      if (normalized && normalized !== course) pairs.push({ oldKey: key, newKey: `${spec.prefix}${normalized}` });
    }
    pairs.forEach(({ oldKey, newKey }) => {
      const oldValue = rawGetItem(oldKey);
      const newValue = rawGetItem(newKey);
      if (newValue === null) rawSetItem(newKey, oldValue);
      else {
        const merged = mergeValues(parseJSON(newValue, newValue), parseJSON(oldValue, oldValue));
        rawSetItem(newKey, typeof merged === "string" ? merged : stringify(merged));
      }
      rawRemoveItem(oldKey);
      dirtyKeys.add(newKey);
      dirtyKeys.add(oldKey);
    });
  }

  function normalizeCourseStorage(queueChanges = true) {
    const dirtyKeys = new Set();
    const cursos = parseJSON(rawGetItem("cursos"), []);
    if (Array.isArray(cursos)) {
      const normalized = [...new Set(cursos.map(normalizeCourseName).filter(Boolean))];
      if (stringify(cursos) !== stringify(normalized)) {
        rawSetItem("cursos", stringify(normalized));
        dirtyKeys.add("cursos");
      }
    }
    const selected = rawGetItem("cursoSeleccionado");
    const selectedNormalized = normalizeCourseName(selected);
    if (selected && selectedNormalized !== selected) rawSetItem("cursoSeleccionado", selectedNormalized);

    ["cursoColores", ...Object.keys(COURSE_OBJECT_KEYS)].forEach(key => normalizeCourseObjectKey(key, dirtyKeys));
    Object.keys(COURSE_ENTRY_KEYS).forEach(key => normalizeCourseEntryKey(key, dirtyKeys));
    normalizeActivities(dirtyKeys);
    normalizeStudents(dirtyKeys);
    normalizeTeachers(dirtyKeys);
    normalizePrefixedCourseKeys(dirtyKeys);

    if (queueChanges && dirtyKeys.size) {
      dirtyKeys.forEach(key => {
        if (shouldSync(key) && canWriteKey(key)) enqueueChange(key, rawGetItem(key), rawGetItem(key) === null ? "remove" : "set");
      });
    }
    return dirtyKeys.size > 0;
  }

  function timestampToMillis(value) {
    if (!value) return 0;
    if (typeof value === "number") return value;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.seconds === "number") return (value.seconds * 1000) + Math.floor((value.nanoseconds || 0) / 1000000);
    return Number(value) || 0;
  }

  function setStatus(status) {
    window.firebaseSyncStatus = status;
    try { rawSetItem(STATUS_KEY, stringify({ status, at: Date.now() })); }
    catch (error) {}
  }

  function setWorkMode(mode) {
    window.firebaseWorkMode = mode;
    try { rawSetItem("__firebaseWorkMode", stringify({ mode, at: Date.now() })); }
    catch (error) {}
  }

  function markLocalDirty(updatedAt = Date.now()) {
    try { rawSetItem(LOCAL_DIRTY_KEY, String(updatedAt)); }
    catch (error) {}
  }

  function hasUncompensatedLocalChanges() {
    const dirtyAt = Number(rawGetItem(LOCAL_DIRTY_KEY) || 0);
    const syncAt = Number(rawGetItem(LAST_SYNC_KEY) || 0);
    if (dirtyAt > syncAt) return true;
    return Object.values(readPackageMeta()).some(item => item?.source === "local" && Number(item.updatedAt || 0) > syncAt);
  }

  function setLastError(error, context = "") {
    const message = error?.message || String(error || "");
    const code = error?.code || "";
    window.firebaseSyncLastError = { context, code, message, at: Date.now() };
    try { rawSetItem(LAST_ERROR_KEY, stringify(window.firebaseSyncLastError)); }
    catch (storageError) {}
    if (code === "permission-denied" || /permission|permis/i.test(message)) {
      permissionBlocked = true;
      setStatus("sin-permisos-database");
    }
    console.error("Firebase sync error", context, code, message);
  }

  const firebaseStorage = window.FirebaseSchoolSyncStorage.create({
    canonicalKey,
    parseJSON,
    normalizeCourseName,
    stringify,
    rawGetItem,
    DEFAULT_COURSES,
    META_KEYS,
    SINGLE_KEYS,
    COURSE_OBJECT_KEYS,
    COURSE_ENTRY_KEYS,
    COURSE_STORAGE_PREFIXES
  });
  const {
    storageCourseKey,
    shouldSync,
    collectionNameForKey,
    knownCourses,
    groupObjectByCourse,
    groupEntriesByCourse
  } = firebaseStorage;

  const firebaseRoles = window.FirebaseSchoolSyncRoles.create({
    sessionStorage,
    canonicalKey,
    storageCourseKey,
    TEACHER_SYNC_KEYS
  });
  const {
    currentRole,
    isViewerRole,
    isAdminRole,
    isTeacherRole,
    adminOwnsKey,
    teacherOwnsKey,
    canWriteKey
  } = firebaseRoles;

  function resetLegacyLocalDataIfNeeded() {
    if (rawGetItem(ONLINE_ONLY_KEY) === ONLINE_ONLY_VERSION) return false;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const originalKey = localStorage.key(i);
      const key = canonicalKey(originalKey);
      if (shouldSync(key) || META_KEYS.has(key)) keys.push(originalKey);
    }
    keys.forEach(key => rawRemoveItem(key));
    rawSetItem(ONLINE_ONLY_KEY, ONLINE_ONLY_VERSION);
    rawSetItem(STRUCTURE_KEY, STRUCTURE_VERSION);
    setStatus("local-antiguo-limpiado");
    return true;
  }

  function canWriteNow(key) {
    if (!canWriteKey(key)) return false;
    if (!navigator.onLine) {
      notifyWriteBlocked("internet");
      return false;
    }
    if (permissionBlocked) {
      notifyWriteBlocked("permisos");
      return false;
    }
    return true;
  }

  function notifyWriteBlocked(reason = "internet") {
    const message = reason === "permisos"
      ? "No se puede guardar porque Firebase no tiene permisos de escritura."
      : "Conecte a internet para guardar. Este cambio no fue registrado.";
    setWorkMode(reason === "permisos" ? "sin-permisos-database" : "sin-internet-online");
    setStatus(reason === "permisos" ? "sin-permisos-database" : "sin-internet-no-guardado");
    showInternetRequired(message);
    window.dispatchEvent(new CustomEvent("firebaseWriteBlocked", { detail: { reason, message } }));
    const now = Date.now();
    if (now - lastInternetRequiredAlertAt > 2500) {
      lastInternetRequiredAlertAt = now;
    }
  }

  function showInternetRequired(message = "Conecte a internet para continuar.") {
    const render = () => {
      if (!document.body) return;
      let overlay = document.getElementById("internetRequiredOverlay");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "internetRequiredOverlay";
        overlay.style.cssText = "position:fixed;inset:0;z-index:3000;display:grid;place-items:center;background:rgba(6,22,38,.62);backdrop-filter:blur(5px);padding:20px;";
        overlay.innerHTML = `
          <div style="width:min(360px,100%);background:#fff;border:1px solid #dbe7ef;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.32);padding:24px;text-align:center;">
            <img src="images/logo-nueva-bolivia.png" alt="Unidad Educativa" style="width:104px;height:104px;object-fit:contain;border-radius:50%;margin-bottom:12px;box-shadow:0 10px 24px rgba(18,53,91,.18);">
            <h2 style="color:#12355b;font-size:1.35rem;font-weight:900;margin:0 0 8px;">Conecte a internet</h2>
            <p id="internetRequiredText" style="color:#526170;font-weight:800;margin:0 0 18px;">${message}</p>
            <button type="button" id="internetRequiredRetry" style="background:#12355b;border:0;border-radius:8px;color:#fff;font-weight:900;padding:10px 16px;width:100%;">Reintentar</button>
          </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector("#internetRequiredRetry").addEventListener("click", () => {
          if (navigator.onLine) overlay.remove();
          else showInternetRequired(message);
        });
      }
      const text = overlay.querySelector("#internetRequiredText");
      if (text) text.textContent = message;
      overlay.style.display = "grid";
    };
    if (document.body) render();
    else document.addEventListener("DOMContentLoaded", render, { once: true });
  }

  window.showInternetRequired = showInternetRequired;
  window.requireInternetForFirebase = function (message = "Conecte a internet para continuar.") {
    if (navigator.onLine) return true;
    notifyWriteBlocked("internet");
    showInternetRequired(message);
    return false;
  };

  function shouldBlockLocalWrite(key) {
    const normalized = canonicalKey(key);
    if (applyingRemote || !shouldSync(normalized) || !canWriteKey(normalized)) return false;
    if (!navigator.onLine) return "internet";
    if (permissionBlocked) return "permisos";
    return false;
  }

  function hasUsefulParsed(value) {
    if (Array.isArray(value)) return value.length > 0 && value.some(hasUsefulParsed);
    if (value && typeof value === "object") return Object.values(value).some(hasUsefulParsed);
    if (typeof value === "boolean") return true;
    if (typeof value === "number") return !Number.isNaN(value);
    return String(value ?? "").trim() !== "";
  }

  function hasUsefulValue(key, rawValue) {
    if (rawValue === null || rawValue === undefined || key === "cursos") return false;
    return hasUsefulParsed(parseJSON(rawValue, rawValue));
  }

  function hasUsefulLocalData() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = canonicalKey(localStorage.key(i));
      if (shouldSync(key) && hasUsefulValue(key, rawGetItem(key))) return true;
    }
    return false;
  }

  function hasUsefulTeacherLocalData() {
    return TEACHER_SYNC_KEYS.some(key => hasUsefulValue(key, rawGetItem(key)));
  }

  function hasLocalWorkBeforeLogin() {
    return readQueue().length > 0 || hasUncompensatedLocalChanges();
  }

  function readQueue() {
    const queue = parseJSON(rawGetItem(PENDING_KEY), []);
    return Array.isArray(queue) ? queue : [];
  }

  function writeQueue(queue) {
    if (!queue.length) rawRemoveItem(PENDING_KEY);
    else rawSetItem(PENDING_KEY, stringify(queue));
  }

  function mergeQueueByLatest(items) {
    const map = new Map();
    items.forEach(item => {
      const key = canonicalKey(item.key);
      const previous = map.get(key);
      if (!previous || Number(item.updatedAt || 0) >= Number(previous.updatedAt || 0)) {
        map.set(key, { ...item, key });
      }
    });
    return Array.from(map.values());
  }

  function pendingForKey(key) {
    const normalized = canonicalKey(key);
    return readQueue().some(item => canonicalKey(item.key) === normalized);
  }

  function enqueueChange(key, value, operation, updatedAt = Date.now()) {
    const normalized = canonicalKey(key);
    if (!shouldSync(normalized)) return;
    if (!canWriteNow(normalized)) return;
    writeOnlineChange({ key: normalized, value, operation, updatedAt });
  }

  localStorage.setItem = function (key, value) {
    const blocked = shouldBlockLocalWrite(key);
    if (blocked) {
      notifyWriteBlocked(blocked);
      return;
    }
    rawSetItem(key, value);
    if (!applyingRemote) {
      if (booting && document.readyState === "loading") return;
      enqueueChange(key, String(value), "set");
    }
  };

  localStorage.removeItem = function (key) {
    const blocked = shouldBlockLocalWrite(key);
    if (blocked) {
      notifyWriteBlocked(blocked);
      return;
    }
    rawRemoveItem(key);
    if (!applyingRemote) {
      if (booting && document.readyState === "loading") return;
      enqueueChange(key, null, "remove");
    }
  };

  function applyLocalValue(key, value, force = false, remoteUpdatedAt = 0) {
    const normalized = canonicalKey(key);
    if (!shouldSync(normalized)) return false;
    const current = rawGetItem(normalized);
    const localUpdatedAt = packageUpdatedAt(normalized);
    if (!force && pendingForKey(normalized) && hasUsefulValue(normalized, current)) return false;
    if (!force && remoteUpdatedAt && localUpdatedAt && localUpdatedAt > remoteUpdatedAt) return false;
    if (current === value) {
      if (remoteUpdatedAt && remoteUpdatedAt > localUpdatedAt) setPackageMeta(normalized, remoteUpdatedAt, "remote");
      return false;
    }
    applyingRemote = true;
    if (value === null) rawRemoveItem(normalized);
    else rawSetItem(normalized, String(value));
    applyingRemote = false;
    if (remoteUpdatedAt) setPackageMeta(normalized, remoteUpdatedAt, "remote");
    return true;
  }

  function mergeEntriesWithoutCourse(current, course) {
    const result = {};
    Object.entries(current || {}).forEach(([entryKey, value]) => {
      const parts = String(entryKey).split("|");
      if ((parts.length >= 2 ? parts[1] : "general") !== course) result[entryKey] = value;
    });
    return result;
  }

  function applyCoursePiece(key, course, value, mode, force = false) {
    const normalized = canonicalKey(key);
    if (!force && pendingForKey(normalized) && hasUsefulValue(normalized, rawGetItem(normalized))) return false;

    if (mode === "list") {
      const current = parseJSON(rawGetItem(normalized), []);
      const kept = Array.isArray(current) ? current.filter(item => (item?.curso || "general") !== course) : [];
      return applyLocalValue(normalized, stringify([...kept, ...(Array.isArray(value) ? value : [])]), true);
    }

    if (mode === "entries") {
      const current = parseJSON(rawGetItem(normalized), {});
      return applyLocalValue(normalized, stringify({ ...mergeEntriesWithoutCourse(current, course), ...(value || {}) }), true);
    }

    const current = parseJSON(rawGetItem(normalized), {});
    current[course] = value;
    return applyLocalValue(normalized, stringify(current), true);
  }

  function courseFromEntryKey(entryKey) {
    const parts = String(entryKey).split("|");
    return parts.length >= 2 ? parts[1] : "general";
  }

  const firebaseNotes = window.FirebaseSchoolSyncNotes.create({
    parseJSON,
    knownCourses,
    normalizeCourseName,
    slug,
    stringify
  });
  const {
    groupActivities,
    activityDocId,
    activityScopeId,
    recordsForActivities,
    noteDocId,
    noteScopeId,
    recordsForNotes
  } = firebaseNotes;

  const firebaseAttendance = window.FirebaseSchoolSyncAttendance.create({
    parseJSON,
    normalizeCourseName,
    slug,
    stringify
  });
  const {
    recordsForAttendance,
    recordsForAttendanceEdits
  } = firebaseAttendance;

  function recordsForItem(item) {
    const key = canonicalKey(item.key);
    const updatedAt = item.updatedAt || Date.now();
    const value = item.value;
    if (item.operation === "remove") {
      const collection = collectionNameForKey(key) || "sistema";
      return [{ collection, id: "todos", data: { key, operation: "remove", updatedAt } }];
    }

    if (SINGLE_KEYS[key]) {
      const spec = SINGLE_KEYS[key];
      return [{ collection: spec.collection, id: spec.doc, data: { key, value, operation: "set", updatedAt } }];
    }

    if (key === "actividades") return recordsForActivities(value, updatedAt);
    if (key === "notas") return recordsForNotes(value, updatedAt);
    if (key === "asistencias") return recordsForAttendance(value, updatedAt);
    if (key === "asistenciaEdiciones") return recordsForAttendanceEdits(value, updatedAt);

    if (COURSE_OBJECT_KEYS[key]) {
      return groupObjectByCourse(value).map(group => ({
        collection: COURSE_OBJECT_KEYS[key],
        id: slug(group.course),
        data: { key, course: group.course, value: stringify(group.value), operation: "set", updatedAt }
      }));
    }

    if (COURSE_ENTRY_KEYS[key]) {
      return groupEntriesByCourse(value).map(group => ({
        collection: COURSE_ENTRY_KEYS[key],
        id: slug(group.course),
        data: { key, course: group.course, value: stringify(group.value), operation: "set", updatedAt }
      }));
    }

    const storageKey = storageCourseKey(key);
    if (storageKey) {
      return [{
        collection: storageKey.collection,
        id: slug(storageKey.course),
        data: { key, course: storageKey.course, value, operation: "set", updatedAt }
      }];
    }

    return [];
  }


  const firebaseStats = window.FirebaseSchoolSyncStats.create({
    parseJSON,
    rawGetItem,
    normalizeCourseName,
    canonicalKey,
    stringify,
    slug,
    rtdbKey,
    deviceId,
    currentRole,
    isViewerRole,
    parseStoredValue,
    timestampToMillis,
    getBaseRef: () => baseRef,
    getFirebase: () => window.firebase,
    DIRECTOR_STATS_KEY,
    DIRECTOR_STATS_COLLECTION,
    DIRECTOR_STATS_SOURCE_KEYS
  });
  const {
    readLocalJSON,
    statsCourseNames,
    statsBuildCourse,
    statsCoursesForKey,
    writeDirectorStatsForKey,
    pullDirectorStats
  } = firebaseStats;

  async function initFirebase() {
    const cfg = window.firebaseConfig || {};
    if (!window.firebase || !window.firebase.database || !cfg.apiKey || !cfg.projectId || !cfg.databaseURL || String(cfg.apiKey).startsWith("PEGA_AQUI")) {
      setStatus("configuracion-pendiente");
      return false;
    }

    if (!firebase.apps.length) firebase.initializeApp(cfg);
    db = firebase.database();
    // Modo 100% online: Realtime Database es la fuente principal y no conserva cola offline propia.
    baseRef = db.ref(`${DATABASE_ROOT}/${rtdbKey(APP_ID)}/registros`);
    legacyRef = baseRef;
    return true;
  }

  async function deleteCollectionDocs(collectionName) {
    await baseRef.child(rtdbKey(collectionName)).remove();
  }

  async function deleteLegacyDocsForKey(key) {
    const ids = new Set([
      encodeURIComponent(key).replace(/\./g, "%2E"),
      slug(key),
      key === "alumnosCI" ? "alumnosci" : ""
    ].filter(Boolean));
    for (const id of ids) {
      try { await legacyRef.child(rtdbKey(id)).remove(); }
      catch (error) {}
    }
  }

  async function deleteLegacyCollection() {
    await legacyRef.remove();
  }

  function recordRef(record) {
    return baseRef.child(rtdbKey(record.collection)).child(rtdbKey(record.id));
  }

  async function writeItem(item) {
    const key = canonicalKey(item.key);
    if (!canWriteKey(key)) return;
    const records = recordsForItem({ ...item, key });
    let wrote = false;

    for (const record of records) {
      const docRef = recordRef(record);
      const localUpdatedAt = Number(record.data.updatedAt || item.updatedAt || Date.now());
      const remoteSnap = await docRef.once("value");
      const remoteData = remoteSnap.val() || {};
      const remoteUpdatedAt = Math.max(timestampToMillis(remoteData.updatedAt), timestampToMillis(remoteData.serverUpdatedAt));
      if (remoteUpdatedAt > localUpdatedAt) continue;

      await docRef.set({
        ...dataForDatabase(record.data),
        updatedAt: localUpdatedAt,
        deviceId: deviceId(),
        role: currentRole(),
        serverUpdatedAt: firebase.database.ServerValue.TIMESTAMP
      });
      wrote = true;
    }
    if (wrote) setPackageMeta(key, Number(item.updatedAt || Date.now()), "synced");
    return wrote;
  }

  function writeOnlineChange(item) {
    const key = canonicalKey(item.key);
    if (!shouldSync(key) || !canWriteKey(key)) return Promise.resolve(false);
    if (!navigator.onLine) {
      notifyWriteBlocked("internet");
      return Promise.resolve(false);
    }

    const task = (activeWrites.get(key) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (!baseRef && !(await initFirebase())) throw new Error("Firebase no esta listo para guardar.");
        setWorkMode(isTeacherRole() ? "docente-online" : "online");
        setStatus("guardando-database");
        const wrote = await writeItem({ ...item, key });
        if (wrote) await writeDirectorStatsForKey(key, item.updatedAt || Date.now()).catch(error => setLastError(error, "guardando estadisticas director"));
        rawSetItem(STRUCTURE_KEY, STRUCTURE_VERSION);
        rawSetItem(LAST_SYNC_KEY, String(Date.now()));
        rawRemoveItem(LOCAL_DIRTY_KEY);
        writeQueue([]);
        setStatus(wrote ? "guardado-database" : "sin-cambios-remotos");
        return wrote;
      })
      .catch(error => {
        setLastError(error, `guardando ${key}`);
        setWorkMode("error-online");
        setStatus("error-guardado-database");
        return false;
      });

    activeWrites.set(key, task);
    task.finally(() => {
      if (activeWrites.get(key) === task) activeWrites.delete(key);
    });
    return task;
  }

  function queueAllLocalData() {
    writeQueue([]);
    rawRemoveItem(LOCAL_DIRTY_KEY);
    return false;
  }

  function queueTeacherCompensationIfNeeded() {
    writeQueue([]);
    rawRemoveItem(LOCAL_DIRTY_KEY);
    return false;
  }

  function queueTeacherUsefulLocalDataIfQueueWasLost() {
    writeQueue([]);
    rawRemoveItem(LOCAL_DIRTY_KEY);
    return false;
  }

  async function syncNow() {
    if (syncing) return;
    if (permissionBlocked) {
      setStatus("sin-permisos-database");
      return;
    }
    if (isViewerRole()) {
      writeQueue([]);
      setStatus("solo-lectura");
      return;
    }
    if (!navigator.onLine || !baseRef) {
      setWorkMode("sin-internet-online");
      setStatus("sin-internet-no-guardado");
      return;
    }

    syncing = true;
    try {
      setStatus(activeWrites.size ? "guardando-database" : "online");
      if (activeWrites.size) await Promise.allSettled(Array.from(activeWrites.values()));
      writeQueue([]);
      rawSetItem(STRUCTURE_KEY, STRUCTURE_VERSION);
      rawSetItem(LAST_SYNC_KEY, String(Date.now()));
      rawRemoveItem(LOCAL_DIRTY_KEY);
      setStatus("online");
      setWorkMode(isTeacherRole() ? "docente-online" : "online");
    } finally {
      syncing = false;
    }
  }

  async function readCollection(collectionName) {
    const snapshot = await baseRef.child(rtdbKey(collectionName)).once("value");
    const data = snapshot.val() || {};
    return Object.entries(data).map(([id, value]) => ({ id, data: value || {} }));
  }

  function currentPageName() {
    const file = String(location.pathname || "").split(/[\\/]/).pop() || "index.html";
    return file.toLowerCase();
  }

  function sessionJSON(key, fallback) {
    return parseJSON(sessionStorage.getItem(key), fallback);
  }

  function teacherAssignmentsFromSession() {
    const usuario = sessionStorage.getItem("docenteUsuario") || "";
    const fromSession = sessionJSON("docenteAsignaciones", []);
    if (Array.isArray(fromSession) && fromSession.length) {
      return fromSession.map(asig => ({
        curso: normalizeCourseName(asig?.curso || ""),
        materias: Array.isArray(asig?.materias) ? [...new Set(asig.materias.filter(Boolean))] : []
      })).filter(asig => asig.curso && asig.materias.length);
    }

    const docentes = localJSON("docentes", []);
    const docente = Array.isArray(docentes) ? docentes.find(item => item?.usuario === usuario) : null;
    if (docente) return teacherAssignments(docente);

    const curso = normalizeCourseName(sessionStorage.getItem("docenteCurso") || "");
    const materias = sessionJSON("docenteMaterias", [sessionStorage.getItem("docenteMateria")].filter(Boolean));
    return curso && Array.isArray(materias) && materias.length ? [{ curso, materias }] : [];
  }

  function uniqueCoursesFromAssignments(assignments) {
    return [...new Set((assignments || []).map(asig => normalizeCourseName(asig.curso)).filter(Boolean))];
  }

  function pullScope() {
    const role = currentRole();
    const page = currentPageName();
    const login = !role && isLoginPage();
    const scope = {
      role,
      page,
      login,
      courses: null,
      assignments: [],
      studentName: "",
      singleKeys: new Set(Object.keys(SINGLE_KEYS)),
      courseObjectKeys: new Set(Object.keys(COURSE_OBJECT_KEYS)),
      courseEntryKeys: new Set(Object.keys(COURSE_ENTRY_KEYS)),
      includeNotes: true,
      includeActivities: true,
      includeStorage: true,
      storageCollections: null,
      includeDirectorStats: false
    };

    if (login) {
      scope.singleKeys = new Set(["cursos", "director", "docentes", "cursoColores"]);
      scope.courseObjectKeys = new Set(["alumnos"]);
      scope.courseEntryKeys = new Set();
      scope.includeNotes = false;
      scope.includeActivities = false;
      scope.includeStorage = false;
      scope.includeDirectorStats = false;
      return scope;
    }

    if (role === "admin") {
      scope.singleKeys = new Set(["cursos", "director", "docentes", "cursoColores", "horasPrimaria"]);
      scope.courseObjectKeys = new Set(["alumnos"]);
      scope.courseEntryKeys = new Set();
      scope.includeNotes = ["notas.html", "alumno.html", "reportes.html"].includes(page);
      scope.includeActivities = ["mes.html", "calificar.html", "alumno.html", "reportes.html"].includes(page);
      scope.includeStorage = true;
      scope.includeDirectorStats = ["reportes.html"].includes(page);
      scope.storageCollections = null;
      if (["dia.html", "reportes.html", "notas.html", "alumno.html"].includes(page)) {
        scope.courseEntryKeys = new Set(Object.keys(COURSE_ENTRY_KEYS));
      }
      if (scope.includeNotes || page === "notas.html") {
        Object.keys(COURSE_OBJECT_KEYS).forEach(key => scope.courseObjectKeys.add(key));
      }
      return scope;
    }

    if (role === "docente") {
      const assignments = teacherAssignmentsFromSession();
      const courses = uniqueCoursesFromAssignments(assignments);
      scope.assignments = assignments;
      scope.courses = courses.length ? courses : [];
      scope.singleKeys = new Set(["cursos", "docentes", "horasPrimaria"]);
      scope.courseObjectKeys = new Set(["alumnos", "notas", "ser", "serCriterios", "autoevaluacion", "autoevaluacionConfig"]);
      scope.courseEntryKeys = new Set(Object.keys(COURSE_ENTRY_KEYS));
      scope.includeNotes = true;
      scope.includeActivities = true;
      scope.includeStorage = true;
      scope.storageCollections = new Set(["horarios", "horarios_docente", "materias", "materias_personalizadas", "materia_colores", "materias_modo"]);
      return scope;
    }


    if (role === "director") {
      scope.singleKeys = new Set(["cursos", "cursoColores", "director"]);
      scope.includeDirectorStats = page === "reportes.html";
      scope.courseObjectKeys = new Set(["alumnos", "notas", "ser", "serCriterios", "autoevaluacion", "autoevaluacionConfig"]);
      scope.courseEntryKeys = new Set(Object.keys(COURSE_ENTRY_KEYS));
      scope.includeNotes = ["notas.html", "alumno.html", "reportes.html"].includes(page);
      scope.includeActivities = ["mes.html", "calificar.html", "alumno.html", "reportes.html"].includes(page);
      scope.includeStorage = true;
      scope.storageCollections = null;
      return scope;
    }

    if (role === "alumno") {
      const curso = normalizeCourseName(sessionStorage.getItem("alumnoCurso") || "");
      scope.courses = curso ? [curso] : [];
      scope.studentName = sessionStorage.getItem("alumnoNombre") || "";
      scope.singleKeys = new Set(["cursos", "cursoColores"]);
      scope.courseObjectKeys = new Set(["alumnos", "notas", "ser", "serCriterios", "autoevaluacion", "autoevaluacionConfig"]);
      scope.courseEntryKeys = new Set(Object.keys(COURSE_ENTRY_KEYS));
      scope.includeNotes = true;
      scope.includeActivities = true;
      scope.includeStorage = true;
      scope.storageCollections = new Set(["materias", "materia_colores"]);
      return scope;
    }

    return scope;
  }

  function courseAllowed(scope, courseRaw) {
    if (!scope?.courses) return true;
    const course = normalizeCourseName(courseRaw);
    return scope.courses.map(normalizeCourseName).includes(course);
  }

  function materiaAllowed(scope, courseRaw, materiaRaw) {
    if (!courseAllowed(scope, courseRaw)) return false;
    if (!scope?.assignments?.length) return true;
    const course = normalizeCourseName(courseRaw);
    const materia = String(materiaRaw || "");
    return scope.assignments.some(asig => normalizeCourseName(asig.curso) === course && (!materia || asig.materias.includes(materia)));
  }

  async function readCollectionByCourse(collectionName, courses) {
    if (!Array.isArray(courses) || !courses.length) return readCollection(collectionName);
    const rows = [];
    const seen = new Set();
    for (const course of courses.map(normalizeCourseName)) {
      const snapshot = await baseRef.child(rtdbKey(collectionName)).orderByChild("course").equalTo(course).once("value");
      const data = snapshot.val() || {};
      Object.entries(data).forEach(([id, value]) => {
        if (seen.has(id)) return;
        seen.add(id);
        rows.push({ id, data: value || {} });
      });
    }
    return rows;
  }

  async function readCollectionByStudent(collectionName, studentName) {
    const name = String(studentName || "");
    if (!name) return readCollection(collectionName);
    const snapshot = await baseRef.child(rtdbKey(collectionName)).orderByChild("alumno").equalTo(name).once("value");
    const data = snapshot.val() || {};
    return Object.entries(data).map(([id, value]) => ({ id, data: value || {} }));
  }

  async function readCourseDocuments(collectionName, courses) {
    if (!Array.isArray(courses) || !courses.length) return readCollection(collectionName);
    const rows = [];
    const seen = new Set();
    for (const course of courses.map(normalizeCourseName)) {
      const id = slug(course);
      const snapshot = await baseRef.child(rtdbKey(collectionName)).child(rtdbKey(id)).once("value");
      if (!snapshot.exists() || seen.has(id)) continue;
      seen.add(id);
      rows.push({ id, data: snapshot.val() || {} });
    }
    return rows;
  }

  async function pullSingles(next, keys = null) {
    for (const [key, spec] of Object.entries(SINGLE_KEYS)) {
      if (keys && !keys.has(key)) continue;
      const snapshot = await baseRef.child(rtdbKey(spec.collection)).child(rtdbKey(spec.doc)).once("value");
      if (snapshot.exists()) {
        const data = snapshot.val() || {};
        next[key] = {
          value: valueForLocalStorage(data.value, ""),
          updatedAt: Math.max(timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt))
        };
      }
    }
  }

  async function pullCourseObject(next, key, collectionName, scope = null) {
    const docs = await readCourseDocuments(collectionName, scope?.courses || null);
    if (!docs.length) return;
    const obj = {};
    let updatedAt = 0;
    docs.forEach(({ data, id }) => {
      const course = normalizeCourseName(data.course || id);
      if (!courseAllowed(scope, course)) return;
      obj[course] = parseStoredValue(data.value, {});
      updatedAt = Math.max(updatedAt, timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt));
    });
    if (Object.keys(obj).length) next[key] = { value: stringify(obj), updatedAt };
  }

  async function pullDetailedNotes(next, scope = null) {
    const detailDocs = await readCollectionByCourse("notas_detalle", scope?.courses || null);
    if (!detailDocs.length) return false;
    const indexDocs = await readCollectionByCourse("notas_index", scope?.courses || null);
    const activeByScope = {};
    indexDocs.forEach(({ data }) => {
      if (!materiaAllowed(scope, data.course, data.materia)) return;
      activeByScope[data.scopeId] = new Set(parseStoredValue(data.activeIds, []));
    });

    const current = parseJSON(next.notas?.value, {});
    const notes = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    let updatedAt = Number(next.notas?.updatedAt || 0);

    detailDocs.forEach(({ id, data }) => {
      const course = normalizeCourseName(data.course || "general");
      const materia = data.materia || "Sin materia";
      if (!materiaAllowed(scope, course, materia)) return;
      const scopeId = data.scopeId || noteScopeId(course, data.trimestre, materia);
      if (activeByScope[scopeId] && !activeByScope[scopeId].has(id)) return;
      const trimestre = data.trimestre || "1er Trimestre";
      const titulo = data.titulo || "Sin titulo";
      if (!notes[course]) notes[course] = {};
      if (!notes[course][trimestre]) notes[course][trimestre] = {};
      if (!notes[course][trimestre][materia]) notes[course][trimestre][materia] = {};
      notes[course][trimestre][materia][titulo] = parseStoredValue(data.value, {});
      updatedAt = Math.max(updatedAt, timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt));
    });

    indexDocs.forEach(({ data }) => {
      const course = normalizeCourseName(data.course || "general");
      const trimestre = data.trimestre || "1er Trimestre";
      const materia = data.materia || "Sin materia";
      if (!materiaAllowed(scope, course, materia)) return;
      const activeIds = activeByScope[data.scopeId] || new Set();
      if (!notes?.[course]?.[trimestre]?.[materia]) return;
      Object.keys(notes[course][trimestre][materia]).forEach(titulo => {
        if (!activeIds.has(noteDocId(course, trimestre, materia, titulo))) delete notes[course][trimestre][materia][titulo];
      });
      if (!Object.keys(notes[course][trimestre][materia]).length) delete notes[course][trimestre][materia];
      if (notes[course][trimestre] && !Object.keys(notes[course][trimestre]).length) delete notes[course][trimestre];
      if (notes[course] && !Object.keys(notes[course]).length) delete notes[course];
      updatedAt = Math.max(updatedAt, timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt));
    });

    next.notas = { value: stringify(notes), updatedAt };
    return true;
  }

  async function pullCourseEntries(next, key, collectionName, scope = null) {
    const docs = await readCourseDocuments(collectionName, scope?.courses || null);
    const obj = {};
    let updatedAt = 0;
    docs.forEach(({ data }) => {
      if (!courseAllowed(scope, data.course)) return;
      Object.assign(obj, parseStoredValue(data.value, {}));
      updatedAt = Math.max(updatedAt, timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt));
    });

    if (key === "asistencias") {
      const detailDocs = scope?.studentName
        ? await readCollectionByStudent("asistencias_alumno", scope.studentName)
        : await readCollectionByCourse("asistencias_alumno", scope?.courses || null);
      detailDocs.forEach(({ data }) => {
        if (!courseAllowed(scope, data.course)) return;
        if (scope?.studentName && data.alumno !== scope.studentName) return;
        const entryKey = data.entryKey || [data.fecha, data.course, data.alumno].join("|");
        obj[entryKey] = data.value || "blanco";
        updatedAt = Math.max(updatedAt, timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt));
      });
    }

    if (key === "asistenciaEdiciones") {
      const detailDocs = await readCollectionByCourse("asistencia_ediciones_detalle", scope?.courses || null);
      detailDocs.forEach(({ data }) => {
        if (!courseAllowed(scope, data.course)) return;
        const entryKey = data.entryKey || [data.fecha, data.course].join("|");
        obj[entryKey] = parseStoredValue(data.value, []);
        updatedAt = Math.max(updatedAt, timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt));
      });
    }

    if (!docs.length && !Object.keys(obj).length) return;
    next[key] = { value: stringify(obj), updatedAt };
  }

  async function pullActivities(next, scope = null) {
    const detailDocs = await readCollectionByCourse("actividades_detalle", scope?.courses || null);
    if (detailDocs.length) {
      const indexDocs = await readCollectionByCourse("actividades_index", scope?.courses || null);
      const activeByScope = {};
      indexDocs.forEach(({ data }) => {
        if (!materiaAllowed(scope, data.course, data.materia)) return;
        activeByScope[data.scopeId] = new Set(parseStoredValue(data.activeIds, []));
      });
      const activities = [];
      let updatedAt = 0;
      detailDocs.forEach(({ id, data }) => {
        const activity = parseStoredValue(data.value, null);
        const course = normalizeCourseName(data.course || activity?.curso || "general");
        const materia = data.materia || activity?.materia || "";
        if (!materiaAllowed(scope, course, materia)) return;
        const scopeId = data.scopeId || activityScopeId(activity || {});
        if (activeByScope[scopeId] && !activeByScope[scopeId].has(id)) return;
        if (activity) activities.push({ ...activity, curso: course });
        updatedAt = Math.max(updatedAt, timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt));
      });
      next.actividades = { value: stringify(activities), updatedAt };
      return;
    }

    if (!scope?.courses) {
      const full = await baseRef.child("actividades").child("todos").once("value");
      if (full.exists()) {
        const data = full.val() || {};
        next.actividades = {
          value: valueForLocalStorage(data.value, []),
          updatedAt: Math.max(timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt))
        };
        return;
      }
    }

    const hacer = await readCollectionByCourse("hacer", scope?.courses || null);
    const saber = await readCollectionByCourse("saber", scope?.courses || null);
    const activities = [];
    let updatedAt = 0;
    [...hacer, ...saber].forEach(({ data }) => {
      if (!materiaAllowed(scope, data.course, data.materia)) return;
      const list = parseStoredValue(data.value, []);
      if (Array.isArray(list)) activities.push(...list.filter(item => materiaAllowed(scope, item?.curso, item?.materia)));
      updatedAt = Math.max(updatedAt, timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt));
    });
    if (hacer.length || saber.length) next.actividades = { value: stringify(activities), updatedAt };
  }

  async function pullStorageCourse(next, prefix, collectionName, scope = null) {
    if (scope?.storageCollections && !scope.storageCollections.has(collectionName)) return;
    if (collectionName === "horarios_docente" && isTeacherRole()) {
      const usuario = sessionStorage.getItem("docenteUsuario") || "";
      if (!usuario) return;
      const snapshot = await baseRef.child(rtdbKey(collectionName)).child(rtdbKey(slug(usuario))).once("value");
      if (!snapshot.exists()) return;
      const data = snapshot.val() || {};
      next[prefix + usuario] = {
        value: valueForLocalStorage(data.value, ""),
        updatedAt: Math.max(timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt))
      };
      return;
    }

    const courseLimited = collectionName !== "horarios_docente" ? scope?.courses : null;
    const docs = await readCourseDocuments(collectionName, courseLimited || null);
    docs.forEach(({ data, id }) => {
      const course = data.course || id;
      if (courseLimited && !courseAllowed(scope, course)) return;
      next[prefix + course] = {
        value: valueForLocalStorage(data.value, ""),
        updatedAt: Math.max(timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt))
      };
    });
  }

  async function pullStructured(force) {
    const scope = pullScope();
    const next = {};
    await pullSingles(next, scope.singleKeys);
    for (const [key, collection] of Object.entries(COURSE_OBJECT_KEYS)) {
      if (!scope.courseObjectKeys.has(key)) continue;
      await pullCourseObject(next, key, collection, scope);
    }
    if (scope.includeNotes) await pullDetailedNotes(next, scope);
    for (const [key, collection] of Object.entries(COURSE_ENTRY_KEYS)) {
      if (!scope.courseEntryKeys.has(key)) continue;
      await pullCourseEntries(next, key, collection, scope);
    }
    if (scope.includeActivities) await pullActivities(next, scope);
    if (scope.includeDirectorStats) await pullDirectorStats(next);
    if (scope.includeStorage) {
      for (const spec of COURSE_STORAGE_PREFIXES) await pullStorageCourse(next, spec.prefix, spec.collection, scope);
    }

    let changed = false;
    Object.entries(next).forEach(([key, record]) => {
      const value = record && typeof record === "object" && Object.prototype.hasOwnProperty.call(record, "value") ? record.value : record;
      const updatedAt = record && typeof record === "object" ? Number(record.updatedAt || 0) : 0;
      if (applyLocalValue(key, value, force, updatedAt)) changed = true;
    });
    return changed;
  }

  function applyLegacyRecord(data, force) {
    const key = canonicalKey(data.key || "");
    if (!key || !shouldSync(key)) return false;
    const value = data.operation === "remove" ? null : valueForLocalStorage(data.value, "");

    if (data.scope === "course") return applyCoursePiece(key, data.course || "general", parseJSON(value, {}), "object", force);
    if (data.scope === "course-list") return applyCoursePiece(key, data.course || "general", parseJSON(value, []), "list", force);
    if (data.scope === "course-entries") return applyCoursePiece(key, data.course || "general", parseJSON(value, {}), "entries", force);
    return applyLocalValue(key, value, force, Math.max(timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt)));
  }

  async function pullLegacy(force) {
    const snapshot = await legacyRef.once("value");
    const records = snapshot.val() || {};
    let changed = false;
    Object.entries(records).forEach(([id, data]) => {
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      if (!data.key && !Object.prototype.hasOwnProperty.call(data, "value")) return;
      if (!data.key) data.key = canonicalKey(decodeURIComponent(id));
      if (applyLegacyRecord(data, force)) changed = true;
    });
    return changed;
  }

  async function pullRemoteOnStart() {
    if (!navigator.onLine || !baseRef || permissionBlocked) return false;
    resetLegacyLocalDataIfNeeded();
    writeQueue([]);
    rawRemoveItem(LOCAL_DIRTY_KEY);
    try {
      setStatus("descargando");
      const force = true;
      const legacyChanged = false;
      const structuredChanged = await pullStructured(force);
      const normalizedChanged = normalizeCourseStorage(!isViewerRole());
      const changed = legacyChanged || structuredChanged || normalizedChanged;
      if (changed) {
        rawSetItem(LAST_PULL_KEY, String(Date.now()));
        setStatus("datos-descargados");
        notifyDataUpdated(true);
      }
      return changed;
    } catch (error) {
      setLastError(error, "descargando database");
      return false;
    }
  }

  function migrateLocalIfNeeded() {
    writeQueue([]);
    rawRemoveItem(LOCAL_DIRTY_KEY);
  }

  function isLoginPage() {
    const path = String(location.pathname || "").toLowerCase();
    return path.endsWith("/index.html") || path.endsWith("\\index.html") || path === "/" || path === "";
  }

  function reloadPageOnceAfterPull() {
    if (isLoginPage()) return;
    const key = "__firebaseInitialReloaded:v3:" + location.pathname;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    setTimeout(() => location.reload(), 150);
  }

  function notifyDataUpdated(allowReload = false) {
    window.dispatchEvent(new CustomEvent("firebaseDataUpdated"));
    if (typeof window.firebaseAfterDataUpdated === "function") {
      try { window.firebaseAfterDataUpdated(); }
      catch (error) { console.info("No se pudo actualizar la vista tras Firebase:", error.message); }
    }
    if (allowReload) reloadPageOnceAfterPull();
  }

  function scheduleSync(delay = null) {
    if (permissionBlocked) {
      setStatus("sin-permisos-database");
      return;
    }
    if (isViewerRole()) {
      setStatus("solo-lectura");
      return;
    }
    if (!navigator.onLine) {
      setWorkMode("sin-internet-online");
      setStatus("sin-internet-no-guardado");
      return;
    }
    setWorkMode(isTeacherRole() ? "docente-online" : "online");
    clearTimeout(syncTimer);
    const wait = delay === null ? 900 : delay;
    syncTimer = setTimeout(syncNow, wait);
  }


  function localJSON(key, fallback) {
    return parseJSON(rawGetItem(key), fallback);
  }

  function teacherScheduleKey(usuario) {
    return `horarioDocente_${String(usuario || "").trim()}`;
  }

  function teacherAssignments(docente) {
    if (Array.isArray(docente?.asignaciones) && docente.asignaciones.length) {
      return docente.asignaciones.map(asig => ({
        curso: normalizeCourseName(asig.curso),
        materias: Array.isArray(asig.materias) ? [...new Set(asig.materias.filter(Boolean))] : []
      })).filter(asig => asig.curso && asig.materias.length);
    }
    const materias = Array.isArray(docente?.materias) && docente.materias.length
      ? docente.materias
      : [docente?.materia].filter(Boolean);
    return docente?.curso && materias.length ? [{ curso: normalizeCourseName(docente.curso), materias }] : [];
  }

  function buildTeacherSchedule(docente) {
    const asignaciones = teacherAssignments(docente);
    const dias = ["lunes", "martes", "miercoles", "jueves", "viernes"];
    const horarios = asignaciones.map(asig => {
      const materias = new Set(asig.materias || []);
      const horarioCurso = localJSON(`horario_${asig.curso}`, []);
      const filas = Array.isArray(horarioCurso) ? horarioCurso.map(fila => {
        const next = {
          periodo: fila?.periodo || "",
          hora: fila?.hora || "",
          recreo: Boolean(fila?.recreo)
        };
        let tieneMateria = false;
        dias.forEach(dia => {
          const materia = fila?.[dia] || "";
          next[dia] = materias.has(materia) ? materia : "";
          if (next[dia]) tieneMateria = true;
        });
        return tieneMateria || next.recreo ? next : null;
      }).filter(Boolean) : [];
      return { curso: asig.curso, materias: [...materias], filas };
    });

    return {
      usuario: docente?.usuario || "",
      nombre: docente?.nombre || "",
      activo: docente?.activo !== false,
      actualizadoEn: Date.now(),
      asignaciones,
      horarios
    };
  }

  window.rebuildTeacherSchedules = function (docentesArg = null) {
    const docentes = Array.isArray(docentesArg) ? docentesArg : localJSON("docentes", []);
    if (!Array.isArray(docentes)) return false;
    const activeKeys = new Set();
    docentes.forEach(docente => {
      if (!docente?.usuario) return;
      const key = teacherScheduleKey(docente.usuario);
      if (docente.activo === false) {
        localStorage.removeItem(key);
        return;
      }
      activeKeys.add(key);
      localStorage.setItem(key, stringify(buildTeacherSchedule(docente)));
    });
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith("horarioDocente_") && !activeKeys.has(key)) localStorage.removeItem(key);
    }
    return true;
  };

  window.getPreparedTeacherSchedule = function (usuario) {
    return localJSON(teacherScheduleKey(usuario), null);
  };

  window.firebaseSyncNow = syncNow;
  window.firebaseRetryPermissions = function () {
    permissionBlocked = false;
    scheduleSync();
  };
  window.firebaseSyncDebug = async function () {
    const info = {
      rol: currentRole(),
      puedeEscribirAdmin: canWriteKey("alumnos"),
      puedeEscribirDocente: canWriteKey("asistencias"),
      online: navigator.onLine,
      cola: readQueue(),
      paquetes: readPackageMeta(),
      pendienteLocal: rawGetItem(LOCAL_DIRTY_KEY),
      ultimoSync: rawGetItem(LAST_SYNC_KEY),
      modoTrabajo: parseJSON(rawGetItem("__firebaseWorkMode"), null),
      estado: parseJSON(rawGetItem(STATUS_KEY), null),
      ultimoError: parseJSON(rawGetItem(LAST_ERROR_KEY), null)
    };

    if (baseRef && navigator.onLine && !isViewerRole()) {
      try {
        await baseRef.child("diagnostico").child(rtdbKey(currentRole() || "sin_rol")).set({
          rol: currentRole(),
          at: firebase.database.ServerValue.TIMESTAMP
        });
        info.pruebaDatabase = "ok";
      } catch (error) {
        setLastError(error, "prueba diagnostico");
        info.pruebaDatabase = `${error.code || ""} ${error.message || error}`;
      }
    }

    console.table(info);
    return info;
  };
  window.firebaseQueueBackup = function () {
    if (isViewerRole()) return;
    syncNow();
  };

  window.cerrarSesionFirebase = async function () {
    const authEmail = sessionStorage.getItem("adminAuthEmail");
    sessionStorage.clear();
    try {
      if (authEmail && window.firebase?.auth) {
        if (!firebase.apps.length && window.firebaseConfig?.apiKey) firebase.initializeApp(window.firebaseConfig);
        await firebase.auth().signOut();
      }
    } catch (error) {
      console.info("No se pudo cerrar Firebase Auth:", error.message);
    }
    window.location.href = "index.html";
  };

  window.firebaseSetLocalOnly = function (key, value) {
    rawSetItem(key, String(value));
  };

  window.firebaseLoadAttendanceDay = async function ({ fecha, curso }) {
    const course = normalizeCourseName(curso || "general");
    const courseLabel = String(curso || course).trim();
    if (!fecha || !course || !navigator.onLine) return false;
    if (!baseRef && !(await initFirebase())) return false;

    const snapshot = await baseRef
      .child(rtdbKey("asistencias_alumno"))
      .orderByChild("fecha")
      .equalTo(fecha)
      .once("value");
    const data = snapshot.val() || {};
    const current = parseJSON(rawGetItem("asistencias"), {});
    let changed = false;

    Object.values(data).forEach(row => {
      if (!row || normalizeCourseName(row.course) !== course) return;
      const student = String(row.alumno || "").trim();
      if (!student) return;
      const remoteValue = row.value || row.estado || "blanco";
      const keys = [
        row.entryKey,
        [row.fecha, course, student].join("|"),
        [row.fecha, courseLabel, student].join("|")
      ].filter(Boolean);

      [...new Set(keys)].forEach(entryKey => {
        if (!current[entryKey] || current[entryKey] === "blanco") {
          current[entryKey] = remoteValue;
          changed = true;
        }
      });
    });

    if (changed) rawSetItem("asistencias", stringify(current));
    return true;
  };

  window.firebaseSaveAttendanceDay = async function ({ fecha, curso, alumnos, asistencias, trimestre }) {
    const course = normalizeCourseName(curso || "general");
    if (!fecha || !course || !Array.isArray(alumnos) || !alumnos.length) return false;
    if (!canWriteKey("asistencias")) return false;
    if (!navigator.onLine) {
      notifyWriteBlocked("internet");
      return false;
    }
    if (!baseRef && !(await initFirebase())) return false;

    const updatedAt = Date.now();
    const updates = {};
    alumnos.forEach(nombre => {
      const alumno = String(nombre || "").trim();
      if (!alumno) return;
      const entryKey = [fecha, course, alumno].join("|");
      const estado = asistencias?.[entryKey] || "blanco";
      const id = slug(entryKey);
      updates[
        [rtdbKey("asistencias_alumno"), rtdbKey(id)].join("/")
      ] = {
        key: "asistencias",
        entryKey,
        fecha,
        course,
        alumno,
        value: estado,
        operation: "set",
        updatedAt,
        deviceId: deviceId(),
        role: currentRole(),
        serverUpdatedAt: firebase.database.ServerValue.TIMESTAMP
      };
    });

    if (trimestre) {
      const trimestres = parseJSON(rawGetItem("trimestresAsistencia"), {});
      trimestres[fecha] = trimestre;
      updates[[rtdbKey("trimestres_asistencia"), rtdbKey("general")].join("/")] = {
        key: "trimestresAsistencia",
        course: "general",
        value: stringify(trimestres),
        operation: "set",
        updatedAt,
        deviceId: deviceId(),
        role: currentRole(),
        serverUpdatedAt: firebase.database.ServerValue.TIMESTAMP
      };
    }

    await baseRef.update(updates);
    setPackageMeta("asistencias", updatedAt, "synced");
    if (trimestre) setPackageMeta("trimestresAsistencia", updatedAt, "synced");
    await writeDirectorStatsForKey("asistencias", updatedAt).catch(error => setLastError(error, "actualizando estadisticas asistencia"));
    rawSetItem(LAST_SYNC_KEY, String(Date.now()));
    setStatus("guardado-database");
    setWorkMode("docente-online");
    return true;
  };

  window.firebaseSaveAttendanceStudent = async function ({ fecha, curso, alumno, estado, trimestre }) {
    const course = normalizeCourseName(curso || "general");
    const student = String(alumno || "").trim();
    const state = estado || "blanco";
    if (!fecha || !course || !student) return false;
    if (!canWriteKey("asistencias")) return false;
    if (!navigator.onLine) {
      notifyWriteBlocked("internet");
      return false;
    }
    if (!baseRef && !(await initFirebase())) return false;

    const updatedAt = Date.now();
    const entryKey = [fecha, course, student].join("|");
    const updates = {};
    updates[[rtdbKey("asistencias_alumno"), rtdbKey(slug(entryKey))].join("/")] = {
      key: "asistencias",
      entryKey,
      fecha,
      course,
      alumno: student,
      value: state,
      operation: "set",
      updatedAt,
      deviceId: deviceId(),
      role: currentRole(),
      serverUpdatedAt: firebase.database.ServerValue.TIMESTAMP
    };

    if (trimestre) {
      const trimestres = parseJSON(rawGetItem("trimestresAsistencia"), {});
      trimestres[fecha] = trimestre;
      updates[[rtdbKey("trimestres_asistencia"), rtdbKey("general")].join("/")] = {
        key: "trimestresAsistencia",
        course: "general",
        value: stringify(trimestres),
        operation: "set",
        updatedAt,
        deviceId: deviceId(),
        role: currentRole(),
        serverUpdatedAt: firebase.database.ServerValue.TIMESTAMP
      };
    }

    await baseRef.update(updates);
    setPackageMeta("asistencias", updatedAt, "synced");
    if (trimestre) setPackageMeta("trimestresAsistencia", updatedAt, "synced");
    await writeDirectorStatsForKey("asistencias", updatedAt).catch(error => setLastError(error, "actualizando estadisticas asistencia alumno"));
    rawSetItem(LAST_SYNC_KEY, String(Date.now()));
    setStatus("guardado-database");
    setWorkMode("docente-online");
    return true;
  };

  window.firebaseMarkPackage = function (key) {
    const normalized = canonicalKey(key);
    if (!shouldSync(normalized) || !canWriteKey(normalized)) return Promise.resolve(false);
    const updatedAt = Date.now();
    return writeOnlineChange({
      key: normalized,
      value: rawGetItem(normalized),
      operation: rawGetItem(normalized) === null ? "remove" : "set",
      updatedAt
    });
  };

  window.firebaseForgetActivity = async function (activity) {
    if (!activity || !canWriteKey("actividades")) return false;
    if (!navigator.onLine) {
      notifyWriteBlocked("internet");
      return false;
    }
    if (!baseRef && !(await initFirebase())) return false;
    const normalized = { ...activity, curso: normalizeCourseName(activity.curso || "general") };
    const id = activityDocId(normalized);
    const scopeId = activityScopeId(normalized);
    const current = parseJSON(rawGetItem("actividades"), []);
    const activeIds = Array.isArray(current)
      ? current
          .filter(item => activityScopeId(item) === scopeId)
          .map(activityDocId)
      : [];
    const updatedAt = Date.now();
    await baseRef.child("actividades_detalle").child(rtdbKey(id)).remove();
    await baseRef.child("actividades_index").child(rtdbKey(scopeId)).set({
      key: "actividades",
      scopeId,
      course: normalized.curso,
      materia: normalized.materia || "",
      activeIds: [...new Set(activeIds)],
      operation: "set",
      updatedAt,
      deviceId: deviceId(),
      role: currentRole(),
      serverUpdatedAt: firebase.database.ServerValue.TIMESTAMP
    });
    setPackageMeta("actividades", updatedAt, "synced");
    return true;
  };

  window.firebaseForgetNote = async function (courseRaw, trimestre, materia, titulo) {
    if (!canWriteKey("notas")) return false;
    if (!navigator.onLine) {
      notifyWriteBlocked("internet");
      return false;
    }
    if (!baseRef && !(await initFirebase())) return false;
    const course = normalizeCourseName(courseRaw || "general");
    const id = noteDocId(course, trimestre, materia, titulo);
    const scopeId = noteScopeId(course, trimestre, materia);
    const current = parseJSON(rawGetItem("notas"), {});
    const materiaNotas = current?.[course]?.[trimestre]?.[materia] || {};
    const activeIds = Object.keys(materiaNotas).map(title => noteDocId(course, trimestre, materia, title));
    const updatedAt = Date.now();
    await baseRef.child("notas_detalle").child(rtdbKey(id)).remove();
    await baseRef.child("notas_index").child(rtdbKey(scopeId)).set({
      key: "notas",
      scopeId,
      course,
      trimestre,
      materia,
      activeIds: [...new Set(activeIds)],
      operation: "set",
      updatedAt,
      deviceId: deviceId(),
      role: currentRole(),
      serverUpdatedAt: firebase.database.ServerValue.TIMESTAMP
    });
    setPackageMeta("notas", updatedAt, "synced");
    return true;
  };

  window.firebaseAfterLogin = async function () {
    try {
      if (!baseRef && !(await initFirebase())) return false;
      booting = false;
      normalizeCourseStorage(!isViewerRole());

      if (isViewerRole()) {
        await pullRemoteOnStart();
        return true;
      }

      await pullRemoteOnStart();
      scheduleSync();
      return true;
    } catch (error) {
      setLastError(error, "login firebase");
      return false;
    }
  };

  window.firebaseRebuildDirectorStats = async function () {
    try {
      if (isViewerRole()) return false;
      if (!baseRef && !(await initFirebase())) return false;
      const courses = statsCourseNames();
      if (!courses.length) return false;
      await Promise.all(courses.map(course => {
        const value = statsBuildCourse(course);
        return baseRef.child(DIRECTOR_STATS_COLLECTION).child(rtdbKey(slug(course))).set({
          key: DIRECTOR_STATS_KEY,
          course,
          value: stringify(value),
          operation: "set",
          updatedAt: Date.now(),
          deviceId: deviceId(),
          role: currentRole(),
          serverUpdatedAt: firebase.database.ServerValue.TIMESTAMP
        });
      }));
      return true;
    } catch (error) {
      setLastError(error, "regenerando estadisticas director");
      return false;
    }
  };

  async function syncWhenAppIsActive(context) {
    try {
      if (document.hidden || !navigator.onLine) return;
      if (!baseRef && !(await initFirebase())) return;
      const role = currentRole();

      if (!role) {
        if (isLoginPage()) await pullRemoteOnStart();
        return;
      }

      if (isViewerRole()) {
        await pullRemoteOnStart();
        return;
      }

      await syncNow();
      await pullRemoteOnStart();
      scheduleSync();
    } catch (error) {
      setLastError(error, context);
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      if (!(await initFirebase())) return;
      booting = false;
      const role = currentRole();
      if (!role) {
        if (isLoginPage()) await pullRemoteOnStart();
        return;
      }
      normalizeCourseStorage(Boolean(role) && !isViewerRole());

      if (role && !isViewerRole()) {
        await syncNow();
      }
      await pullRemoteOnStart();
      if (role && !isViewerRole()) {
        await syncNow();
      }
      scheduleSync();
    } catch (error) {
      setLastError(error, "inicio firebase");
    } finally {
      booting = false;
    }
  });

  window.addEventListener("online", () => syncWhenAppIsActive("conexion restaurada"));

  window.addEventListener("pageshow", () => syncWhenAppIsActive("aplicacion abierta"));

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncWhenAppIsActive("aplicacion visible");
  });

  window.addEventListener("offline", () => {
    setWorkMode("sin-internet-online");
    setStatus("sin-internet-no-guardado");
  });
})();
