// Storage general: claves sincronizables, colecciones y agrupacion por curso.
(function () {
  "use strict";

  window.FirebaseSchoolSyncStorage = {
    create(context) {
      const { canonicalKey, parseJSON, normalizeCourseName, stringify, rawGetItem, DEFAULT_COURSES, META_KEYS, SINGLE_KEYS, COURSE_OBJECT_KEYS, COURSE_ENTRY_KEYS, COURSE_STORAGE_PREFIXES } = context;

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

      function collectionNameForKey(key) {
        const normalized = canonicalKey(key);
        if (SINGLE_KEYS[normalized]) return SINGLE_KEYS[normalized].collection;
        if (COURSE_OBJECT_KEYS[normalized]) return COURSE_OBJECT_KEYS[normalized];
        if (COURSE_ENTRY_KEYS[normalized]) return COURSE_ENTRY_KEYS[normalized];
        const courseKey = storageCourseKey(normalized);
        return courseKey ? courseKey.collection : null;
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

      return {
        storageCourseKey,
        shouldSync,
        collectionNameForKey,
        knownCourses,
        groupObjectByCourse,
        groupEntriesByCourse
      };
    }
  };
})();
