// Modulo extraido de firebase-sync.js. Mantiene la misma logica, pero aislada por area.
(function () {
  "use strict";

  window.FirebaseSchoolSyncAttendance = {
    create(context) {
      const { parseJSON, normalizeCourseName, slug, stringify } = context;

    function recordsForAttendance(value, updatedAt) {
      const parsed = parseJSON(value, {});
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      return Object.entries(parsed).map(([entryKey, estado]) => {
        const parts = String(entryKey).split("|");
        const fecha = parts[0] || "";
        const course = normalizeCourseName(parts[1] || "general");
        const alumno = parts.slice(2).join("|");
        return {
          collection: "asistencias_alumno",
          id: slug([fecha, course, alumno].join("|")),
          data: {
            key: "asistencias",
            entryKey: [fecha, course, alumno].join("|"),
            fecha,
            course,
            alumno,
            value: estado,
            operation: "set",
            updatedAt
          }
        };
      });
    }

      return {
        recordsForAttendance
      };
    }
  };
})();
