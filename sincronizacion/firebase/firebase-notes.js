// Modulo extraido de firebase-sync.js. Mantiene la misma logica, pero aislada por area.
(function () {
  "use strict";

  window.FirebaseSchoolSyncNotes = {
    create(context) {
      const { parseJSON, knownCourses, normalizeCourseName, slug, stringify } = context;

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

    function activityDocId(activity) {
      return slug([
        normalizeCourseName(activity?.curso || "general"),
        activity?.materia || "sin_materia",
        activity?.trimestre || "sin_trimestre",
        activity?.fecha || "sin_fecha",
        activity?.tipo || "actividad",
        activity?.titulo || "sin_titulo"
      ].join("|"));
    }

    function activityScopeId(activity) {
      return slug([
        normalizeCourseName(activity?.curso || "general"),
        activity?.materia || "sin_materia"
      ].join("|"));
    }

    function recordsForActivities(value, updatedAt) {
      const parsed = parseJSON(value, []);
      if (!Array.isArray(parsed)) return [];
      const scopes = {};
      const records = parsed.map(activity => {
        const course = normalizeCourseName(activity?.curso || "general");
        const normalized = { ...activity, curso: course };
        const id = activityDocId(normalized);
        const scopeId = activityScopeId(normalized);
        if (!scopes[scopeId]) scopes[scopeId] = { course, materia: normalized.materia || "", ids: [] };
        scopes[scopeId].ids.push(id);
        return {
          collection: "actividades_detalle",
          id,
          data: {
            key: "actividades",
            scopeId,
            course,
            materia: normalized.materia || "",
            value: stringify(normalized),
            operation: "set",
            updatedAt
          }
        };
      });

      const indexes = Object.entries(scopes).map(([id, scope]) => ({
        collection: "actividades_index",
        id,
        data: {
          key: "actividades",
          scopeId: id,
          course: scope.course,
          materia: scope.materia,
          activeIds: stringify([...new Set(scope.ids)]),
          operation: "set",
          updatedAt
        }
      }));

      return [...indexes, ...records];
    }

    function noteDocId(course, trimestre, materia, titulo) {
      return slug([course || "general", trimestre || "sin_trimestre", materia || "sin_materia", titulo || "sin_titulo"].join("|"));
    }

    function noteScopeId(course, trimestre, materia) {
      return slug([course || "general", trimestre || "sin_trimestre", materia || "sin_materia"].join("|"));
    }

    function recordsForNotes(value, updatedAt) {
      const parsed = parseJSON(value, {});
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      const records = [];
      const scopes = {};

      Object.entries(parsed).forEach(([courseRaw, trimestres]) => {
        const course = normalizeCourseName(courseRaw);
        if (!trimestres || typeof trimestres !== "object" || Array.isArray(trimestres)) return;
        Object.entries(trimestres).forEach(([trimestre, materias]) => {
          if (!materias || typeof materias !== "object" || Array.isArray(materias)) return;
          Object.entries(materias).forEach(([materia, actividades]) => {
            if (!actividades || typeof actividades !== "object" || Array.isArray(actividades)) return;
            const scopeId = noteScopeId(course, trimestre, materia);
            if (!scopes[scopeId]) scopes[scopeId] = { course, trimestre, materia, ids: [] };
            Object.entries(actividades).forEach(([titulo, registro]) => {
              const id = noteDocId(course, trimestre, materia, titulo);
              scopes[scopeId].ids.push(id);
              records.push({
                collection: "notas_detalle",
                id,
                data: {
                  key: "notas",
                  scopeId,
                  course,
                  trimestre,
                  materia,
                  titulo,
                  value: stringify(registro),
                  operation: "set",
                  updatedAt
                }
              });
            });
          });
        });
      });

      const indexes = Object.entries(scopes).map(([id, scope]) => ({
        collection: "notas_index",
        id,
        data: {
          key: "notas",
          scopeId: id,
          course: scope.course,
          trimestre: scope.trimestre,
          materia: scope.materia,
          activeIds: stringify([...new Set(scope.ids)]),
          operation: "set",
          updatedAt
        }
      }));

      return [...indexes, ...records];
    }

      return {
        groupActivities,
        activityDocId,
        activityScopeId,
        recordsForActivities,
        noteDocId,
        noteScopeId,
        recordsForNotes
      };
    }
  };
})();
