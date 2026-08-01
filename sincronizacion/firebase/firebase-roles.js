// Roles y permisos de escritura para la sincronizacion Firebase.
(function () {
  "use strict";

  window.FirebaseSchoolSyncRoles = {
    create(context) {
      const { sessionStorage, canonicalKey, storageCourseKey, TEACHER_SYNC_KEYS } = context;

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

      function adminOwnsKey(key) {
        const normalized = canonicalKey(key);
        return Boolean(
          ["cursos", "alumnos", "cursoColores", "director", "docentes", "horasPrimaria"].includes(normalized) ||
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

      return {
        currentRole,
        isViewerRole,
        isAdminRole,
        isTeacherRole,
        adminOwnsKey,
        teacherOwnsKey,
        canWriteKey
      };
    }
  };
})();
