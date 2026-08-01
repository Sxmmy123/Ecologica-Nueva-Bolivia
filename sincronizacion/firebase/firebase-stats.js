// Modulo extraido de firebase-sync.js. Mantiene la misma logica, pero aislada por area.
(function () {
  "use strict";

  window.FirebaseSchoolSyncStats = {
    create(context) {
      const { parseJSON, rawGetItem, normalizeCourseName, canonicalKey, stringify, slug, rtdbKey, deviceId, currentRole, isViewerRole, parseStoredValue, timestampToMillis, getBaseRef, getFirebase, DIRECTOR_STATS_KEY, DIRECTOR_STATS_COLLECTION, DIRECTOR_STATS_SOURCE_KEYS } = context;

    function readLocalJSON(key, fallback) {
      return parseJSON(rawGetItem(key), fallback);
    }

    function statsCourseNames() {
      const cursos = readLocalJSON("cursos", []);
      const alumnos = readLocalJSON("alumnos", {});
      return [...new Set([...(Array.isArray(cursos) ? cursos : []), ...Object.keys(alumnos || {})])].map(normalizeCourseName).filter(Boolean);
    }

    function statsStudents(course) {
      const alumnos = readLocalJSON("alumnos", {});
      const list = alumnos?.[course] || [];
      if (!Array.isArray(list)) return [];
      return list.map(item => typeof item === "string" ? item : (item?.nombre || item?.nombreCompleto || "")).filter(Boolean);
    }

    function statsPeriods() {
      return ["1er Trimestre", "2do Trimestre", "3er Trimestre", "Total"];
    }

    function statsActivityInPeriod(activity, period) {
      return period === "Total" || !activity.trimestre || activity.trimestre === period;
    }

    function statsActivities(course, period) {
      const actividades = readLocalJSON("actividades", []);
      return (Array.isArray(actividades) ? actividades : [])
        .filter(item => normalizeCourseName(item?.curso) === course)
        .filter(item => item?.titulo && item?.materia)
        .filter(item => statsActivityInPeriod(item, period));
    }

    function statsNoteFor(activity, student) {
      const notas = readLocalJSON("notas", {});
      const course = normalizeCourseName(activity?.curso || "");
      const trimester = activity?.trimestre || "1er Trimestre";
      return notas?.[course]?.[trimester]?.[activity.materia]?.[activity.titulo]?.alumnos?.[student] || null;
    }

    function statsAttendanceStateKey(state) {
      const normal = String(state || "blanco").toLowerCase();
      if (normal === "verde") return "asistencia";
      if (normal === "amarillo") return "atrasos";
      if (normal === "morado") return "licencias";
      if (normal === "blanco" || normal === "f" || normal === "falta" || normal === "rojo") return "faltas";
      return null;
    }

    function statsAttendanceInPeriod(date, period) {
      if (period === "Total") return true;
      const trimestres = readLocalJSON("trimestresAsistencia", {});
      return (trimestres || {})[date] === period;
    }

    function statsBuildCourse(courseRaw) {
      const course = normalizeCourseName(courseRaw);
      const students = statsStudents(course);
      const asistenciaRaw = readLocalJSON("asistencias", {});
      const corteAlta = Math.max(1, Math.min(100, Math.round(Number(rawGetItem("notaCorteAlta") || 55))));
      const periodos = {};

      statsPeriods().forEach(period => {
        const activities = statsActivities(course, period);
        const alumnosDetalle = students.map(student => {
          const presentadas = [];
          const faltantes = [];
          activities.forEach(activity => {
            const note = statsNoteFor(activity, student);
            if (note) presentadas.push({ materia: activity.materia, titulo: activity.titulo, nota100: Number(note.nota100 ?? note.nota ?? note) || 0 });
            else faltantes.push({ materia: activity.materia, titulo: activity.titulo });
          });
          return { alumno: student, total: activities.length, presentadas, faltantes, porcentaje: activities.length ? Math.round((presentadas.length * 100) / activities.length) : 0 };
        });
        const total = alumnosDetalle.reduce((acc, item) => acc + item.total, 0);
        const presentadas = alumnosDetalle.reduce((acc, item) => acc + item.presentadas.length, 0);
        const faltantes = alumnosDetalle.reduce((acc, item) => acc + item.faltantes.length, 0);
        const notas = alumnosDetalle.flatMap(item => item.presentadas.map(p => Number(p.nota100))).filter(Number.isFinite);
        const notasAltas = notas.filter(n => n >= corteAlta).length;

        const materias = {};
        alumnosDetalle.forEach(item => item.presentadas.forEach(p => {
          const materia = p.materia || "Sin materia";
          if (!materias[materia]) materias[materia] = { curso, materia, total: 0, altas: 0, bajas: 0, notas: [] };
          materias[materia].total++;
          materias[materia].notas.push(p.nota100);
          if (p.nota100 >= corteAlta) materias[materia].altas++;
          else materias[materia].bajas++;
        }));
        const materiasResumen = Object.values(materias).map(item => {
          const altasPct = item.total ? Math.round((item.altas * 100) / item.total) : 0;
          return {
            curso,
            materia: item.materia,
            total: item.total,
            altas: item.altas,
            bajas: item.bajas,
            altasPct,
            bajasPct: item.total ? 100 - altasPct : 0,
            promedio: item.notas.length ? Math.round(item.notas.reduce((a, n) => a + n, 0) / item.notas.length) : 0
          };
        });

        const fechas = {};
        Object.entries(asistenciaRaw || {}).forEach(([key, state]) => {
          const parts = String(key).split("|");
          if (parts.length < 3) return;
          const date = parts[0];
          const itemCourse = normalizeCourseName(parts[1]);
          if (itemCourse !== course || !statsAttendanceInPeriod(date, period)) return;
          fechas[date] = true;
        });
        const asistencia = { asistencia: 0, atrasos: 0, licencias: 0, faltas: 0, total: 0 };
        Object.keys(fechas).forEach(date => {
          students.forEach(student => {
            const state = asistenciaRaw?.[`${date}|${course}|${student}`] || "blanco";
            const stateKey = statsAttendanceStateKey(state);
            if (!stateKey) return;
            asistencia[stateKey]++;
            asistencia.total++;
          });
        });

        periodos[period] = {
          academico: {
            curso: course,
            total,
            presentadas,
            faltantes,
            porcentaje: total ? Math.round((presentadas * 100) / total) : 0,
            notasAltas,
            notasCalificadas: notas.length,
            porcentajeNotasAltas: notas.length ? Math.round((notasAltas * 100) / notas.length) : 0,
            promedioNotas: notas.length ? Math.round(notas.reduce((a, n) => a + n, 0) / notas.length) : 0
          },
          materias: materiasResumen,
          asistencia
        };
      });

      return { course, corteAlta, periodos, generatedAt: Date.now() };
    }

    function statsCoursesForKey(key) {
      const normalized = canonicalKey(key);
      if (normalized === "alumnos" || normalized === "notas") return Object.keys(readLocalJSON(normalized, {}) || {}).map(normalizeCourseName).filter(Boolean);
      if (normalized === "actividades") return [...new Set((readLocalJSON("actividades", []) || []).map(item => normalizeCourseName(item?.curso)).filter(Boolean))];
      if (normalized === "asistencias") return [...new Set(Object.keys(readLocalJSON("asistencias", {}) || {}).map(item => normalizeCourseName(String(item).split("|")[1] || "")).filter(Boolean))];
      if (normalized === "trimestresAsistencia") return statsCourseNames();
      return [];
    }

    async function writeDirectorStatsForKey(sourceKey, updatedAt = Date.now()) {
      if (!getBaseRef() || isViewerRole() || !DIRECTOR_STATS_SOURCE_KEYS.has(canonicalKey(sourceKey))) return false;
      const courses = statsCoursesForKey(sourceKey);
      if (!courses.length) return false;
      await Promise.all(courses.map(course => {
        const value = statsBuildCourse(course);
        return getBaseRef().child(DIRECTOR_STATS_COLLECTION).child(rtdbKey(slug(course))).set({
          key: DIRECTOR_STATS_KEY,
          course,
          value: stringify(value),
          operation: "set",
          updatedAt,
          deviceId: deviceId(),
          role: currentRole(),
          serverUpdatedAt: getFirebase().database.ServerValue.TIMESTAMP
        });
      }));
      return true;
    }

    async function pullDirectorStats(next) {
      const snapshot = await getBaseRef().child(DIRECTOR_STATS_COLLECTION).once("value");
      const data = snapshot.val() || {};
      const cursos = {};
      let updatedAt = 0;
      Object.values(data).forEach(row => {
        if (!row || typeof row !== "object") return;
        const course = normalizeCourseName(row.course || "");
        if (!course) return;
        cursos[course] = parseStoredValue(row.value, {});
        updatedAt = Math.max(updatedAt, timestampToMillis(row.updatedAt), timestampToMillis(row.serverUpdatedAt));
      });
      if (Object.keys(cursos).length) next[DIRECTOR_STATS_KEY] = { value: stringify({ cursos, updatedAt }), updatedAt };
    }

      return {
        readLocalJSON,
        statsCourseNames,
        statsBuildCourse,
        statsCoursesForKey,
        writeDirectorStatsForKey,
        pullDirectorStats
      };
    }
  };
})();
