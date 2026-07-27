(function () {
  "use strict";

  const APP_ID = window.APP_SYNC_ID || "apk-asistencia-colegio";
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
  const ONLINE_ONLY_VERSION = "online-v1";
  const STRUCTURE_VERSION = "3";
  const RETRY_SYNC_DELAY = 30000;

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
    alumnosCI: "alumnos_ci",
    alumnosEstado: "alumnos_estado",
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

  function currentRole() {
    return sessionStorage.getItem("sesionRol") || "";
  }

  function isViewerRole() {
    return currentRole() === "director" || currentRole() === "alumno";
  }

  function isAdminRole() {
    return currentRole() === "admin";
  }

  function isTeacherRole() {
    return currentRole() === "docente";
  }

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

  function parseJSON(raw, fallback) {
    try { return JSON.parse(raw ?? ""); }
    catch (error) { return fallback; }
  }

  function stringify(value) {
    return JSON.stringify(value ?? null);
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
      setStatus("sin-permisos-firestore");
    }
    console.error("Firebase sync error", context, code, message);
  }

  function storageCourseKey(key) {
    const normalized = canonicalKey(key);
    const spec = COURSE_STORAGE_PREFIXES.find(item => normalized.startsWith(item.prefix));
    if (!spec) return null;
    return {
      collection: spec.collection,
      localKey: normalized,
      course: normalized.slice(spec.prefix.length)
    };
  }

  function shouldSync(key) {
    const normalized = canonicalKey(key);
    if (!normalized || META_KEYS.has(normalized)) return false;
    return Boolean(
      SINGLE_KEYS[normalized] ||
      COURSE_OBJECT_KEYS[normalized] ||
      COURSE_ENTRY_KEYS[normalized] ||
      normalized === "actividades" ||
      storageCourseKey(normalized)
    );
  }

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

  function adminOwnsKey(key) {
    const normalized = canonicalKey(key);
    return Boolean(
      ["cursos", "alumnos", "alumnosCI", "alumnosEstado", "cursoColores", "director", "docentes", "horasPrimaria"].includes(normalized) ||
      storageCourseKey(normalized)
    );
  }

  function teacherOwnsKey(key) {
    const normalized = canonicalKey(key);
    return TEACHER_SYNC_KEYS.includes(normalized);
  }

  function canWriteKey(key) {
    if (isViewerRole()) return false;
    if (isAdminRole()) return adminOwnsKey(key);
    if (isTeacherRole()) return teacherOwnsKey(key);
    return false;
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
    setWorkMode(reason === "permisos" ? "sin-permisos-firestore" : "sin-internet-online");
    setStatus(reason === "permisos" ? "sin-permisos-firestore" : "sin-internet-no-guardado");
    window.dispatchEvent(new CustomEvent("firebaseWriteBlocked", { detail: { reason, message } }));
    const now = Date.now();
    if (now - lastInternetRequiredAlertAt > 2500) {
      lastInternetRequiredAlertAt = now;
      setTimeout(() => alert(message), 0);
    }
  }

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

  function collectionNameForKey(key) {
    const normalized = canonicalKey(key);
    if (SINGLE_KEYS[normalized]) return SINGLE_KEYS[normalized].collection;
    if (COURSE_OBJECT_KEYS[normalized]) return COURSE_OBJECT_KEYS[normalized];
    if (COURSE_ENTRY_KEYS[normalized]) return COURSE_ENTRY_KEYS[normalized];
    const courseKey = storageCourseKey(normalized);
    return courseKey ? courseKey.collection : null;
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

  function groupObjectByCourse(rawValue) {
    const parsed = parseJSON(rawValue, {});
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed).map(([course, value]) => ({ course, value }));
  }

  function knownCourses() {
    const set = new Set(DEFAULT_COURSES);
    const courses = parseJSON(rawGetItem("cursos"), []);
    if (Array.isArray(courses)) courses.forEach(course => course && set.add(normalizeCourseName(course)));

    const alumnos = parseJSON(rawGetItem("alumnos"), {});
    if (alumnos && typeof alumnos === "object" && !Array.isArray(alumnos)) {
      Object.keys(alumnos).forEach(course => course && set.add(normalizeCourseName(course)));
    }

    const activities = parseJSON(rawGetItem("actividades"), []);
    if (Array.isArray(activities)) {
      activities.forEach(activity => activity?.curso && set.add(normalizeCourseName(activity.curso)));
    }

    const docentes = parseJSON(rawGetItem("docentes"), []);
    if (Array.isArray(docentes)) {
      docentes.forEach(docente => {
        if (docente?.curso) set.add(normalizeCourseName(docente.curso));
        if (Array.isArray(docente?.asignaciones)) {
          docente.asignaciones.forEach(asig => asig?.curso && set.add(normalizeCourseName(asig.curso)));
        }
      });
    }

    return [...set].filter(Boolean);
  }

  function groupEntriesByCourse(rawValue) {
    const parsed = parseJSON(rawValue, {});
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const groups = {};
    Object.entries(parsed).forEach(([entryKey, value]) => {
      const course = courseFromEntryKey(entryKey);
      if (!groups[course]) groups[course] = {};
      groups[course][entryKey] = value;
    });
    return Object.entries(groups).map(([course, value]) => ({ course, value }));
  }

  function groupActivities(rawValue) {
    const parsed = parseJSON(rawValue, []);
    if (!Array.isArray(parsed)) return [];
    const groups = {};
    knownCourses().forEach(course => {
      groups[`hacer|${course}`] = { collection: "hacer", course, value: [] };
      groups[`saber|${course}`] = { collection: "saber", course, value: [] };
    });
    parsed.forEach(activity => {
      const collection = activity?.categoria === "Saber" || activity?.tipo === "Examen" ? "saber" : "hacer";
      const course = normalizeCourseName(activity?.curso || "general");
      const groupKey = `${collection}|${course}`;
      if (!groups[groupKey]) groups[groupKey] = { collection, course, value: [] };
      groups[groupKey].value.push({ ...activity, curso: course });
    });
    return Object.values(groups);
  }

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

    if (key === "actividades") {
      const fullRecord = {
        collection: "actividades",
        id: "todos",
        data: { key: "actividades", value, operation: "set", updatedAt }
      };
      const groupedRecords = groupActivities(value).map(group => ({
        collection: group.collection,
        id: slug(group.course),
        data: { key: "actividades", course: group.course, value: stringify(group.value), operation: "set", updatedAt }
      }));
      return [fullRecord, ...groupedRecords];
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

  async function initFirebase() {
    const cfg = window.firebaseConfig || {};
    if (!window.firebase || !window.firebase.firestore || !cfg.apiKey || !cfg.projectId || String(cfg.apiKey).startsWith("PEGA_AQUI")) {
      setStatus("configuracion-pendiente");
      return false;
    }

    if (!firebase.apps.length) firebase.initializeApp(cfg);
    db = firebase.firestore();
    // Modo 100% online: Firebase es la fuente principal y no conserva cola offline propia.
    baseRef = db.collection("asistenciaOffline").doc(APP_ID);
    legacyRef = baseRef.collection("registros");
    return true;
  }

  async function deleteCollectionDocs(collectionName) {
    const snapshot = await baseRef.collection(collectionName).get();
    if (snapshot.empty) return;
    let batch = db.batch();
    let count = 0;
    snapshot.forEach(doc => {
      batch.delete(doc.ref);
      count++;
      if (count === 450) {
        batch.commit();
        batch = db.batch();
        count = 0;
      }
    });
    if (count) await batch.commit();
  }

  async function deleteLegacyDocsForKey(key) {
    const ids = new Set([
      encodeURIComponent(key).replace(/\./g, "%2E"),
      slug(key),
      key === "alumnosCI" ? "alumnosci" : ""
    ].filter(Boolean));
    for (const id of ids) {
      try { await legacyRef.doc(id).delete(); }
      catch (error) {}
    }
  }

  async function deleteLegacyCollection() {
    const snapshot = await legacyRef.get();
    if (snapshot.empty) return;
    const batch = db.batch();
    snapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }

  async function writeItem(item) {
    const key = canonicalKey(item.key);
    if (!canWriteKey(key)) return;
    const records = recordsForItem({ ...item, key });
    let wrote = false;

    for (const record of records) {
      const docRef = baseRef.collection(record.collection).doc(record.id);
      const localUpdatedAt = Number(record.data.updatedAt || item.updatedAt || Date.now());
      const remoteDoc = await docRef.get();
      const remoteData = remoteDoc.exists ? (remoteDoc.data() || {}) : {};
      const remoteUpdatedAt = Math.max(timestampToMillis(remoteData.updatedAt), timestampToMillis(remoteData.serverUpdatedAt));
      if (remoteUpdatedAt > localUpdatedAt) continue;

      await docRef.set({
        ...record.data,
        updatedAt: localUpdatedAt,
        deviceId: deviceId(),
        role: currentRole(),
        serverUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
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
        setStatus("guardando-firestore");
        const wrote = await writeItem({ ...item, key });
        rawSetItem(STRUCTURE_KEY, STRUCTURE_VERSION);
        rawSetItem(LAST_SYNC_KEY, String(Date.now()));
        rawRemoveItem(LOCAL_DIRTY_KEY);
        writeQueue([]);
        setStatus(wrote ? "guardado-firestore" : "sin-cambios-remotos");
        return wrote;
      })
      .catch(error => {
        setLastError(error, `guardando ${key}`);
        setWorkMode("error-online");
        setStatus("error-guardado-firestore");
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
      setStatus("sin-permisos-firestore");
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
      setStatus(activeWrites.size ? "guardando-firestore" : "online");
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
    const snapshot = await baseRef.collection(collectionName).get();
    return snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() || {} }));
  }

  async function pullSingles(next) {
    for (const [key, spec] of Object.entries(SINGLE_KEYS)) {
      const doc = await baseRef.collection(spec.collection).doc(spec.doc).get();
      if (doc.exists) {
        const data = doc.data() || {};
        next[key] = {
          value: String(data.value ?? ""),
          updatedAt: Math.max(timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt))
        };
      }
    }
  }

  async function pullCourseObject(next, key, collectionName) {
    const docs = await readCollection(collectionName);
    if (!docs.length) return;
    const obj = {};
    let updatedAt = 0;
    docs.forEach(({ data, id }) => {
      const course = data.course || id;
      obj[course] = parseJSON(data.value, {});
      updatedAt = Math.max(updatedAt, timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt));
    });
    next[key] = { value: stringify(obj), updatedAt };
  }

  async function pullCourseEntries(next, key, collectionName) {
    const docs = await readCollection(collectionName);
    if (!docs.length) return;
    const obj = {};
    let updatedAt = 0;
    docs.forEach(({ data }) => {
      Object.assign(obj, parseJSON(data.value, {}));
      updatedAt = Math.max(updatedAt, timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt));
    });
    next[key] = { value: stringify(obj), updatedAt };
  }

  async function pullActivities(next) {
    const full = await baseRef.collection("actividades").doc("todos").get();
    if (full.exists) {
      const data = full.data() || {};
      next.actividades = {
        value: String(data.value ?? "[]"),
        updatedAt: Math.max(timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt))
      };
      return;
    }

    const hacer = await readCollection("hacer");
    const saber = await readCollection("saber");
    const activities = [];
    let updatedAt = 0;
    [...hacer, ...saber].forEach(({ data }) => {
      const list = parseJSON(data.value, []);
      if (Array.isArray(list)) activities.push(...list);
      updatedAt = Math.max(updatedAt, timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt));
    });
    if (hacer.length || saber.length) next.actividades = { value: stringify(activities), updatedAt };
  }

  async function pullStorageCourse(next, prefix, collectionName) {
    const docs = await readCollection(collectionName);
    docs.forEach(({ data, id }) => {
      const course = data.course || id;
      next[`${prefix}${course}`] = {
        value: String(data.value ?? ""),
        updatedAt: Math.max(timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt))
      };
    });
  }

  function applyLegacyRecord(data, force) {
    const key = canonicalKey(data.key || "");
    if (!key || !shouldSync(key)) return false;
    const value = data.operation === "remove" ? null : String(data.value ?? "");

    if (data.scope === "course") return applyCoursePiece(key, data.course || "general", parseJSON(value, {}), "object", force);
    if (data.scope === "course-list") return applyCoursePiece(key, data.course || "general", parseJSON(value, []), "list", force);
    if (data.scope === "course-entries") return applyCoursePiece(key, data.course || "general", parseJSON(value, {}), "entries", force);
    return applyLocalValue(key, value, force, Math.max(timestampToMillis(data.updatedAt), timestampToMillis(data.serverUpdatedAt)));
  }

  async function pullLegacy(force) {
    const snapshot = await legacyRef.get();
    let changed = false;
    snapshot.forEach(doc => {
      const data = doc.data() || {};
      if (!data.key) data.key = canonicalKey(decodeURIComponent(doc.id));
      if (applyLegacyRecord(data, force)) changed = true;
    });
    return changed;
  }

  async function pullStructured(force) {
    const next = {};
    await pullSingles(next);
    for (const [key, collection] of Object.entries(COURSE_OBJECT_KEYS)) await pullCourseObject(next, key, collection);
    for (const [key, collection] of Object.entries(COURSE_ENTRY_KEYS)) await pullCourseEntries(next, key, collection);
    await pullActivities(next);
    for (const spec of COURSE_STORAGE_PREFIXES) await pullStorageCourse(next, spec.prefix, spec.collection);

    let changed = false;
    Object.entries(next).forEach(([key, record]) => {
      const value = record && typeof record === "object" && Object.prototype.hasOwnProperty.call(record, "value") ? record.value : record;
      const updatedAt = record && typeof record === "object" ? Number(record.updatedAt || 0) : 0;
      if (applyLocalValue(key, value, force, updatedAt)) changed = true;
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
      const legacyChanged = await pullLegacy(force);
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
      setLastError(error, "descargando firestore");
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
      setStatus("sin-permisos-firestore");
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
        await baseRef.collection("diagnostico").doc(currentRole() || "sin_rol").set({
          rol: currentRole(),
          at: firebase.firestore.FieldValue.serverTimestamp()
        });
        info.pruebaFirestore = "ok";
      } catch (error) {
        setLastError(error, "prueba diagnostico");
        info.pruebaFirestore = `${error.code || ""} ${error.message || error}`;
      }
    }

    console.table(info);
    return info;
  };
  window.firebaseQueueBackup = function () {
    if (isViewerRole()) return;
    syncNow();
  };

  window.firebaseMarkPackage = function (key) {
    const normalized = canonicalKey(key);
    if (!shouldSync(normalized) || !canWriteKey(normalized)) return false;
    const updatedAt = Date.now();
    writeOnlineChange({
      key: normalized,
      value: rawGetItem(normalized),
      operation: rawGetItem(normalized) === null ? "remove" : "set",
      updatedAt
    });
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

  async function syncWhenAppIsActive(context) {
    try {
      if (document.hidden || !navigator.onLine) return;
      if (!baseRef && !(await initFirebase())) return;
      const role = currentRole();

      if (!role) {
        await pullRemoteOnStart();
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
